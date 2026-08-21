/**
 * Vitest stand-in for the 'electron' module — the services under test import
 * electron at module scope (dialog, shell, utilityProcess), but the units we
 * test (silo executor, redaction, doc-path guards) never touch them.
 */
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
};
export const shell = { openExternal: async () => undefined };
export const utilityProcess = {
  fork: () => {
    throw new Error('utilityProcess is not available in unit tests');
  },
};
export class BrowserWindow {}
export const app = {};

/**
 * Minimal ipcMain that records handlers so a test can drive the real IPC
 * registry: register, then `_invoke(channel, payload)` runs exactly what a
 * renderer message would, validation gate and all.
 */
type IpcHandler = (event: unknown, req: unknown) => unknown;
const ipcHandlers = new Map<string, IpcHandler>();
export const ipcMain = {
  handle(channel: string, handler: IpcHandler): void {
    ipcHandlers.set(channel, handler);
  },
  removeHandler(channel: string): void {
    ipcHandlers.delete(channel);
  },
  /** Test hook: invoke a registered channel the way the renderer would. */
  _invoke(channel: string, req: unknown): unknown {
    const handler = ipcHandlers.get(channel);
    if (!handler) throw new Error(`no handler registered for ${channel}`);
    return handler({}, req);
  },
  /** Test hook: the set of channels currently registered. */
  _channels(): string[] {
    return [...ipcHandlers.keys()];
  },
  /** Test hook: clear between tests. */
  _reset(): void {
    ipcHandlers.clear();
  },
};
