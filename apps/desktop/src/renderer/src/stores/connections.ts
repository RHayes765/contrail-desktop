import { create } from 'zustand';
import type {
  ConnectionView,
  GrantSetView,
  PingResultView,
  SnapshotStatusView,
} from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

interface ConnectionsState {
  connections: ConnectionView[] | null;
  /** Last liveness check per connection id. */
  pings: Record<string, PingResultView>;
  /** Snapshot posture per connection id (loaded with the list, updated by pushes). */
  snapshots: Record<string, SnapshotStatusView>;
  /** Last sync failure per connection id — cleared when a new sync starts. */
  syncErrors: Record<string, string>;
  /** Human-readable outcome of the last connect attempt (toast-ish). */
  connectMessage: string | null;
  connecting: boolean;
  refresh: () => Promise<void>;
  connect: (login: string | undefined, label: string | undefined) => Promise<void>;
  remove: (id: string) => Promise<void>;
  ping: (id: string) => Promise<void>;
  /** Returns true on success — the editor stays open (with the error) on false. */
  setGrants: (id: string, grants: GrantSetView) => Promise<boolean>;
  syncSnapshot: (id: string) => Promise<void>;
  refreshSnapshotStatus: (id: string) => Promise<void>;
  clearConnectMessage: () => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  connections: null,
  pings: {},
  snapshots: {},
  syncErrors: {},
  connectMessage: null,
  connecting: false,

  refresh: async () => {
    const connections = await ipc.invoke('connections:list', {});
    set({ connections });
    // Snapshot posture rides along; failures leave the previous entry.
    const statuses = await Promise.all(
      connections.map((c) =>
        ipc.invoke('metadata:status', { connectionId: c.id }).catch(() => null),
      ),
    );
    set((s) => {
      const snapshots = { ...s.snapshots };
      for (const status of statuses) if (status) snapshots[status.connectionId] = status;
      return { snapshots };
    });
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

  syncSnapshot: async (id) => {
    set((s) => {
      const syncErrors = { ...s.syncErrors };
      delete syncErrors[id];
      return { syncErrors };
    });
    try {
      await ipc.invoke('metadata:sync', { connectionId: id });
    } catch (err) {
      set((s) => ({ syncErrors: { ...s.syncErrors, [id]: String(err) } }));
    }
  },

  refreshSnapshotStatus: async (id) => {
    try {
      const status = await ipc.invoke('metadata:status', { connectionId: id });
      set((s) => ({ snapshots: { ...s.snapshots, [id]: status } }));
    } catch {
      // Transient failure — but never leave a card stuck on 'Syncing…'.
      set((s) => {
        const existing = s.snapshots[id];
        if (!existing?.syncing) return {};
        return {
          snapshots: { ...s.snapshots, [id]: { ...existing, syncing: false, progress: null } },
        };
      });
    }
  },

  clearConnectMessage: () => set({ connectMessage: null }),
}));

// The main process announces connection changes (including a browser OAuth
// flow finishing minutes after the connect call returned 'pending').
ipc.subscribe('connections:changed', () => {
  void useConnections.getState().refresh();
});

// Live sync progress: patch the status inline; on done, re-fetch the real one
// and surface any failure — a silent revert reads as "nothing happened".
ipc.subscribe('metadata:progress', ({ connectionId, progress, done, error }) => {
  const state = useConnections.getState();
  if (done) {
    if (error) {
      useConnections.setState({
        syncErrors: { ...state.syncErrors, [connectionId]: error },
      });
    }
    void state.refreshSnapshotStatus(connectionId);
    return;
  }
  const existing = state.snapshots[connectionId];
  useConnections.setState({
    snapshots: {
      ...state.snapshots,
      [connectionId]: existing
        ? { ...existing, syncing: true, progress }
        : {
            connectionId,
            artifactCount: 0,
            edgeCount: 0,
            lastIndexedAt: null,
            syncing: true,
            progress,
            stale: false,
          },
    },
  });
});
