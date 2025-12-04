import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  auth: {
    login: (pin: string) => ipcRenderer.invoke("auth:login", pin),
  },
  products: {
    getAll: () => ipcRenderer.invoke("products:getAll"),
    findBySkuOrBarcode: (q: string) =>
      ipcRenderer.invoke("products:findBySkuOrBarcode", q),
    create: (data: any) => ipcRenderer.invoke("products:create", data),
    update: (id: number, data: any) =>
      ipcRenderer.invoke("products:update", id, data),
    softDelete: (id: number, reason: string, userId: number) =>
      ipcRenderer.invoke("products:softDelete", id, reason, userId),
  },
  cash: {
    getActiveSession: () => ipcRenderer.invoke("cash:getActiveSession"),
    openSession: (initialAmount: number, userId: number) =>
      ipcRenderer.invoke("cash:openSession", initialAmount, userId),
    closeSession: (sessionId: number, realTotal: number, userId: number) =>
      ipcRenderer.invoke("cash:closeSession", sessionId, realTotal, userId),
    addMovement: (data: any) => ipcRenderer.invoke("cash:addMovement", data),
    getMovements: (sessionId: number) =>
      ipcRenderer.invoke("cash:getMovements", sessionId),
  },
  sales: {
    create: (data: any) => ipcRenderer.invoke("sales:create", data),
    getAll: () => ipcRenderer.invoke("sales:getAll"),
    getById: (id: number) => ipcRenderer.invoke("sales:getById", id),
  },
  returns: {
    create: (data: any) => ipcRenderer.invoke("returns:create", data),
    getAll: () => ipcRenderer.invoke("returns:getAll"),
  },
  users: {
    getAll: () => ipcRenderer.invoke("users:getAll"),
    create: (data: any) => ipcRenderer.invoke("users:create", data),
    update: (id: number, data: any) =>
      ipcRenderer.invoke("users:update", id, data),
    delete: (id: number) => ipcRenderer.invoke("users:delete", id),
  },
  inventory: {
    getMovements: (productId?: number) =>
      ipcRenderer.invoke("inventory:getMovements", productId),
    addMovement: (data: any) =>
      ipcRenderer.invoke("inventory:addMovement", data),
  },
  priceChanges: {
    create: (data: any) => ipcRenderer.invoke("priceChanges:create", data),
    getAll: () => ipcRenderer.invoke("priceChanges:getAll"),
  },
  reports: {
    getSalesByDateRange: (startDate: string, endDate: string) =>
      ipcRenderer.invoke("reports:getSalesByDateRange", startDate, endDate),
    getDeletedProducts: () => ipcRenderer.invoke("reports:getDeletedProducts"),
  },
});
