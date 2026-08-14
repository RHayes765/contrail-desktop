import { utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  invokeCapability,
  readSecret,
  type ConnectionRecord,
  type EngineDeps,
} from '@contrail/engine';
import type {
  AgentEvent,
  BindingWithGrants,
  BridgeToolResult,
  SessionContext,
  ToChild,
  ToMain,
} from '@contrail/agent-runtime';

/**
 * AgentRuntimeManager: one utilityProcess per session, bridged capability
 * execution, and THE project-silo enforcement point.
 *
 * Every capability call from the runtime lands in `executeCapability`, which
 * validates session → project → binding BEFORE anything else touches the
 * engine. The runtime child can ask for whatever it likes; a connection not
 * bound to the session's project does not exist as far as it's concerned.
 * project identity is resolved server-side from the session — never from
 * agent-supplied arguments.
 */

const API_KEY_SERVICE = 'Contrail Desktop';
const API_KEY_ACCOUNT = 'anthropic-api-key';

export function readApiKey(): string | null {
  return readSecret(API_KEY_SERVICE, API_KEY_ACCOUNT);
}

/** Capabilities whose scoped answer the executor owns outright (never delegated raw). */
const EXECUTOR_OWNED = new Set(['list_connections', 'get_permissions']);

/** Argument keys that name a target connection, per capability shape. */
const CONNECTION_ARG_KEYS = ['connection', 'connection_a', 'connection_b'] as const;

export interface SessionSpec {
  project: { id: string; name: string; description: string | null; instructions: string | null };
  bindings: Array<{ connection: ConnectionRecord; envRole: string }>;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface SessionRunResult {
  events: AgentEvent[];
  finalText: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  capabilityCalls: Array<{ name: string; refused: boolean }>;
}

function refuse(message: string): BridgeToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export class AgentSessionRun {
  private readonly boundByAlias = new Map<string, ConnectionRecord>();
  private readonly boundById = new Map<string, ConnectionRecord>();
  readonly capabilityCalls: Array<{ name: string; refused: boolean }> = [];

  constructor(
    private readonly deps: EngineDeps,
    private readonly spec: SessionSpec,
  ) {
    for (const b of spec.bindings) {
      this.boundByAlias.set(b.connection.alias.toLowerCase(), b.connection);
      this.boundById.set(b.connection.id, b.connection);
    }
  }

  /** Resolve a connection reference WITHIN the project silo only. */
  private resolveBound(ref: unknown): ConnectionRecord | null {
    if (typeof ref !== 'string' || !ref) return null;
    return this.boundById.get(ref) ?? this.boundByAlias.get(ref.toLowerCase()) ?? null;
  }

  async executeCapability(name: string, args: unknown): Promise<BridgeToolResult> {
    const a = (args ?? {}) as Record<string, unknown>;

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
              `Available connections: ${this.spec.bindings.map((b) => b.connection.alias).join(', ') || 'none'}.`,
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

  private scopedListing(name: string, a: Record<string, unknown>): BridgeToolResult {
    const views = this.spec.bindings.map((b) => ({
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
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] };
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify({ connections: views, count: views.length }, null, 2) },
      ],
    };
  }

  buildContext(sessionId: string, apiKey: string): SessionContext {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-session-'));
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
      maxTurns: this.spec.maxTurns,
      maxBudgetUsd: this.spec.maxBudgetUsd,
      cwd,
      apiKey,
    };
  }
}

/** Run one headless question through a real utilityProcess session. */
export function runHeadlessSession(
  deps: EngineDeps,
  spec: SessionSpec,
  childPath: string,
  question: string,
  timeoutMs = 180_000,
): Promise<SessionRunResult> {
  return new Promise((resolve, reject) => {
    const apiKey = readApiKey();
    if (!apiKey) {
      reject(new Error('No API key in Credential Manager (service "Contrail Desktop").'));
      return;
    }

    const run = new AgentSessionRun(deps, spec);
    const sessionId = deps.db.createAgentSession({
      projectId: spec.project.id,
      title: question.slice(0, 80),
      model: spec.model,
    });
    const ctx = run.buildContext(sessionId, apiKey);

    const child: UtilityProcess = utilityProcess.fork(childPath, [], { stdio: 'pipe' });
    const events: AgentEvent[] = [];
    let finalText: string | null = null;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      deps.db.finishAgentSession(sessionId, usage, err ? 'error' : 'ended');
      child.kill();
      try {
        fs.rmSync(ctx.cwd, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // The killed CLI can briefly hold the scratch cwd on Windows (EPERM).
        // An orphaned empty temp dir is acceptable; failing the session is not.
      }
      if (err) reject(err);
      else resolve({ events, finalText, usage, capabilityCalls: run.capabilityCalls });
    };

    const watchdog = setTimeout(
      () => finish(new Error(`session timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const post = (msg: ToChild): void => child.postMessage(msg);

    child.on('message', (raw: ToMain) => {
      void (async () => {
        if (raw.kind === 'ready') {
          post({ kind: 'send', text: question });
        } else if (raw.kind === 'capability:invoke') {
          const result = await run.executeCapability(raw.name, raw.args);
          post({ kind: 'capability:result', id: raw.id, result });
        } else if (raw.kind === 'event') {
          events.push(raw.event);
          const ev = raw.event;
          if (ev.type === 'usage') {
            usage.inputTokens += ev.inputTokens;
            usage.outputTokens += ev.outputTokens;
            usage.cacheReadTokens += ev.cacheReadTokens;
            usage.costUsd += ev.costUsd;
          } else if (ev.type === 'done') {
            finalText = ev.result;
            finish();
          }
        }
      })();
    });

    child.on('exit', (code) => {
      if (!settled) finish(new Error(`runtime child exited early (code ${code})`));
    });

    child.once('spawn', () => post({ kind: 'init', ctx }));
  });
}
