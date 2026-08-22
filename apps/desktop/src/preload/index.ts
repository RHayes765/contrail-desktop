import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * The entire bridge surface: typed invoke + push subscription. Nothing else
 * is exposed — no fs, no shell, no raw ipcRenderer. Channel names are opaque
 * strings here; type safety lives in @contrail/shared's ContrailBridge,
 * which the renderer casts window.contrail to.
 */
contextBridge.exposeInMainWorld('contrail', {
  invoke: (channel: string, req: unknown) => ipcRenderer.invoke(channel, req),
  /**
   * Absolute path of a dropped File. Electron removed File.path from the
   * renderer; webUtils is the sanctioned bridge. Path-only — no fs access is
   * exposed, and main still validates/copies the file itself.
   */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  subscribe: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
