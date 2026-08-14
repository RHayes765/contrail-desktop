import { create } from 'zustand';

/**
 * Screen routing. Deliberately a store, not a router — three screens and a
 * detail/chat drill-in don't earn a URL scheme in a desktop shell.
 */

export type Screen = 'connections' | 'projects' | 'project' | 'chat';

interface NavState {
  screen: Screen;
  /** Set when screen is 'project' or 'chat'. */
  projectId: string | null;
  goConnections: () => void;
  goProjects: () => void;
  openProject: (projectId: string) => void;
  openChat: (projectId: string) => void;
}

export const useNav = create<NavState>((set) => ({
  screen: 'connections',
  projectId: null,
  goConnections: () => set({ screen: 'connections' }),
  goProjects: () => set({ screen: 'projects', projectId: null }),
  openProject: (projectId) => set({ screen: 'project', projectId }),
  openChat: (projectId) => set({ screen: 'chat', projectId }),
}));
