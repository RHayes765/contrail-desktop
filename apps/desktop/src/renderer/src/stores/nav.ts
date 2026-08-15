import { create } from 'zustand';

/**
 * Screen routing. Deliberately a store, not a router — three screens and a
 * detail/chat drill-in don't earn a URL scheme in a desktop shell.
 */

export type Screen =
  | 'connections'
  | 'projects'
  | 'project'
  | 'chat'
  | 'session'
  | 'metadata'
  | 'diff'
  | 'connectors'
  | 'deploys';

interface NavState {
  screen: Screen;
  /** Set when screen is 'project', 'chat', or 'session'. */
  projectId: string | null;
  /** Set when screen is 'session' (read-only transcript view). */
  sessionId: string | null;
  /** Set when the Deploys screen should open straight into one request. */
  deployId: string | null;
  goConnections: () => void;
  goProjects: () => void;
  goConnectors: () => void;
  openDeploys: (deployId?: string) => void;
  openProject: (projectId: string) => void;
  openChat: (projectId: string) => void;
  openSession: (projectId: string, sessionId: string) => void;
}

export const useNav = create<NavState>((set) => ({
  // Projects is the landing screen — the work, not the plumbing.
  screen: 'projects',
  projectId: null,
  sessionId: null,
  deployId: null,
  goConnections: () => set({ screen: 'connections', sessionId: null }),
  goProjects: () => set({ screen: 'projects', projectId: null, sessionId: null }),
  goConnectors: () => set({ screen: 'connectors', sessionId: null }),
  openDeploys: (deployId) => set({ screen: 'deploys', deployId: deployId ?? null, sessionId: null }),
  openProject: (projectId) => set({ screen: 'project', projectId, sessionId: null }),
  openChat: (projectId) => set({ screen: 'chat', projectId, sessionId: null }),
  openSession: (projectId, sessionId) => set({ screen: 'session', projectId, sessionId }),
}));
