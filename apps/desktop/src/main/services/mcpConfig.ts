import { spawn } from 'node:child_process';
import {
  STANDARD_CATALOG,
  externalServerKey,
  isStandardCatalogKey,
  serverEnabled,
  type CustomMcpServerExtras,
  type CustomMcpServerRecord,
  type EngineDeps,
} from '@contrail/engine';
import type { ExternalMcpServerSpec } from '@contrail/agent-runtime';
import type { CustomMcpServerView, McpServerTestView, ProjectMcpView } from '@contrail/shared';
import { clearMcpToken, mcpBearerFor, McpOAuthService } from './mcpOauth.js';

/**
 * The headers a server actually gets: a keychain-stored OAuth bearer (from
 * the Authorize flow) underneath, user-typed headers on top — someone who
 * pastes their own Authorization header wins over the stored token.
 */
function effectiveHeaders(server: CustomMcpServerRecord): Record<string, string> | undefined {
  const bearer = server.transport === 'stdio' ? null : mcpBearerFor(server.id);
  const merged = {
    ...(bearer ? { Authorization: bearer } : {}),
    ...(server.config.headers ?? {}),
  };
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * MCP configuration: the standard-catalog toggle surface and the external
 * (auth_mode: independent) server registry. Two rules carried throughout:
 *
 *  - Header/env VALUES are auth material. They go DB → session options and
 *    nowhere else — every view carries names only.
 *  - External servers reach a session only when globally enabled AND
 *    opted into for that project (default OFF — engagement isolation).
 */

/** SDK server keys must be [a-zA-Z0-9_-]; anything else becomes '_'. */
export function slugifyServerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'server';
}

/**
 * Everything session start needs from this subsystem, resolved live from
 * the DB: which catalog families are toggled off, and the external server
 * specs (with deduped, contrail-safe keys) the SDK should connect.
 */
export function resolveSessionMcp(
  deps: EngineDeps,
  projectId: string,
): {
  disabledCatalogKeys: string[];
  externalServers: ExternalMcpServerSpec[];
  /** DB ids parallel to externalServers — main-side revocation bookkeeping. */
  externalServerIds: string[];
} {
  const toggles = deps.db.getServerToggles(projectId);
  const disabledCatalogKeys = STANDARD_CATALOG.filter(
    (e) => !serverEnabled(toggles, e.key),
  ).map((e) => e.key);

  const externalServers: ExternalMcpServerSpec[] = [];
  const externalServerIds: string[] = [];
  const takenKeys = new Set(['contrail']);
  for (const server of deps.db.listCustomMcpServers()) {
    if (!server.enabled) continue;
    if (server.authMode !== 'independent') continue; // org_bound is design-doc scope
    if (!serverEnabled(toggles, externalServerKey(server.id))) continue;
    let key = slugifyServerName(server.name);
    let n = 2;
    while (takenKeys.has(key)) key = `${slugifyServerName(server.name)}_${n++}`;
    takenKeys.add(key);
    const headers = effectiveHeaders(server);
    externalServers.push({
      key,
      transport: server.transport,
      urlOrCommand: server.urlOrCommand,
      ...(server.config.args ? { args: server.config.args } : {}),
      ...(server.config.env ? { env: server.config.env } : {}),
      ...(headers ? { headers } : {}),
    });
    externalServerIds.push(server.id);
  }
  return { disabledCatalogKeys, externalServers, externalServerIds };
}

function serverView(record: CustomMcpServerRecord): CustomMcpServerView {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    urlOrCommand: record.urlOrCommand,
    args: record.config.args ?? [],
    headerNames: Object.keys(record.config.headers ?? {}),
    envNames: Object.keys(record.config.env ?? {}),
    enabled: record.enabled,
    createdAt: record.createdAt,
  };
}

