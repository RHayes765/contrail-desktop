import { create } from 'zustand';
import type {
  EnvRole,
  ProjectDocView,
  ProjectNoteView,
  ProjectView,
  SessionView,
} from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

interface ProjectsState {
  projects: ProjectView[] | null;
  selectedId: string | null;
  docs: ProjectDocView[];
  notes: ProjectNoteView[];
  sessions: SessionView[];
  error: string | null;

  refresh: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  create: (name: string, description?: string) => Promise<ProjectView>;
  /** Returns true on success — callers must NOT discard drafts on false. */
  update: (patch: {
    id: string;
    name?: string;
    description?: string | null;
    instructions?: string | null;
  }) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  bind: (projectId: string, connectionId: string, envRole: EnvRole) => Promise<void>;
  unbind: (projectId: string, connectionId: string) => Promise<void>;
  addDocs: (projectId: string) => Promise<void>;
  removeDoc: (projectId: string, docId: string) => Promise<void>;
  /** Returns true on success — callers must NOT discard drafts on false. */
  addNote: (projectId: string, body: string) => Promise<boolean>;
  refreshSessions: (projectId: string) => Promise<void>;
  deleteSession: (projectId: string, sessionId: string) => Promise<boolean>;
  renameSession: (projectId: string, sessionId: string, title: string) => Promise<boolean>;
  clearError: () => void;
}

function applyProject(s: ProjectsState, updated: ProjectView): Partial<ProjectsState> {
  return {
    projects: (s.projects ?? []).map((p) => (p.id === updated.id ? updated : p)),
  };
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: null,
  selectedId: null,
  docs: [],
  notes: [],
  sessions: [],
  error: null,

  refresh: async () => {
    set({ projects: await ipc.invoke('projects:list', {}) });
  },

  select: async (id) => {
    set({ selectedId: id, docs: [], notes: [], sessions: [] });
    if (!id) return;
    const [docs, notes, sessions] = await Promise.all([
      ipc.invoke('projects:docs:list', { projectId: id }),
      ipc.invoke('projects:notes:list', { projectId: id }),
      ipc.invoke('sessions:list', { projectId: id }),
    ]);
    set({ docs, notes, sessions });
  },

  create: async (name, description) => {
    const view = await ipc.invoke('projects:create', { name, description });
    set((s) => ({ projects: [...(s.projects ?? []), view] }));
    return view;
  },

  update: async (patch) => {
    try {
      const view = await ipc.invoke('projects:update', patch);
      set((s) => ({ ...applyProject(s, view), error: null }));
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },

  remove: async (id) => {
    await ipc.invoke('projects:delete', { id });
    set((s) => ({
      projects: (s.projects ?? []).filter((p) => p.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },

  bind: async (projectId, connectionId, envRole) => {
    try {
      const view = await ipc.invoke('projects:bind', { projectId, connectionId, envRole });
      set((s) => applyProject(s, view));
    } catch (err) {
      set({ error: String(err) });
    }
  },

  unbind: async (projectId, connectionId) => {
    try {
      const view = await ipc.invoke('projects:unbind', { projectId, connectionId });
      set((s) => applyProject(s, view));
    } catch (err) {
      set({ error: String(err) });
    }
  },

  addDocs: async (projectId) => {
    try {
      await ipc.invoke('projects:docs:add', { projectId });
      set({ docs: await ipc.invoke('projects:docs:list', { projectId }) });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  removeDoc: async (projectId, docId) => {
    try {
      await ipc.invoke('projects:docs:remove', { projectId, docId });
      set({ docs: await ipc.invoke('projects:docs:list', { projectId }) });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  addNote: async (projectId, body) => {
    try {
      await ipc.invoke('projects:notes:add', { projectId, body });
      set({ notes: await ipc.invoke('projects:notes:list', { projectId }), error: null });
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },

  refreshSessions: async (projectId) => {
    if (get().selectedId !== projectId) return;
    set({ sessions: await ipc.invoke('sessions:list', { projectId }) });
  },

  deleteSession: async (projectId, sessionId) => {
    try {
      await ipc.invoke('sessions:delete', { sessionId });
      // main pushes sessions:changed, but refresh directly so the row leaves
      // the list even if this project is no longer the pushed one.
      await get().refreshSessions(projectId);
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },

  renameSession: async (projectId, sessionId, title) => {
    try {
      await ipc.invoke('sessions:rename', { sessionId, title });
      await get().refreshSessions(projectId);
      return true;
    } catch (err) {
      set({ error: String(err).replace(/^Error:\s*/, '') });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));

ipc.subscribe('sessions:changed', ({ projectId }) => {
  void useProjects.getState().refreshSessions(projectId);
});
