import { create } from 'zustand';
import type { ConnectionView, GrantSetView, PingResultView } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

interface ConnectionsState {
  connections: ConnectionView[] | null;
  /** Last liveness check per connection id. */
  pings: Record<string, PingResultView>;
  /** Human-readable outcome of the last connect attempt (toast-ish). */
  connectMessage: string | null;
  connecting: boolean;
  refresh: () => Promise<void>;
  connect: (login: string | undefined, label: string | undefined) => Promise<void>;
  remove: (id: string) => Promise<void>;
  ping: (id: string) => Promise<void>;
  /** Returns true on success — the editor stays open (with the error) on false. */
  setGrants: (id: string, grants: GrantSetView) => Promise<boolean>;
  clearConnectMessage: () => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  connections: null,
  pings: {},
  connectMessage: null,
  connecting: false,

  refresh: async () => {
    set({ connections: await ipc.invoke('connections:list', {}) });
  },

  connect: async (login, label) => {
    set({ connecting: true, connectMessage: null });
    try {
      const outcome = await ipc.invoke('connections:connect', { login, label });
      set({ connectMessage: outcome.message });
      if (outcome.status === 'connected') await get().refresh();
    } catch (err) {
      set({ connectMessage: String(err) });
    } finally {
      set({ connecting: false });
    }
  },

  remove: async (id) => {
    const result = await ipc.invoke('connections:remove', { id });
    set({ connectMessage: result.detail });
    await get().refresh();
  },

  ping: async (id) => {
    try {
      const result = await ipc.invoke('connections:ping', { id });
      set((s) => ({ pings: { ...s.pings, [id]: result } }));
    } catch (err) {
      set((s) => ({
        pings: { ...s.pings, [id]: { status: 'unreachable', detail: String(err) } },
      }));
    }
  },

  setGrants: async (id, grants) => {
    try {
      await ipc.invoke('connections:setGrants', { id, grants });
      await get().refresh();
      return true;
    } catch (err) {
      set({ connectMessage: String(err) });
      return false;
    }
  },

  clearConnectMessage: () => set({ connectMessage: null }),
}));

// The main process announces connection changes (including a browser OAuth
// flow finishing minutes after the connect call returned 'pending').
ipc.subscribe('connections:changed', () => {
  void useConnections.getState().refresh();
});
