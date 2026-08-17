import type { BrowserWindow } from 'electron';
import type { EffortLevel, GrantSetView, HealthView } from '@contrail/shared';
import type { EngineDeps } from '@contrail/engine';
import { ConnectionService } from '../services/connections.js';
import { docView, noteView, ProjectService } from '../services/projects.js';
import { AgentSessionManager } from '../services/agentRuntime.js';
import { SnapshotService } from '../services/snapshots.js';
import { DiffService, MetadataService } from '../services/metadata.js';
import { SummaryService } from '../services/summaries.js';
import { McpConfigService } from '../services/mcpConfig.js';
import { DeployService } from '../services/deploys.js';
import { SettingsService } from '../services/settings.js';
import { BudgetService } from '../services/budget.js';

/**
 * The complete handler map for the typed IPC registry. Handlers are thin:
 * every real rule (silo checks, path derivation, token hygiene) lives in the
 * services; anything returned here must already be a renderer-safe view.
 */

export interface MainServices {
  connections: ConnectionService;
  projects: ProjectService;
  sessions: AgentSessionManager;
  snapshots: SnapshotService;
  metadata: MetadataService;
  diff: DiffService;
  summaries: SummaryService;
  mcp: McpConfigService;
  deploys: DeployService;
  settings: SettingsService;
  budget: BudgetService;
  /** The window whose native dialogs (file picker) we parent. */
  getWindow: () => BrowserWindow | null;
}

