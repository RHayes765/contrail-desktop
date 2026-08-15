import { shell, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  catalogKeyFor,
  dataDir,
  invokeCapability,
  log,
  readSecret,
  serverEnabled,
  type AgentSessionRecord,
  type ConnectionRecord,
  type EngineDeps,
} from '@contrail/engine';
import type {
  AgentEvent,
  BindingWithGrants,
  BridgeToolResult,
  ExternalMcpServerSpec,
  SessionContext,
  ToChild,
  ToMain,
} from '@contrail/agent-runtime';
import { resolveSessionMcp } from './mcpConfig.js';
import { refreshMcpTokenIfExpired } from './mcpOauth.js';
import {
  CHAT_MODELS,
  type ChatEvent,
  type ChatModelId,
  type EffortLevel,
  type EnvRole,
  type PushChannel,
  type PushEvents,
  type SessionView,
  type TranscriptEntryView,
  type TranscriptView,
} from '@contrail/shared';
import type { ProjectService } from './projects.js';

/**
 * AgentSessionManager: one utilityProcess per live session, bridged
 * capability execution, and THE project-silo enforcement point.
 *
 * Every capability call from the runtime lands in `executeCapability`, which
 * validates session → project → binding BEFORE anything else touches the
 * engine. The runtime child can ask for whatever it likes; a connection not
 * bound to the session's project does not exist as far as it's concerned.
 * Project identity is resolved server-side from the session — never from
 * agent-supplied arguments (project tools carry no project argument at all).
 */

const API_KEY_SERVICE = 'Contrail Desktop';
const API_KEY_ACCOUNT = 'anthropic-api-key';

export function readApiKey(): string | null {
  return readSecret(API_KEY_SERVICE, API_KEY_ACCOUNT);
}

/** Interactive chat defaults — conservative while the key runs on a small budget. */
export const CHAT_DEFAULT_MODEL: ChatModelId = 'claude-haiku-4-5';
export const CHAT_MAX_TURNS = 50;
/** Live utilityProcess cap — each holds a CLI subprocess, and budget is real money. */
const MAX_LIVE_SESSIONS = 4;
/**
 * How long to wait for the graceful 'closed' handshake before killing the
 * child. Shutdown interrupts any in-flight turn, so the query winds down in
 * seconds; the kill is strictly a hung-child last resort (it orphans the
 * SDK's CLI subprocess on Windows).
 */
const SHUTDOWN_GRACE_MS = 15_000;

/** Capabilities whose scoped answer the executor owns outright (never delegated raw). */
const EXECUTOR_OWNED = new Set(['list_connections', 'get_permissions']);

/** Project-silo tools — always executor-owned; project id comes from the session. */
const PROJECT_TOOL_HANDLERS = new Set([
  'list_project_docs',
  'read_project_doc',
  'list_project_notes',
  'add_project_note',
]);

/** Argument keys that name a target connection, per capability shape. */
const CONNECTION_ARG_KEYS = ['connection', 'connection_a', 'connection_b'] as const;

export interface SessionSpec {
  project: { id: string; name: string; description: string | null; instructions: string | null };
  bindings: Array<{ connection: ConnectionRecord; envRole: string }>;
  model: string;
  effort?: EffortLevel;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Catalog families toggled off at start (minting); the executor re-checks live. */
  disabledCatalogKeys?: string[];
  /** External MCP servers resolved for this project (per-project opt-in). */
  externalServers?: ExternalMcpServerSpec[];
  /** DB ids parallel to externalServers — revocation ends sessions by id. */
  externalServerIds?: string[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

function refuse(message: string): BridgeToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** OAuth elicitation URLs: https anywhere, http only on loopback. */
export function isSafeAuthUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') {
      return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

function okJson(payload: unknown): BridgeToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

// ── redaction (invariant 2: nothing code-bearing leaves main's memory) ───

/** Keys whose values must never reach the renderer, transcripts, or logs. */
const SENSITIVE_KEY = /code|secret|token|password/i;

/** Deep-copy with sensitive keys' values replaced. Cycles impossible: tool inputs are JSON. */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactSensitive(v);
    }
    return out;
  }
  return value;
}

/** Matches the deploy confirmation-code shape (codes.ts ALPHABET, XXXX-XXXX). */
const CONFIRMATION_CODE = /\b[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}\b/g;

/**
 * Scrub live confirmation codes out of user text. Applied to BOTH the
 * transcript AND the text forwarded to the runtime: the model (and therefore
 * the SDK's resumable history store) never possesses a code — main vaults it
 * and substitutes at execution time (see extractConfirmationCode).
 */
export function scrubCodes(text: string): string {
  return text.replace(CONFIRMATION_CODE, '[code]');
}

/** The LAST code in the message wins (a correction supersedes a typo). */
export function extractConfirmationCode(text: string): string | null {
  const matches = text.match(CONFIRMATION_CODE);
  return matches && matches.length > 0 ? (matches[matches.length - 1] ?? null) : null;
}

/** Write-execute capabilities whose confirmation_code main fills from the vault. */
const CODE_BEARING_CAPABILITIES = new Set(['execute_deploy', 'dml_execute']);