export class McpConfigService {
  /**
   * External tools run inside the SDK child and never cross the per-call
   * executor gate, so revoking one (project toggle off, global disable,
   * removal) cannot reach a live session's connections. The honest remedy —
   * same precedent as projects:delete — is ending the live sessions that
   * resolved the server at start. Main wires this to
   * AgentSessionManager.endForExternalServer.
   */
  private readonly oauth: McpOAuthService;

  constructor(
    private readonly deps: EngineDeps,
    private readonly onExternalRevoked?: (
      serverId: string,
      projectId?: string,
    ) => Promise<void>,
  ) {
    this.oauth = new McpOAuthService(deps);
  }

  projectView(projectId: string): ProjectMcpView {
    if (!this.deps.db.getProject(projectId)) throw new Error(`Project ${projectId} not found.`);
    const toggles = this.deps.db.getServerToggles(projectId);
    return {
      families: STANDARD_CATALOG.map((e) => ({
        key: e.key,
        label: e.label,
        description: e.description,
        capabilities: e.capabilities,
        enabled: serverEnabled(toggles, e.key),
      })),
      externalServers: this.deps.db.listCustomMcpServers().map((s) => ({
        id: s.id,
        name: s.name,
        transport: s.transport,
        globallyEnabled: s.enabled,
        enabledForProject: serverEnabled(toggles, externalServerKey(s.id)),
      })),
    };
  }

  async setToggle(
    projectId: string,
    serverKey: string,
    enabled: boolean,
  ): Promise<ProjectMcpView> {
    if (!this.deps.db.getProject(projectId)) throw new Error(`Project ${projectId} not found.`);
    const isExternal =
      serverKey.startsWith('ext:') &&
      this.deps.db.getCustomMcpServer(serverKey.slice('ext:'.length)) !== null;
    if (!isStandardCatalogKey(serverKey) && !isExternal) {
      throw new Error(`Unknown server key "${serverKey}".`);
    }
    this.deps.db.setServerToggle(projectId, serverKey, enabled);
    if (isExternal && !enabled) {
      // Revocation must reach live sessions; catalog families need no
      // teardown because the executor gates them per call.
      await this.onExternalRevoked?.(serverKey.slice('ext:'.length), projectId);
    }
    this.deps.audit.record('mcp.toggle_changed', {
      tool: 'desktop_mcp_panel',
      outcome: 'success',
      detail: { projectId, serverKey, enabled },
    });
    return this.projectView(projectId);
  }

  listServers(): CustomMcpServerView[] {
    return this.deps.db.listCustomMcpServers().map(serverView);
  }

  addServer(req: {
    name: string;
    transport: 'stdio' | 'http' | 'sse';
    urlOrCommand: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
  }): CustomMcpServerView {
    const config: CustomMcpServerExtras = {};
    if (req.args?.length) config.args = req.args;
    if (req.env && Object.keys(req.env).length) config.env = req.env;
    if (req.headers && Object.keys(req.headers).length) config.headers = req.headers;
    const record = this.deps.db.addCustomMcpServer({
      name: req.name,
      transport: req.transport,
      urlOrCommand: req.urlOrCommand,
      config,
    });
    this.deps.audit.record('mcp.server_added', {
      tool: 'desktop_mcp_panel',
      outcome: 'success',
      detail: { id: record.id, name: record.name, transport: record.transport },
    });
    return serverView(record);
  }

