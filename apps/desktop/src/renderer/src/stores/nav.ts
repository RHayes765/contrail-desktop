import { create } from 'zustand';

/**
 * Screen routing. Deliberately a store, not a router — three screens and a
 * detail/chat drill-in don't earn a URL scheme in a desktop shell.
 */

export type Screen = 'connections' | 'projects' | 'project' | 'chat' | 'session';

interface NavState {
  screen: Screen;
  /** Set when screen is 'project', 'chat', or 'session'. */
  projectId: string | null;
  /** Set when screen is 'session' (read-only transcript view). */
  sessionId: string | null;
  goConnections: () => void;
  goProjects: () => void;
  openProject: (projectId: string) => void;
  openChat: (projectId: string) => void;
  openSession: (projectId: string, sessionId: string) => void;
}

export const useNav = create<NavState>((set) => ({
  screen: 'connections',
  projectId: null,
  sessionId: null,
  goConnections: () => set({ screen: 'connections', sessionId: null }),
  goProjects: () => set({ screen: 'projects', projectId: null, sessionId: null }),
  openProject: (projectId) => set({ screen: 'project', projectId, sessionId: null }),
  openChat: (projectId) => set({ screen: 'chat', projectId, sessionId: null }),
  openSession: (projectId, sessionId) => set({ screen: 'session', projectId, sessionId }),
}));
