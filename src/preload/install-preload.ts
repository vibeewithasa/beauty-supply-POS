import { contextBridge, ipcRenderer } from "electron";

// The only bridge of the first-installation wizard. PINs travel once to the main process and are never returned.
// (The application's own renderer uses src/preload/preload.ts and never sees these channels.)
contextBridge.exposeInMainWorld("installApi", {
  getState: () => ipcRenderer.invoke("install:getState"),
  run: (request: unknown) => ipcRenderer.invoke("install:run", request),
  advanced: () => ipcRenderer.invoke("install:advanced"),
  onStep: (callback: (step: unknown) => void) => {
    ipcRenderer.on("install:step", (_event, step) => callback(step));
  },
});
