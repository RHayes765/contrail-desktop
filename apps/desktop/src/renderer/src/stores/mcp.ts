import { create } from 'zustand';
import type { CustomMcpServerView, McpServerTestView, ProjectMcpView } from '@contrail/shared';
import { ipc } from '../lib/ipc.js';

/**
 * MCP configuration state: the global external-server registry and the
 * per-project catalog/connector toggle panel. Mutators return booleans so
 * form drafts survive failures (house pattern).
 */

interface McpState {
  servers: CustomMcpServerView[] | null;
  /** Toggle panel for the project currently open; keyed check via projectId. */
  projectId: string | null;
  project: ProjectMcpView | null;
  error: string | null;
  /** Connection-test outcomes by server id ('testing' while in flight). */
  testResults: Record<string, McpServerTestView | 'testing'>;

  refreshServers: () => Promise<void>;
  loadProject: (projectId: string) => Promise<void>;
  clearError: () => void;
  testServer: (id: string) => Promise<void>;
  setToggle: (projectId: string, serverKey: string, enabled: boolean) => Promise<boolean>;
  addServer: (req: {
    name: string;
    transport: 'stdio' | 'http' | 'sse';
    urlOrCommand: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
  }) => Promise<CustomMcpServerView | null>;
  setServerEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  removeServer: (id: string) => Promise<boolean>;
}

export const useMcp = create<McpState>((set, get) => ({
  servers: null,
  projectId: null,
  project: null,
  error: null,
  testResults: {},

  refreshServers: async () => {
    try {
      set({ servers: await ipc.invoke('mcp:servers:list', {}), error: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  clearError: () => set({ error: null }),

  testServer: async (id) => {
    set({ testResults: { ...get().testResults, [id]: 'testing' } });
    try {
      const result = await ipc.invoke('mcp:servers:test', { id });
      set({ testResults: { ...get().testResults, [id]: result } });
    } catch (err) {
      set({
        testResults: {
          ...get().testResults,
          [id]: { status: 'failed', detail: String(err), tools: [] },
        },
      });
    }
  },

  loadProject: async (projectId) => {
    try {
      const project = await ipc.invoke('mcp:project', { projectId });
      set({ projectId, project, error: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  setToggle: async (projectId, serverKey, enabled) => {
    try {
      const project = await ipc.invoke('mcp:setToggle', { projectId, serverKey, enabled });
      set({ projectId, project, error: null });
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },

  addServer: async (req) => {
    try {
      const created = await ipc.invoke('mcp:servers:add', req);
      await get().refreshServers();
      return created;
    } catch (err) {
      set({ error: String(err) });
      return null;
    }
  },

  setServerEnabled: async (id, enabled) => {
    try {
      await ipc.invoke('mcp:servers:update', { id, enabled });
      await get().refreshServers();
      await refreshProjectPanel(set, get);
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },

  removeServer: async (id) => {
    try {
      await ipc.invoke('mcp:servers:remove', { id });
      await get().refreshServers();
      await refreshProjectPanel(set, get);
      return true;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },
}));

/**
 * Background refresh of the per-project panel after a registry change. The
 * remembered project may have been deleted since its tab was open — that is
 * NOT an error of the action the user just took, so a failed refresh clears
 * the stale panel silently instead of surfacing a phantom message.
 */
async function refreshProjectPanel(
  set: (partial: Partial<McpState>) => void,
  get: () => McpState,
): Promise<void> {
  const pid = get().projectId;
  if (!pid) return;
  try {
    set({ project: await ipc.invoke('mcp:project', { projectId: pid }) });
  } catch {
    set({ projectId: null, project: null });
  }
}
