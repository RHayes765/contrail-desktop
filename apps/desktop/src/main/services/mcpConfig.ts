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
import type { CustomMcpServerView, ProjectMcpView } from '@contrail/shared';

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
    externalServers.push({
      key,
      transport: server.transport,
      urlOrCommand: server.urlOrCommand,
      ...(server.config.args ? { args: server.config.args } : {}),
      ...(server.config.env ? { env: server.config.env } : {}),
      ...(server.config.headers ? { headers: server.config.headers } : {}),
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
  constructor(
    private readonly deps: EngineDeps,
    private readonly onExternalRevoked?: (
      serverId: string,
      projectId?: string,
    ) => Promise<void>,
  ) {}

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

  async removeServer(id: string): Promise<void> {
    const current = this.deps.db.getCustomMcpServer(id);
    // End affected sessions BEFORE the rows go — same order as projects:delete.
    if (current) await this.onExternalRevoked?.(id);
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
