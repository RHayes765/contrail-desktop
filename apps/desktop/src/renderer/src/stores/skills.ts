import { create } from 'zustand';
import type { ProjectSkillsView, SkillView } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

/**
 * Skill-library state: the universal library and the per-project selection
 * panel. Mutators return booleans so form drafts survive failures (house
 * pattern, same as the MCP store).
 */

interface SkillsState {
  library: SkillView[] | null;
  projectId: string | null;
  project: ProjectSkillsView | null;
  error: string | null;

  refreshLibrary: () => Promise<void>;
  loadProject: (projectId: string) => Promise<void>;
  clearError: () => void;
  addViaDialog: () => Promise<boolean>;
  removeSkill: (id: string) => Promise<boolean>;
  setDefaultOn: (id: string, defaultOn: boolean) => Promise<boolean>;
  setToggle: (projectId: string, skillKey: string, enabled: boolean) => Promise<boolean>;
}

export const useSkills = create<SkillsState>((set, get) => ({
  library: null,
  projectId: null,
  project: null,
  error: null,

  refreshLibrary: async () => {
    try {
      set({ library: await ipc.invoke('skills:list', {}), error: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  loadProject: async (projectId) => {
    try {
      const project = await ipc.invoke('skills:project', { projectId });
      set({ projectId, project, error: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  clearError: () => set({ error: null }),

  addViaDialog: async () => {
    try {
      await ipc.invoke('skills:add', {});
      await get().refreshLibrary();
      await refreshProjectPanel(set, get);
      return true;
    } catch (err) {
      // A cancelled picker is not an error worth a banner.
      if (String(err).includes('No folder chosen')) return false;
      set({ error: String(err) });
      return false;
    }
  },

  removeSkill: async (id) => {
    try {
      await ipc.invoke('skills:remove', { id });
      await get().refreshLibrary();
      await refreshProjectPanel(set, get);
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },

  setDefaultOn: async (id, defaultOn) => {
    try {
      await ipc.invoke('skills:setDefaultOn', { id, defaultOn });
      await get().refreshLibrary();
      await refreshProjectPanel(set, get);
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },

  setToggle: async (projectId, skillKey, enabled) => {
    try {
      const project = await ipc.invoke('skills:setToggle', { projectId, skillKey, enabled });
      set({ projectId, project, error: null });
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },
}));

/** Silent refresh of the per-project panel after a library change (see mcp.ts). */
async function refreshProjectPanel(
  set: (partial: Partial<SkillsState>) => void,
  get: () => SkillsState,
): Promise<void> {
  const pid = get().projectId;
  if (!pid) return;
  try {
    set({ project: await ipc.invoke('skills:project', { projectId: pid }) });
  } catch {
    set({ projectId: null, project: null });
  }
}
