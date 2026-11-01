import { contextBridge, ipcRenderer } from "electron";

// The only bridge of the maintenance window (`Beauty POS.exe --manage`). It never returns a password, a PIN or a hash.
contextBridge.exposeInMainWorld("manageApi", {
  getState: () => ipcRenderer.invoke("manage:getState"),
  backup: () => ipcRenderer.invoke("manage:backup"),
  updateSchema: () => ipcRenderer.invoke("manage:updateSchema"),
  resetDemo: (request: unknown) => ipcRenderer.invoke("manage:resetDemo", request),
  onStep: (callback: (step: unknown) => void) => {
    ipcRenderer.on("manage:step", (_event, step) => callback(step));
  },
});