/**
 * Substitute the vaulted code into a write-execute call. The agent passes
 * "[code]" (or nothing) because it never saw the real one; the HUMAN still
 * typed it into chat this session, so the possession ritual holds — the
 * engine's claim machinery (single-use, expiry, attempt cap) is untouched.
 */
export function applyVaultedCode(
  name: string,
  args: Record<string, unknown>,
  vaulted: string | null,
): { used: boolean } {
  if (!CODE_BEARING_CAPABILITIES.has(name)) return { used: false };
  const provided = args.confirmation_code;
  const looksReal = typeof provided === 'string' && /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(provided);
  if (looksReal) return { used: false }; // defense in depth; normally impossible
  if (!vaulted) return { used: false }; // engine will refuse with its own message
  args.confirmation_code = vaulted;
  return { used: true };
}

/** Riskiest-first ordering for env-role annotation on multi-org tool calls. */
const ENV_RISK_ORDER: EnvRole[] = ['prod', 'uat', 'qa', 'other', 'dev'];

export class AgentSessionRun {
  readonly capabilityCalls: Array<{ name: string; refused: boolean }> = [];
  /** The code vault: the human's latest confirmation code, held in main only. */
  private vaultedCode: string | null = null;

  constructor(
    private readonly deps: EngineDeps,
    private readonly spec: SessionSpec,
    private readonly sessionId: string,
    private readonly silo: ProjectService,
  ) {}

  /**
   * The project's bindings AS OF RIGHT NOW. The silo gate must never enforce
   * a snapshot: unbinding an org (or deleting the project) has to apply to
   * live sessions on their very next call, so every resolution reads the DB.
   */
  private liveBindings(): Array<{ connection: ConnectionRecord; envRole: string }> {
    const out: Array<{ connection: ConnectionRecord; envRole: string }> = [];
    for (const b of this.deps.db.listProjectBindings(this.spec.project.id)) {
      const connection = this.deps.db.resolveConnection(b.connectionId);
      if (connection) out.push({ connection, envRole: b.envRole });
    }
    return out;
  }

  /** Resolve a connection reference WITHIN the project silo, against current bindings. */
  private resolveBound(ref: unknown): ConnectionRecord | null {
    if (typeof ref !== 'string' || !ref) return null;
    const conn = this.deps.db.resolveConnection(ref);
    if (!conn) return null;
    const bound = this.deps.db
      .listProjectBindings(this.spec.project.id)
      .some((b) => b.connectionId === conn.id);
    return bound ? conn : null;
  }

  /** Env-role annotation for tool cards: which bound org(s) does this call target? */
  annotateTarget(input: unknown): { connection: string | null; envRole: EnvRole | null } {
    const targets: Array<{ alias: string; envRole: EnvRole | null }> = [];
    if (input && typeof input === 'object') {
      const bindings = this.liveBindings();
      for (const key of CONNECTION_ARG_KEYS) {
        const ref = (input as Record<string, unknown>)[key];
        const bound = this.resolveBound(ref);
        if (bound) {
          const binding = bindings.find((b) => b.connection.id === bound.id);
          targets.push({ alias: bound.alias, envRole: (binding?.envRole ?? null) as EnvRole | null });
        }
      }
    }
    if (targets.length === 0) return { connection: null, envRole: null };
    // Multi-org calls (diff_orgs): show every target, color by the riskiest.
    const riskiest =
      ENV_RISK_ORDER.find((r) => targets.some((t) => t.envRole === r)) ?? targets[0]?.envRole ?? null;
    return { connection: targets.map((t) => t.alias).join(' → '), envRole: riskiest };
  }

  /** Called by the manager when the human's message carried a confirmation code. */
  provideCode(code: string): void {
    this.vaultedCode = code;
  }

  /** Whether this session resolved the given external server at start. */
  usesExternalServer(serverId: string): boolean {
    return this.spec.externalServerIds?.includes(serverId) ?? false;
  }

  async executeCapability(name: string, args: unknown): Promise<BridgeToolResult> {
    const a = (args ?? {}) as Record<string, unknown>;

    // The code vault: the model only ever saw "[code]" — the real code goes
    // in here, single-use, so it never transits the runtime or its history.
    const substitution = applyVaultedCode(name, a, this.vaultedCode);
    if (substitution.used) this.vaultedCode = null;

    // Silo rule 0: project tools answer for THIS session's project, full stop.
    // The agent cannot name a project; there is nothing to validate away.
    if (PROJECT_TOOL_HANDLERS.has(name)) {
      return this.executeProjectTool(name, a);
    }

    // Catalog toggle gate: a family toggled off for this project is refused
    // even if its tools were minted before the toggle changed. Live DB read
    // per call — same posture as bindings (minting is UX, the gate is law).
    const family = catalogKeyFor(name);
    if (family && !serverEnabled(this.deps.db.getServerToggles(this.spec.project.id), family)) {
      this.capabilityCalls.push({ name, refused: true });
      return refuse(
        `The ${family} tool family is disabled for this project. ` +
          `The user can re-enable it in the project's Capabilities panel.`,
      );
    }

    // Silo rule 1: connection-listing capabilities answer from the project's
    // bindings, never from the global connections table.
    if (EXECUTOR_OWNED.has(name)) {
      this.capabilityCalls.push({ name, refused: false });
      return this.scopedListing(name, a);
    }

    // Silo rule 2: every named target connection must be bound to this
    // project. Unbound references are refused before the engine sees them.
    for (const key of CONNECTION_ARG_KEYS) {
      if (key in a && a[key] !== undefined) {
        const bound = this.resolveBound(a[key]);
        if (!bound) {
          this.capabilityCalls.push({ name, refused: true });
          return refuse(
            `Connection "${String(a[key])}" is not part of this project. ` +
              `Available connections: ${this.liveBindings().map((b) => b.connection.alias).join(', ') || 'none'}.`,
          );
        }
        a[key] = bound.id; // canonicalize so downstream resolution cannot drift
      }
    }

    // get_audit_log without a connection filter would span every project —
    // in a session it must name a bound connection.
    if (name === 'get_audit_log' && !('connection' in a)) {
      this.capabilityCalls.push({ name, refused: true });
      return refuse('In a project session, get_audit_log requires a connection argument.');
    }

    this.capabilityCalls.push({ name, refused: false });
    // Layer-2 grant gate still runs inside the handler (assertGrant) —
    // the silo check above is in ADDITION to it, not instead of it.
    return invokeCapability(this.deps, name, a);
  }

