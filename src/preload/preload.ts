import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  auth: {
    login: (pin: string) => ipcRenderer.invoke("auth:login", pin),
  },
  products: {
    findBySkuOrBarcode: (q: string) =>
      ipcRenderer.invoke("products:findBySkuOrBarcode", q),
  },
});
