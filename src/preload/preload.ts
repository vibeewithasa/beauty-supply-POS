import { contextBridge, ipcRenderer } from "electron";

// Every call goes through here so a lost session is handled in one place. The main process answers
// "Sesión no válida" only when there is no session or it was revoked (see src/backend/auth.ts); that
// signals the renderer to go back to the login. Role denials ("No autorizado"), DB or network errors
// do NOT trigger it.
function invoke(channel: string, ...args: unknown[]) {
  return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
    if (channel !== "auth:login" && /Sesión no válida/.test(String((err as Error)?.message ?? err))) {
      window.dispatchEvent(new Event("pos:session-expired"));
    }
    throw err;
  });
}

contextBridge.exposeInMainWorld("api", {
  auth: {
    login: (pin: string) => invoke("auth:login", pin),
    me: () => invoke("auth:me"),
    logout: () => invoke("auth:logout"),
  },
  products: {
    getAll: () => invoke("products:getAll"),
    listAdmin: () => invoke("products:listAdmin"),
    findBySkuOrBarcode: (q: string) =>
      invoke("products:findBySkuOrBarcode", q),
    create: (data: any) => invoke("products:create", data),
    update: (id: number, data: any) =>
      invoke("products:update", id, data),
    softDelete: (id: number, reason: string) =>
      invoke("products:softDelete", id, reason),
  },
  cash: {
    getActiveSession: () => invoke("cash:getActiveSession"),
    openSession: (initialAmount: number) =>
      invoke("cash:openSession", initialAmount),
    closeSession: (sessionId: number, realTotal: number) =>
      invoke("cash:closeSession", sessionId, realTotal),
    addMovement: (data: any) => invoke("cash:addMovement", data),
    getMovements: (sessionId: number) =>
      invoke("cash:getMovements", sessionId),
  },
  sales: {
    create: (data: any) => invoke("sales:create", data),
    getAll: () => invoke("sales:getAll"),
    getById: (id: number) => invoke("sales:getById", id),
  },
  returns: {
    create: (data: any) => invoke("returns:create", data),
    getAll: () => invoke("returns:getAll"),
    getSaleForReturn: (saleId: number) => invoke("returns:getSaleForReturn", saleId),
  },
  users: {
    getAll: () => invoke("users:getAll"),
    create: (data: any) => invoke("users:create", data),
    update: (id: number, data: any) =>
      invoke("users:update", id, data),
    delete: (id: number) => invoke("users:delete", id),
  },
  inventory: {
    getMovements: (productId?: number) =>
      invoke("inventory:getMovements", productId),
    addMovement: (data: any) =>
      invoke("inventory:addMovement", data),
  },
  priceChanges: {
    create: (data: any) => invoke("priceChanges:create", data),
    getAll: (productId?: number) => invoke("priceChanges:getAll", productId),
  },
  reports: {
    getSalesByDateRange: (startDate: string, endDate: string) =>
      invoke("reports:getSalesByDateRange", startDate, endDate),
    getDeletedProducts: () => invoke("reports:getDeletedProducts"),
    getSummary: (range: { from: string; to: string }) => invoke("reports:getSummary", range),
  },
  dashboard: {
    getStats: () => invoke("dashboard:getStats"),
  },
});
