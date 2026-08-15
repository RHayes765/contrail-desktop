import { create } from 'zustand';
import type { DeployRequestView } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

/**
 * Deploy requests + the review panel. Approve/reject return booleans so the
 * comment draft survives failures (house pattern). Approving BLOCKS until
 * the deploy reaches a terminal state — busy flags carry the UI through.
 */

interface DeploysState {
  requests: DeployRequestView[] | null;
  /** The request open in the review panel. */
  current: DeployRequestView | null;
  /** An approve/reject is in flight for this id. */
  deciding: string | null;
  error: string | null;

  refresh: () => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => void;
  approve: (id: string, comment: string) => Promise<boolean>;
  reject: (id: string, comment: string) => Promise<boolean>;
  clearError: () => void;
}

export const useDeploys = create<DeploysState>((set, get) => ({
  requests: null,
  current: null,
  deciding: null,
  error: null,

  refresh: async () => {
    try {
      const requests = await ipc.invoke('deploys:list', {});
      set({ requests });
      const current = get().current;
      if (current) {
        const updated = requests.find((r) => r.id === current.id);
        if (updated) set({ current: updated });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  open: async (id) => {
    try {
      set({ current: await ipc.invoke('deploys:get', { id }), error: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  close: () => set({ current: null }),

  approve: async (id, comment) => {
    set({ deciding: id, error: null });
    try {
      const view = await ipc.invoke('deploys:approve', {
        id,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      set({ current: view, deciding: null });
      await get().refresh();
      return true;
    } catch (err) {
      set({ error: String(err), deciding: null });
      return false;
    }
  },

  reject: async (id, comment) => {
    set({ deciding: id, error: null });
    try {
      const view = await ipc.invoke('deploys:reject', {
        id,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      set({ current: view, deciding: null });
      await get().refresh();
      return true;
    } catch (err) {
      set({ error: String(err), deciding: null });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));

// Any state change (presented, approved, executing, terminal) refreshes.
ipc.subscribe('deploys:changed', () => {
  void useDeploys.getState().refresh();
});
