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