  private executeProjectTool(name: string, a: Record<string, unknown>): BridgeToolResult {
    const projectId = this.spec.project.id; // server-side identity, always
    if (!this.deps.db.getProject(projectId)) {
      // The project was deleted out from under a live session — its silo is gone.
      this.capabilityCalls.push({ name, refused: true });
      return refuse('This project no longer exists; its documents and notes are gone.');
    }
    try {
      switch (name) {
        case 'list_project_docs': {
          this.capabilityCalls.push({ name, refused: false });
          const docs = this.silo.listDocs(projectId).map((d) => ({
            filename: d.filename,
            mime: d.mime,
            size_bytes: d.sizeBytes,
            added_at: d.addedAt,
          }));
          return okJson({ docs, count: docs.length });
        }
        case 'read_project_doc': {
          const result = this.silo.readDocText(projectId, String(a.filename ?? ''));
          this.capabilityCalls.push({ name, refused: !result.ok });
          if (!result.ok) return refuse(result.message);
          return { content: [{ type: 'text', text: result.text }] };
        }
        case 'list_project_notes': {
          this.capabilityCalls.push({ name, refused: false });
          const notes = this.silo.listNotes(projectId).map((n) => ({
            author: n.author,
            body: n.body,
            created_at: n.createdAt,
            session_id: n.sessionId,
          }));
          return okJson({ notes, count: notes.length });
        }
        case 'add_project_note': {
          const body = typeof a.body === 'string' ? a.body : '';
          const note = this.silo.addNote(projectId, body, 'agent', this.sessionId);
          this.capabilityCalls.push({ name, refused: false });
          return okJson({ saved: true, created_at: note.createdAt });
        }
        default:
          return refuse(`Unknown project tool: ${name}`);
      }
    } catch (err) {
      this.capabilityCalls.push({ name, refused: true });
      return refuse(String(err).slice(0, 500));
    }
  }

  private scopedListing(name: string, a: Record<string, unknown>): BridgeToolResult {
    const views = this.liveBindings().map((b) => ({
      alias: b.connection.alias,
      org_name: b.connection.orgName,
      org_type: b.connection.orgType,
      env_role: b.envRole,
      instance_url: b.connection.instanceUrl,
      grants: b.connection.grants,
    }));
    if (name === 'get_permissions' && typeof a.connection === 'string') {
      const bound = this.resolveBound(a.connection);
      if (!bound) {
        return refuse(`Connection "${a.connection}" is not part of this project.`);
      }
      const view = views.find((v) => v.alias === bound.alias);
      return okJson(view);
    }
    return okJson({ connections: views, count: views.length });
  }

  buildContext(
    sessionId: string,
    apiKey: string,
    claudeConfigDir: string,
    resumeSdkSessionId?: string,
  ): SessionContext {
    // STABLE per-session cwd: the SDK keys persisted history by cwd, so a
    // resumed run must come back to the same directory to find it.
    const cwd = path.join(dataDir(), 'sessions', sessionId, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const bindings: BindingWithGrants[] = this.spec.bindings.map((b) => ({
      connectionId: b.connection.id,
      alias: b.connection.alias,
      orgName: b.connection.orgName,
      orgType: b.connection.orgType,
      envRole: b.envRole as BindingWithGrants['envRole'],
      grants: b.connection.grants,
    }));
    return {
      sessionId,
      project: this.spec.project,
      bindings,
      model: this.spec.model,
      effort: this.spec.effort,
      maxTurns: this.spec.maxTurns,
      maxBudgetUsd: this.spec.maxBudgetUsd,
      cwd,
      claudeConfigDir,
      resumeSdkSessionId,
      apiKey,
      disabledCatalogKeys: this.spec.disabledCatalogKeys,
      externalServers: this.spec.externalServers,
    };
  }
}

// ── the manager ──────────────────────────────────────────────────────────

type PushFn = <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void;

/** Something alert-worthy happened while the user may not be watching. */
export interface SessionAlert {
  sessionId: string;
  projectName: string;
  kind: 'done' | 'error' | 'ended';
  /** Short human text: the reply's start, the error, or the end reason. */
  text: string;
}

type AlertFn = (alert: SessionAlert) => void;

interface LiveSession {
  sessionId: string;
  projectId: string;
  projectName: string;
  child: UtilityProcess;
  run: AgentSessionRun;
  ctx: SessionContext;
  usage: UsageTotals;
  status: 'active' | 'ending';
  sentFirstMessage: boolean;
  transcript: fs.WriteStream | null;
  lastError: string | null;
  closedWaiters: Array<() => void>;
  childClosed: boolean;
  /** True once the child confirmed init — sends queue here until then. */
  ready: boolean;
  pendingSends: string[];
}

export function sessionView(rec: AgentSessionRecord): SessionView {
  return {
    id: rec.id,
    projectId: rec.projectId,
    title: rec.title,
    status: rec.status as SessionView['status'],
    model: rec.model,
    effort: (rec.effort as SessionView['effort']) ?? null,
    inputTokens: rec.inputTokens,
    outputTokens: rec.outputTokens,
    cacheReadTokens: rec.cacheReadTokens,
    costUsd: rec.costUsd,
    createdAt: rec.createdAt,
    endedAt: rec.endedAt,
  };
}

export class AgentSessionManager {
  private readonly live = new Map<string, LiveSession>();