  async updateServer(req: {
    id: string;
    name?: string;
    urlOrCommand?: string;
    enabled?: boolean;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
  }): Promise<CustomMcpServerView> {
    const current = this.deps.db.getCustomMcpServer(req.id);
    if (!current) throw new Error('Server not found.');
    // Secret patch semantics: omitting env/headers KEEPS the stored values
    // (the renderer never has them to echo back); sending them replaces.
    const config: CustomMcpServerExtras = {
      ...(req.args !== undefined ? { args: req.args } : current.config.args ? { args: current.config.args } : {}),
      ...(req.env !== undefined ? { env: req.env } : current.config.env ? { env: current.config.env } : {}),
      ...(req.headers !== undefined
        ? { headers: req.headers }
        : current.config.headers
          ? { headers: current.config.headers }
          : {}),
    };
    const updated = this.deps.db.updateCustomMcpServer(req.id, {
      name: req.name,
      urlOrCommand: req.urlOrCommand,
      enabled: req.enabled,
      config,
    });
    if (!updated) throw new Error('Server not found.');
    if (req.enabled !== undefined && req.enabled !== current.enabled) {
      this.deps.audit.record('mcp.server_toggled', {
        tool: 'desktop_mcp_panel',
        outcome: 'success',
        detail: { id: updated.id, name: updated.name, enabled: req.enabled },
      });
      if (!req.enabled) await this.onExternalRevoked?.(req.id);
    }
    return serverView(updated);
  }

  /**
   * The MCP OAuth flow, run by Contrail itself (the SDK cannot initiate it
   * — verified empirically). On success the fresh token is proven with a
   * connection test so the caller gets a real verdict, not "flow finished".
   */
  async authorizeServer(
    id: string,
  ): Promise<{ ok: boolean; detail: string; test: McpServerTestView | null }> {
    const outcome = await this.oauth.authorize(id);
    if (!outcome.ok) {
      this.deps.audit.record('mcp.oauth_failed', {
        tool: 'desktop_mcp_panel',
        outcome: 'error',
        detail: { id, reason: outcome.detail.slice(0, 300) },
      });
      return { ...outcome, test: null };
    }
    return { ...outcome, test: await this.testServer(id) };
  }

  /**
   * A real MCP handshake against the stored config, from main (stored
   * headers/env are attached here and never leave the process; the result
   * carries statuses and tool names only). "Saved" is not "working" — this
   * is how registration gets honest feedback.
   */
  async testServer(id: string): Promise<McpServerTestView> {
    const server = this.deps.db.getCustomMcpServer(id);
    if (!server) throw new Error('Server not found.');
    const result =
      server.transport === 'stdio'
        ? await testStdioServer(server)
        : await testHttpServer({
            urlOrCommand: server.urlOrCommand,
            config: { headers: effectiveHeaders(server) },
          });
    this.deps.audit.record('mcp.server_tested', {
      tool: 'desktop_mcp_panel',
      outcome: result.status === 'connected' ? 'success' : 'error',
      detail: { id, name: server.name, status: result.status },
    });
    return result;
  }

  async removeServer(id: string): Promise<void> {
    const current = this.deps.db.getCustomMcpServer(id);
    // End affected sessions BEFORE the rows go — same order as projects:delete.
    if (current) await this.onExternalRevoked?.(id);
    clearMcpToken(id);
    this.deps.db.removeCustomMcpServer(id);
    if (current) {
      this.deps.audit.record('mcp.server_removed', {
        tool: 'desktop_mcp_panel',
        outcome: 'success',
        detail: { id, name: current.name },
      });
    }
  }
}

// ── connection probes ─────────────────────────────────────────────────────

const TEST_TIMEOUT_MS = 10_000;

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'contrail-connection-test', version: '1.0.0' },
  },
};