export function makeHandlers(health: HealthView, services: MainServices) {
  const { connections, projects, sessions, snapshots, metadata, diff, summaries, mcp, deploys, settings, budget } =
    services;
  return {
    'app:health': (deps: EngineDeps): HealthView => ({
      ...health,
      connectionCount: deps.db.listConnections().length,
    }),

    'connections:list': () => connections.list(),
    'connections:connect': (_deps: EngineDeps, req: { login?: string; label?: string }) =>
      connections.connect(req),
    'connections:remove': (_deps: EngineDeps, req: { id: string }) => connections.remove(req.id),
    'connections:ping': (_deps: EngineDeps, req: { id: string }) => connections.ping(req.id),
    'connections:setGrants': (
      _deps: EngineDeps,
      req: { id: string; grants: GrantSetView },
    ) => connections.setGrants(req.id, req.grants),

    'metadata:status': (_deps: EngineDeps, req: { connectionId: string }) =>
      snapshots.status(req.connectionId),
    'metadata:sync': (_deps: EngineDeps, req: { connectionId: string }) =>
      snapshots.sync(req.connectionId, 'refresh'),
    'metadata:types': (_deps: EngineDeps, req: { connectionId: string }) =>
      metadata.types(req.connectionId),
    'metadata:list': (
      _deps: EngineDeps,
      req: { connectionId: string; type: string; query?: string; limit?: number },
    ) => metadata.list(req.connectionId, req.type, req.query, req.limit),
    'metadata:artifact': (
      _deps: EngineDeps,
      req: { connectionId: string; type: string; apiName: string },
    ) => metadata.artifact(req.connectionId, req.type, req.apiName),
    'metadata:summarize': (
      _deps: EngineDeps,
      req: {
        connectionId: string;
        type: 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule';
        apiName: string;
      },
    ) => summaries.summarize(req.connectionId, req.type, req.apiName),
    'diff:scope': (
      _deps: EngineDeps,
      req: { connectionA: string; connectionB: string; types?: string[] },
    ) => diff.diffScope(req.connectionA, req.connectionB, req.types),
    'diff:artifact': (
      _deps: EngineDeps,
      req: { connectionA: string; connectionB: string; type: string; apiName: string },
    ) => diff.diffArtifact(req.connectionA, req.connectionB, req.type, req.apiName),
    'diff:summarize': (
      _deps: EngineDeps,
      req: {
        connectionA: string;
        connectionB: string;
        type: 'ApexClass' | 'ApexTrigger' | 'Flow' | 'ValidationRule';
        apiName: string;
      },
    ) => summaries.summarizeDiff(req.connectionA, req.connectionB, req.type, req.apiName),

    'projects:list': () => projects.list(),
    'projects:create': (_deps: EngineDeps, req: { name: string; description?: string }) =>
      projects.create(req.name, req.description),
    'projects:update': (
      _deps: EngineDeps,
      req: { id: string; name?: string; description?: string | null; instructions?: string | null },
    ) => projects.update(req.id, req),
    'projects:delete': async (_deps: EngineDeps, req: { id: string }) => {
      // Live sessions lose their silo the moment the rows go — end them first
      // so no agent keeps running against a deleted project.
      await sessions.endForProject(req.id);
      projects.delete(req.id);
      return { ok: true };
    },
    'projects:bind': (
      _deps: EngineDeps,
      req: { projectId: string; connectionId: string; envRole: 'dev' | 'qa' | 'uat' | 'prod' | 'other' },
    ) => projects.bind(req.projectId, req.connectionId, req.envRole),
    'projects:unbind': (_deps: EngineDeps, req: { projectId: string; connectionId: string }) =>
      projects.unbind(req.projectId, req.connectionId),

    'projects:docs:list': (_deps: EngineDeps, req: { projectId: string }) =>
      projects.listDocs(req.projectId).map(docView),
    'projects:docs:add': async (_deps: EngineDeps, req: { projectId: string }) => ({
      added: (await projects.addDocsViaDialog(req.projectId, services.getWindow())).map(docView),
    }),
    'projects:docs:remove': (_deps: EngineDeps, req: { projectId: string; docId: string }) => {
      projects.removeDoc(req.projectId, req.docId);
      return { ok: true };
    },

    'projects:notes:list': (_deps: EngineDeps, req: { projectId: string }) =>
      projects.listNotes(req.projectId).map(noteView),
    'projects:notes:add': (_deps: EngineDeps, req: { projectId: string; body: string }) =>
      noteView(projects.addNote(req.projectId, req.body, 'user', null)),

    'sessions:list': (_deps: EngineDeps, req: { projectId: string }) => sessions.list(req.projectId),
    'sessions:start': (
      _deps: EngineDeps,
      req: { projectId: string; model?: string; effort?: EffortLevel },
    ) => sessions.start(req.projectId, req.model, req.effort),
    'sessions:send': (_deps: EngineDeps, req: { sessionId: string; text: string }) => {
      sessions.send(req.sessionId, req.text);
      return { ok: true };
    },
    'sessions:interrupt': (_deps: EngineDeps, req: { sessionId: string }) => {
      sessions.interrupt(req.sessionId);
      return { ok: true };
    },
    'sessions:end': async (_deps: EngineDeps, req: { sessionId: string }) => {
      await sessions.end(req.sessionId);
      return { ok: true };
    },
    'sessions:transcript': (_deps: EngineDeps, req: { sessionId: string }) =>
      sessions.readTranscript(req.sessionId),
    'sessions:resume': (_deps: EngineDeps, req: { sessionId: string }) =>
      sessions.resume(req.sessionId),

    'mcp:project': (_deps: EngineDeps, req: { projectId: string }) =>
      mcp.projectView(req.projectId),
    'mcp:setToggle': (
      _deps: EngineDeps,
      req: { projectId: string; serverKey: string; enabled: boolean },
    ) => mcp.setToggle(req.projectId, req.serverKey, req.enabled),
    'mcp:servers:list': () => mcp.listServers(),
    'mcp:servers:add': (
      _deps: EngineDeps,
      req: {
        name: string;
        transport: 'stdio' | 'http' | 'sse';
        urlOrCommand: string;
        args?: string[];
        env?: Record<string, string>;
        headers?: Record<string, string>;
      },
    ) => mcp.addServer(req),
    'mcp:servers:update': (
      _deps: EngineDeps,
      req: {
        id: string;
        name?: string;
        urlOrCommand?: string;
        enabled?: boolean;
        args?: string[];
        env?: Record<string, string>;
        headers?: Record<string, string>;
      },
    ) => mcp.updateServer(req),
    'mcp:servers:remove': async (_deps: EngineDeps, req: { id: string }) => {
      await mcp.removeServer(req.id);
      return { ok: true };
    },
    'mcp:servers:test': (_deps: EngineDeps, req: { id: string }) => mcp.testServer(req.id),
    'mcp:servers:authorize': (_deps: EngineDeps, req: { id: string }) =>
      mcp.authorizeServer(req.id),

    'deploys:list': (_deps: EngineDeps, req: { connectionId?: string }) =>
      deploys.list(req.connectionId),
    'deploys:get': (_deps: EngineDeps, req: { id: string }) => deploys.get(req.id),
    // The ONLY execute path in the app: renderer decision → main reads the
    // code from the row → engine claim machinery. The runtime never sees it.
    'deploys:approve': (_deps: EngineDeps, req: { id: string; comment?: string }) =>
      deploys.approve(req.id, req.comment),
    'deploys:reject': (_deps: EngineDeps, req: { id: string; comment?: string }) =>
      deploys.reject(req.id, req.comment),

    'settings:keyStatus': () => settings.keyStatus(),
    'settings:setKey': (_deps: EngineDeps, req: { key: string }) => settings.setKey(req.key),
    'settings:clearKey': () => settings.clearKey(),
    'settings:budget': () => budget.status(),
    'settings:setBudgetCap': (_deps: EngineDeps, req: { capUsd: number }) =>
      budget.setDailyCapUsd(req.capUsd),
  };
}