  /** Contrail-owned SDK config dir — session history lives here, never ~/.claude. */
  private readonly claudeConfigDir: string;

  constructor(
    private readonly deps: EngineDeps,
    private readonly silo: ProjectService,
    private readonly childPath: string,
    private readonly push: PushFn,
    /** Optional OS-alert hook — index.ts decides focus rules; headless modes omit it. */
    private readonly alert: AlertFn = () => undefined,
    /** Browser opener for OAuth URLs — headless diagnostics record instead of opening. */
    private readonly openUrl: (url: string) => void = (url) => void shell.openExternal(url),
  ) {
    // A crash or force-kill leaves rows stuck 'active'; nothing can genuinely
    // be active before this manager exists, so close them out at startup.
    const orphaned = this.deps.db.reconcileOrphanedAgentSessions();
    if (orphaned > 0) {
      log('warn', 'closed orphaned agent sessions from a previous run', { count: orphaned });
    }

    /**
     * The SDK's history store. KNOW WHAT LIVES HERE: full conversation
     * fidelity — user text (code-scrubbed by send()), assistant turns, tool
     * inputs, and COMPLETE tool results (SOQL rows, doc contents). That
     * fidelity is what makes resume work, and it never leaves this machine,
     * but it does NOT pass through the transcript redaction layer. The API
     * key is env-only and never lands here.
     *
     * Retention is OURS: settingSources [] puts the CLI in isolation mode,
     * where its own cleanupPeriodDays sweep never runs (verified against the
     * bundled binary) — so we sweep, below.
     */
    this.claudeConfigDir = path.join(dataDir(), 'claude-runtime');
    fs.mkdirSync(this.claudeConfigDir, { recursive: true });
    this.sweepRuntimeHistory();
  }

  /** Delete SDK history files past retention — old sessions just lose resumability. */
  private sweepRuntimeHistory(): void {
    const RETENTION_DAYS = 180;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const projectsDir = path.join(this.claudeConfigDir, 'projects');
    let swept = 0;
    try {
      if (!fs.existsSync(projectsDir)) return;
      for (const dir of fs.readdirSync(projectsDir)) {
        const dirPath = path.join(projectsDir, dir);
        let remaining = 0;
        for (const file of fs.readdirSync(dirPath)) {
          const filePath = path.join(dirPath, file);
          try {
            if (fs.statSync(filePath).mtimeMs < cutoff) {
              fs.rmSync(filePath, { force: true });
              swept++;
            } else {
              remaining++;
            }
          } catch {
            remaining++; // unreadable — leave it alone
          }
        }
        if (remaining === 0) {
          try {
            fs.rmdirSync(dirPath);
          } catch {
            // non-empty or locked — fine
          }
        }
      }
    } catch (err) {
      log('warn', 'runtime history sweep failed', { err: String(err) });
    }
    if (swept > 0) log('info', 'swept old runtime history', { files: swept, RETENTION_DAYS });
  }

  list(projectId: string): SessionView[] {
    return this.deps.db.listAgentSessions(projectId).map(sessionView);
  }