/** Parse a streamable-HTTP response body that may be JSON or SSE-framed. */
function parseMcpBody(contentType: string, body: string): unknown {
  if (contentType.includes('text/event-stream')) {
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        try {
          return JSON.parse(trimmed.slice(5).trim());
        } catch {
          /* keep scanning */
        }
      }
    }
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function testHttpServer(
  server: { urlOrCommand: string; config: { headers?: Record<string, string> } },
): Promise<McpServerTestView> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(server.urlOrCommand, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(server.config.headers ?? {}),
      },
      body: JSON.stringify(INITIALIZE_REQUEST),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'needs_auth',
        detail: `The server answered HTTP ${res.status} — it requires authentication this registration doesn't satisfy (OAuth-only servers can't be reached with header tokens).`,
        tools: [],
      };
    }
    if (!res.ok) {
      return { status: 'failed', detail: `HTTP ${res.status} from the server.`, tools: [] };
    }
    const body = parseMcpBody(res.headers.get('content-type') ?? '', await res.text());
    const result = (body as { result?: { serverInfo?: { name?: string } } } | null)?.result;
    if (!result) {
      return {
        status: 'failed',
        detail: 'The endpoint answered but not with an MCP initialize result.',
        tools: [],
      };
    }
    // A handshake alone is NOT proof of usability: stateless servers
    // (Google's) accept anonymous initialize and only reject real work.
    // tools/list is the honesty check.
    const sessionId = res.headers.get('mcp-session-id');
    const serverName = result.serverInfo?.name;
    try {
      const listRes = await fetch(server.urlOrCommand, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(server.config.headers ?? {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      if (listRes.status === 401 || listRes.status === 403) {
        return {
          status: 'needs_auth',
          detail: `The server accepts anonymous handshakes${serverName ? ` ("${serverName}")` : ''} but its tools require authentication (HTTP ${listRes.status} on tools/list) — OAuth-only until authorized.`,
          tools: [],
        };
      }
      const listBody = parseMcpBody(
        listRes.headers.get('content-type') ?? '',
        await listRes.text(),
      ) as {
        result?: { tools?: Array<{ name?: string }> };
        error?: { message?: string };
      } | null;
      if (listBody?.error) {
        return {
          status: 'needs_auth',
          detail: `Handshake OK but tools are not available anonymously: ${String(listBody.error.message ?? 'error').slice(0, 200)}`,
          tools: [],
        };
      }
      const tools = (listBody?.result?.tools ?? []).map((t) => t.name ?? '').filter(Boolean);
      return {
        status: 'connected',
        detail: serverName
          ? `Connected to "${serverName}" — ${tools.length} tool${tools.length === 1 ? '' : 's'}.`
          : `Connected — ${tools.length} tool${tools.length === 1 ? '' : 's'}.`,
        tools,
      };
    } catch {
      // initialize succeeded, listing didn't — report reachable, not usable.
      return {
        status: 'connected',
        detail: `${serverName ? `"${serverName}" answered the handshake` : 'Handshake OK'}, but tool listing did not complete — usability unconfirmed.`,
        tools: [],
      };
    }
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return {
      status: 'failed',
      detail: aborted ? `No response within ${TEST_TIMEOUT_MS / 1000}s.` : String(err).slice(0, 300),
      tools: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

async function testStdioServer(server: {
  urlOrCommand: string;
  config: { args?: string[]; env?: Record<string, string> };
}): Promise<McpServerTestView> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (view: McpServerTestView): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(view);
    };
    const child = spawn(server.urlOrCommand, server.config.args ?? [], {
      env: { ...process.env, ...(server.config.env ?? {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(
      () => done({ status: 'failed', detail: `No response within ${TEST_TIMEOUT_MS / 1000}s.`, tools: [] }),
      TEST_TIMEOUT_MS,
    );
    child.on('error', (err) =>
      done({ status: 'failed', detail: `Could not start the command: ${String(err).slice(0, 200)}`, tools: [] }),
    );
    child.on('exit', (code) =>
      done({ status: 'failed', detail: `The command exited (code ${code}) before completing the handshake.`, tools: [] }),
    );
    let buffer = '';
    child.stderr?.on('data', () => {}); // drain — a chatty server must not wedge
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { tools?: Array<{ name?: string }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          child.stdin?.write(
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
          );
          child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        } else if (msg.id === 2) {
          const tools = (msg.result?.tools ?? []).map((t) => t.name ?? '').filter(Boolean);
          done({
            status: 'connected',
            detail: `Handshake complete — ${tools.length} tool${tools.length === 1 ? '' : 's'}.`,
            tools,
          });
        }
      }
    });
    child.stdin?.write(JSON.stringify(INITIALIZE_REQUEST) + '\n');
  });
}
