import { create } from 'zustand';
import type { ProjectManifestView } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

/**
 * Project-manifest state (S28): the per-project change record, loaded lazily
 * by the Manifest tab (S18 skills-store shape — a manifest can be large, so
 * it is never fetched on plain project open).
 */

interface ManifestState {
  projectId: string | null;
  view: ProjectManifestView | null;
  error: string | null;

  loadProject: (projectId: string) => Promise<void>;
  clearError: () => void;
}

export const useManifest = create<ManifestState>((set) => ({
  projectId: null,
  view: null,
  error: null,

  loadProject: async (projectId) => {
    try {
      const view = await ipc.invoke('manifest:list', { projectId });
      set({ projectId, view, error: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  clearError: () => set({ error: null }),
}));