  /** Read-only replay of a persisted session transcript. */
  readTranscript(sessionId: string): TranscriptView {
    const rec = this.deps.db.getAgentSession(sessionId);
    if (!rec) throw new Error(`Session ${sessionId} not found.`);
    const view = sessionView(rec);
    if (!rec.transcriptPath || !fs.existsSync(rec.transcriptPath)) {
      return { session: view, entries: [], truncated: false, missing: true };
    }

    const MAX_BYTES = 5 * 1024 * 1024;
    const MAX_ENTRIES = 5000;
    let raw: string;
    try {
      const stat = fs.statSync(rec.transcriptPath);
      const fd = fs.openSync(rec.transcriptPath, 'r');
      try {
        // Very long transcripts: keep the TAIL (the recent conversation),
        // dropping the possibly-partial first line after the seek.
        const start = Math.max(0, stat.size - MAX_BYTES);
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
        fs.readSync(fd, buffer, 0, buffer.length, start);
        raw = buffer.toString('utf8');
        if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      log('warn', 'transcript unreadable', { sessionId, err: String(err) });
      return { session: view, entries: [], truncated: false, missing: true };
    }

    const entries: TranscriptEntryView[] = [];
    let truncated = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // torn line (crash mid-write) — skip, keep the rest
      }
      switch (parsed.kind) {
        case 'user':
          entries.push({ kind: 'user', text: String(parsed.text ?? '') });
          break;
        case 'assistant':
          entries.push({ kind: 'assistant', text: String(parsed.text ?? '') });
          break;
        case 'tool_start':
          entries.push({
            kind: 'tool_start',
            toolUseId: String(parsed.toolUseId ?? ''),
            name: String(parsed.name ?? ''),
            input: String(parsed.input ?? '{}'),
          });
          break;
        case 'tool_end':
          entries.push({
            kind: 'tool_end',
            toolUseId: String(parsed.toolUseId ?? ''),
            ok: parsed.ok === true,
          });
          break;
        case 'error':
          entries.push({ kind: 'error', message: String(parsed.message ?? '') });
          break;
        default:
          break; // session/usage metadata lines — the row already carries totals
      }
    }
    return { session: view, entries, truncated: truncated || raw.length >= MAX_BYTES, missing: false };
  }

  /** Live-only introspection (demo + tests). */
  inspect(sessionId: string): { usage: UsageTotals; capabilityCalls: Array<{ name: string; refused: boolean }> } | null {
    const entry = this.live.get(sessionId);
    if (!entry) return null;
    return { usage: { ...entry.usage }, capabilityCalls: [...entry.run.capabilityCalls] };
  }

  async start(projectId: string, model?: string, effort?: EffortLevel): Promise<SessionView> {
    if (this.live.size >= MAX_LIVE_SESSIONS) {
      throw new Error(
        `${this.live.size} sessions are already running — end one before starting another.`,
      );
    }
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);

    const modelId = (model ?? CHAT_DEFAULT_MODEL) as ChatModelId;
    // Own-property check: a bare index would resolve prototype keys like
    // "toString" to a truthy value and mint a session with NO budget cap.
    if (!Object.hasOwn(CHAT_MODELS, modelId)) {
      throw new Error(
        `Unknown model "${model}". Available: ${Object.keys(CHAT_MODELS).join(', ')}.`,
      );
    }
    const catalog = CHAT_MODELS[modelId];

    const apiKey = readApiKey();
    if (!apiKey) {
      throw new Error(
        'No Anthropic API key found. Add one in Settings before starting a session.',
      );
    }

    const bindings: SessionSpec['bindings'] = [];
    for (const b of this.deps.db.listProjectBindings(projectId)) {
      const connection = this.deps.db.resolveConnection(b.connectionId);
      if (connection) bindings.push({ connection, envRole: b.envRole });
    }

    // Expired external OAuth tokens refresh silently BEFORE resolution, so
    // the session starts with a live bearer instead of a stale one.
    for (const s of this.deps.db.listCustomMcpServers()) {
      if (s.enabled && s.transport !== 'stdio') await refreshMcpTokenIfExpired(s.id);
    }
    const mcp = resolveSessionMcp(this.deps, projectId);
    const spec: SessionSpec = {
      project,
      bindings,
      model: modelId,
      effort,
      maxTurns: CHAT_MAX_TURNS,
      // Budget scales with the model: a Fable turn costs what a Haiku session does.
      maxBudgetUsd: catalog.maxBudgetUsd,
      disabledCatalogKeys: mcp.disabledCatalogKeys,
      externalServers: mcp.externalServers,
      externalServerIds: mcp.externalServerIds,
    };

    const transcriptDir = path.join(dataDir(), 'sessions');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const sessionId = this.deps.db.createAgentSession({
      projectId,
      title: null,
      model: spec.model,
      effort: effort ?? null,
    });
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
    this.deps.db.setAgentSessionTranscriptPath(sessionId, transcriptPath);

    const entry = this.spawnEntry(spec, sessionId, transcriptPath, apiKey);
    this.writeTranscript(entry, {
      kind: 'session',
      sessionId,
      projectId,
      project: project.name,
      model: spec.model,
      bindings: spec.bindings.map((b) => ({ alias: b.connection.alias, envRole: b.envRole })),
    });

