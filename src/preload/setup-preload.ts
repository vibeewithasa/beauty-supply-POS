import { contextBridge, ipcRenderer } from "electron";

// The only bridge of the first-run setup window: four calls, nothing else. The password goes to the main process once and is
// never returned. (The application's own renderer uses src/preload/preload.ts and never sees these channels.)
contextBridge.exposeInMainWorld("setupApi", {
  getState: () => ipcRenderer.invoke("setup:getState"),
  inspect: (connection: unknown) => ipcRenderer.invoke("setup:inspect", connection),
  save: (connection: unknown) => ipcRenderer.invoke("setup:save", connection),
  createAdmin: (data: unknown) => ipcRenderer.invoke("setup:createAdmin", data),
});
