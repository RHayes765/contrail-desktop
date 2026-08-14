import type { ContrailBridge } from '@contrail/shared';

declare global {
  interface Window {
    contrail: ContrailBridge;
  }
}

/** The typed IPC client — the renderer's only door to the main process. */
export const ipc: ContrailBridge = window.contrail;
