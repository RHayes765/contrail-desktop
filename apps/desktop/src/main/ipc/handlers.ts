import type { BrowserWindow } from 'electron';
import type { EffortLevel, HealthView } from '@contrail/shared';
import type { EngineDeps } from '@contrail/engine';
import { ConnectionService } from '../services/connections.js';
import { docView, noteView, ProjectService } from '../services/projects.js';
import { AgentSessionManager } from '../services/agentRuntime.js';

/**
 * The complete handler map for the typed IPC registry. Handlers are thin:
 * every real rule (silo checks, path derivation, token hygiene) lives in the
 * services; anything returned here must already be a renderer-safe view.
 */

export interface MainServices {
  connections: ConnectionService;
  projects: ProjectService;
  sessions: AgentSessionManager;
  /** The window whose native dialogs (file picker) we parent. */
  getWindow: () => BrowserWindow | null;
}

export function makeHandlers(health: HealthView, services: MainServices) {
  const { connections, projects, sessions } = services;
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
  };
}