    this.push('sessions:changed', { projectId });
    const rec = this.deps.db.getAgentSession(sessionId);
    if (!rec) throw new Error('session row vanished during start');
    return sessionView(rec);
  }

  /**
   * Continue an ENDED session with its conversation history intact. The SDK
   * replays the persisted history (from the Contrail-owned config dir) into a
   * fresh runtime; same session row, accumulated usage, same transcript file.
   */
  async resume(sessionId: string): Promise<SessionView> {
    const existing = this.live.get(sessionId);
    if (existing) {
      // Already running — resuming a live session is just "go talk to it".
      const rec = this.deps.db.getAgentSession(sessionId);
      if (!rec) throw new Error('session row vanished');
      return sessionView(rec);
    }
    if (this.live.size >= MAX_LIVE_SESSIONS) {
      throw new Error(
        `${this.live.size} sessions are already running — end one before resuming another.`,
      );
    }
    const rec = this.deps.db.getAgentSession(sessionId);
    if (!rec) throw new Error(`Session ${sessionId} not found.`);
    const project = this.deps.db.getProject(rec.projectId);
    if (!project) throw new Error('This session\'s project no longer exists.');
    if (!rec.sdkSessionId) {
      throw new Error(
        'This session cannot be resumed — it predates resume support, so no runtime history was kept.',
      );
    }
    if (!rec.model || !Object.hasOwn(CHAT_MODELS, rec.model)) {
      throw new Error(`This session's model "${rec.model}" is no longer available.`);
    }
    const modelId = rec.model as ChatModelId;

    const apiKey = readApiKey();
    if (!apiKey) {
      throw new Error('No Anthropic API key found. Add one in Settings before resuming.');
    }

    // Bindings and grants re-resolve from TODAY's state — a resumed session
    // gets no more access than a new one would.
    const bindings: SessionSpec['bindings'] = [];
    for (const b of this.deps.db.listProjectBindings(rec.projectId)) {
      const connection = this.deps.db.resolveConnection(b.connectionId);
      if (connection) bindings.push({ connection, envRole: b.envRole });
    }

    // Toggles and external servers also re-resolve from TODAY's state.
    for (const s of this.deps.db.listCustomMcpServers()) {
      if (s.enabled && s.transport !== 'stdio') await refreshMcpTokenIfExpired(s.id);
    }
    const mcp = resolveSessionMcp(this.deps, rec.projectId);
    const spec: SessionSpec = {
      project,
      bindings,
      model: modelId,
      effort: (rec.effort as EffortLevel | null) ?? undefined,
      maxTurns: CHAT_MAX_TURNS,
      // A fresh budget for the resumed run; the row keeps the lifetime total.
      maxBudgetUsd: CHAT_MODELS[modelId].maxBudgetUsd,
      disabledCatalogKeys: mcp.disabledCatalogKeys,
      externalServers: mcp.externalServers,
      externalServerIds: mcp.externalServerIds,
    };

    const transcriptPath =
      rec.transcriptPath ?? path.join(dataDir(), 'sessions', `${sessionId}.jsonl`);
    if (!rec.transcriptPath) this.deps.db.setAgentSessionTranscriptPath(sessionId, transcriptPath);

    // Spawn FIRST — if the fork throws, the row must stay 'ended', not zombie 'active'.
    const entry = this.spawnEntry(spec, sessionId, transcriptPath, apiKey, rec.sdkSessionId);
    this.deps.db.reopenAgentSession(sessionId);
    // The row keeps LIFETIME totals — seed the accumulator so per-turn
    // updates keep adding instead of resetting history to zero.
    entry.usage = {
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      cacheReadTokens: rec.cacheReadTokens,
      costUsd: rec.costUsd,
    };
    entry.sentFirstMessage = true; // the title is already set from the first run
    this.writeTranscript(entry, { kind: 'resumed', sessionId, model: spec.model });

    this.push('sessions:changed', { projectId: rec.projectId });
    const reopened = this.deps.db.getAgentSession(sessionId);
    if (!reopened) throw new Error('session row vanished during resume');
    return sessionView(reopened);
  }

  /** Shared child wiring for start() and resume(). */
  private spawnEntry(
    spec: SessionSpec,
    sessionId: string,
    transcriptPath: string,
    apiKey: string,
    resumeSdkSessionId?: string,
  ): LiveSession {
    const run = new AgentSessionRun(this.deps, spec, sessionId, this.silo);
    const ctx = run.buildContext(sessionId, apiKey, this.claudeConfigDir, resumeSdkSessionId);
    const child = utilityProcess.fork(this.childPath, [], { stdio: 'pipe' });

    const entry: LiveSession = {
      sessionId,
      projectId: spec.project.id,
      projectName: spec.project.name,
      child,
      run,
      ctx,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      status: 'active',
      sentFirstMessage: false,
      transcript: fs.createWriteStream(transcriptPath, { flags: 'a' }),
      lastError: null,
      closedWaiters: [],
      childClosed: false,
      ready: false,
      pendingSends: [],
    };
    this.live.set(sessionId, entry);
    entry.transcript?.on('error', (err) => {
      // A transcript I/O failure must never take the session (or main) down.
      log('warn', 'session transcript write failed; disabling transcript', {
        sessionId,
        err: String(err),
      });
      entry.transcript = null;
    });

    child.on('message', (raw: ToMain) => {
      void this.onChildMessage(entry, raw);
    });
    child.on('exit', (code) => {
      entry.childClosed = true;
      for (const w of entry.closedWaiters) w();
      entry.closedWaiters = [];
      if (this.live.has(sessionId) && entry.status === 'active') {
        // The child died without being asked to — surface it, release any
        // waiting turn ('done'), mark the session dead, and close the row.
        this.forward(entry, {
          type: 'error',
          message: `The session's runtime process exited unexpectedly (code ${code}).`,
        });
        this.forward(entry, { type: 'done', result: null });
        this.push('session:event', {
          sessionId,
          event: { type: 'session_ended', reason: 'The session runtime crashed.' },
        });
        this.alert({
          sessionId,
          projectName: spec.project.name,
          kind: 'ended',
          text: 'The session runtime crashed.',
        });
        this.teardown(entry, 'error');
      }
    });
    child.once('spawn', () => {
      const init: ToChild = { kind: 'init', ctx };
      child.postMessage(init);
    });
    return entry;
  }

  send(sessionId: string, text: string): void {
    const entry = this.mustLive(sessionId);
    if (!entry.sentFirstMessage) {
      entry.sentFirstMessage = true;
      this.deps.db.setAgentSessionTitle(sessionId, text.slice(0, 80));
      this.push('sessions:changed', { projectId: entry.projectId });
    }
    // Confirmation codes never leave main: vault the code, and BOTH the
    // transcript and the runtime (whose SDK history store persists verbatim)
    // receive the scrubbed text. executeCapability substitutes at call time.
    const code = extractConfirmationCode(text);
    if (code) entry.run.provideCode(code);
    const scrubbed = scrubCodes(text);
    this.writeTranscript(entry, { kind: 'user', text: scrubbed });
    if (!entry.ready) {
      // The child hasn't confirmed init yet — a send posted now would arrive
      // before the session exists. Queue it; 'ready' flushes in order.
      entry.pendingSends.push(scrubbed);
      return;
    }
    const msg: ToChild = { kind: 'send', text: scrubbed };
    entry.child.postMessage(msg);
  }

  interrupt(sessionId: string): void {
    const entry = this.mustLive(sessionId);
    const msg: ToChild = { kind: 'interrupt' };
    entry.child.postMessage(msg);
  }

  async end(sessionId: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (!entry) return; // already gone — ending twice is fine
    entry.status = 'ending';
    try {
      // Interrupt first so an in-flight turn aborts instead of running to
      // completion past the shutdown grace (the child interrupts on shutdown
      // too — belt and suspenders, both are idempotent).
      const interrupt: ToChild = { kind: 'interrupt' };
      entry.child.postMessage(interrupt);
      const shutdown: ToChild = { kind: 'shutdown' };
      entry.child.postMessage(shutdown);
    } catch {
      // child already dead; teardown below handles it
    }
    await this.waitForChildClosed(entry, SHUTDOWN_GRACE_MS);
    this.teardown(entry, entry.lastError ? 'error' : 'ended');
  }

  /** Ends every live session of a project — call BEFORE deleting the project. */
  async endForProject(projectId: string): Promise<void> {
    const ids = [...this.live.values()]
      .filter((e) => e.projectId === projectId)
      .map((e) => e.sessionId);
    for (const id of ids) {
      this.push('session:event', {
        sessionId: id,
        event: { type: 'session_ended', reason: 'The project was deleted.' },
      });
    }
    await Promise.all(ids.map((id) => this.end(id)));
  }

  /**
   * Revocation teardown for external MCP servers: their tools run inside
   * the SDK child and never cross the per-call executor gate, so disabling
   * or removing a server can only reach live sessions by ending them.
   * Scoped to one project for a project toggle; fleet-wide otherwise.
   */
  async endForExternalServer(serverId: string, projectId?: string): Promise<void> {
    const ids = [...this.live.values()]
      .filter(
        (e) =>
          (!projectId || e.projectId === projectId) && e.run.usesExternalServer(serverId),
      )
      .map((e) => e.sessionId);
    for (const id of ids) {
      this.push('session:event', {
        sessionId: id,
        event: {
          type: 'session_ended',
          reason: 'An external MCP server this session was using was disabled. Resume to continue without it.',
        },
      });
    }
    await Promise.all(ids.map((id) => this.end(id)));
  }

  /** App-quit cleanup: close every live session, briefly but gracefully. */
  async endAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.end(id)));
  }

  // ── internals ──────────────────────────────────────────────────────────

  private mustLive(sessionId: string): LiveSession {
    const entry = this.live.get(sessionId);
    if (!entry || entry.status !== 'active') {
      throw new Error(`Session ${sessionId} is not running.`);
    }
    return entry;
  }

  private waitForChildClosed(entry: LiveSession, timeoutMs: number): Promise<void> {
    if (entry.childClosed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.child.kill();
        resolve();
      }, timeoutMs);
      entry.closedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private teardown(entry: LiveSession, status: 'ended' | 'error'): void {
    if (!this.live.has(entry.sessionId)) return;
    this.live.delete(entry.sessionId);
    this.deps.db.finishAgentSession(entry.sessionId, entry.usage, status);
    entry.child.kill();
    entry.transcript?.end();
    entry.transcript = null;
    // The cwd deliberately survives: it lives under dataDir/sessions/{id} and
    // the SDK keys resumable history by it. Session deletion (future) cleans it.
    this.push('sessions:changed', { projectId: entry.projectId });
  }

  private async onChildMessage(entry: LiveSession, raw: ToMain): Promise<void> {
    if (raw.kind === 'capability:invoke') {
      const result = await entry.run.executeCapability(raw.name, raw.args);
      const reply: ToChild = { kind: 'capability:result', id: raw.id, result };
      try {
        entry.child.postMessage(reply);
      } catch {
        // Child died mid-call; nothing to deliver to.
      }
    } else if (raw.kind === 'elicitation') {
      // External-server OAuth: the child forwards the auth URL; MAIN decides.
      // Only web URLs ever reach the browser — an MCP server that elicits a
      // file:/javascript: URL gets declined, not opened.
      const accept = isSafeAuthUrl(raw.url);
      if (accept) {
        this.openUrl(raw.url);
        this.deps.audit.record('mcp.oauth_browser_opened', {
          tool: 'agent_session',
          outcome: 'success',
          detail: { sessionId: entry.sessionId, server: raw.serverName },
        });
      } else {
        this.deps.audit.record('mcp.oauth_url_refused', {
          tool: 'agent_session',
          outcome: 'refused',
          detail: { sessionId: entry.sessionId, server: raw.serverName },
        });
      }
      this.onAgentEvent(entry, {
        type: 'external_auth',
        server: raw.serverName,
        status: accept ? 'browser_opened' : 'declined',
      });
      const reply: ToChild = { kind: 'elicitation:result', id: raw.id, accept };
      try {
        entry.child.postMessage(reply);
      } catch {
        // Child died mid-elicitation; nothing to deliver to.
      }
    } else if (raw.kind === 'event') {
      this.onAgentEvent(entry, raw.event);
    } else if (raw.kind === 'ready') {
      entry.ready = true;
      for (const text of entry.pendingSends.splice(0)) {
        const msg: ToChild = { kind: 'send', text };
        entry.child.postMessage(msg);
      }
    } else if (raw.kind === 'closed') {
      entry.childClosed = true;
      for (const w of entry.closedWaiters) w();
      entry.closedWaiters = [];
      if (entry.status === 'active' && this.live.has(entry.sessionId)) {
        // The live query ended on its own — budget/turn cap tripped or a
        // fatal SDK error. The child already emitted error+done; close the
        // session out so it cannot zombie as 'active'.
        const reason = entry.lastError ?? 'The session reached its budget or turn limit.';
        this.push('session:event', {
          sessionId: entry.sessionId,
          event: { type: 'session_ended', reason },
        });
        this.alert({
          sessionId: entry.sessionId,
          projectName: entry.projectName,
          kind: 'ended',
          text: reason.slice(0, 140),
        });
        this.teardown(entry, entry.lastError ? 'error' : 'ended');
      }
    }
  }

  private onAgentEvent(entry: LiveSession, event: AgentEvent): void {
    if (event.type === 'sdk_session') {
      // The resume handle — persisted, never forwarded (not a chat event).
      this.deps.db.setAgentSessionSdkId(entry.sessionId, event.sdkSessionId);
      return;
    }
    if (event.type === 'usage') {
      entry.usage.inputTokens += event.inputTokens;
      entry.usage.outputTokens += event.outputTokens;
      entry.usage.cacheReadTokens += event.cacheReadTokens;
      entry.usage.costUsd += event.costUsd;
      this.deps.db.updateAgentSessionUsage(entry.sessionId, entry.usage);
      this.writeTranscript(entry, { kind: 'usage', ...entry.usage });
    } else if (event.type === 'text') {
      this.writeTranscript(entry, { kind: 'assistant', text: event.text });
    } else if (event.type === 'tool_start') {
      this.writeTranscript(entry, {
        kind: 'tool_start',
        toolUseId: event.toolUseId,
        name: event.name,
        input: JSON.stringify(redactSensitive(event.input) ?? {}).slice(0, 2000),
      });
    } else if (event.type === 'tool_end') {
      this.writeTranscript(entry, { kind: 'tool_end', toolUseId: event.toolUseId, ok: event.ok });
    } else if (event.type === 'external_auth') {
      this.writeTranscript(entry, {
        kind: 'external_auth',
        server: event.server,
        status: event.status,
      });
    } else if (event.type === 'mcp_status') {
      this.writeTranscript(entry, { kind: 'mcp_status', servers: event.servers });
    } else if (event.type === 'error') {
      entry.lastError = event.message;
      this.writeTranscript(entry, { kind: 'error', message: event.message });
      if (entry.status === 'active') {
        this.alert({
          sessionId: entry.sessionId,
          projectName: entry.projectName,
          kind: 'error',
          text: event.message.slice(0, 140),
        });
      }
    } else if (event.type === 'done' && event.result !== null) {
      // A turn completed cleanly — an earlier recovered error must not brand
      // the whole session 'error' at teardown.
      entry.lastError = null;
      if (entry.status === 'active') {
        this.alert({
          sessionId: entry.sessionId,
          projectName: entry.projectName,
          kind: 'done',
          text: event.result.slice(0, 140),
        });
      }
    }
    this.forward(entry, event);
  }

  private forward(entry: LiveSession, event: Exclude<AgentEvent, { type: 'sdk_session' }>): void {
    let chat: ChatEvent;
    if (event.type === 'tool_start') {
      // Annotate from the raw input (needs the connection value), then redact
      // before anything crosses to the renderer.
      const target = entry.run.annotateTarget(event.input);
      chat = {
        type: 'tool_start',
        toolUseId: event.toolUseId,
        name: event.name,
        input: redactSensitive(event.input),
        connection: target.connection,
        envRole: target.envRole,
      };
    } else {
      chat = event;
    }
    this.push('session:event', { sessionId: entry.sessionId, event: chat });
  }

  private writeTranscript(entry: LiveSession, line: Record<string, unknown>): void {
    entry.transcript?.write(JSON.stringify({ ts: new Date().toISOString(), ...line }) + '\n');
  }
}
