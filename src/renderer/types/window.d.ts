export {};

declare global {
  interface Window {
    api: {
      auth: {
        login(pin: string): Promise<{
          id: number;
          name: string;
          role: "admin" | "vendor";
        } | null>;
        me(): Promise<{
          id: number;
          name: string;
          role: "admin" | "vendor";
        } | null>;
        logout(): Promise<boolean>;
      };
      products: {
        getAll(): Promise<any[]>;
        listAdmin(): Promise<any[]>;
        findBySkuOrBarcode(q: string): Promise<any | null>;
        create(data: any): Promise<any>;
        update(id: number, data: any): Promise<any>;
        softDelete(id: number, reason: string): Promise<boolean>;
      };
      cash: {
        getActiveSession(): Promise<any | null>;
        openSession(initialAmount: number): Promise<any>;
        closeSession(sessionId: number, realTotal: number): Promise<any>;
        addMovement(data: any): Promise<any>;
        getMovements(sessionId: number): Promise<any[]>;
      };
      sales: {
        create(data: any): Promise<any>;
        getAll(): Promise<any[]>;
        getById(id: number): Promise<any>;
        list(query?: any): Promise<any>;
        getDetail(id: number): Promise<any>;
      };
      receipts: {
        preview(saleId: number, copy?: boolean): Promise<{ html: string; width: "80" | "58"; folio: number }>;
        print(saleId: number, copy?: boolean): Promise<{ status: "printed" | "cancelled" | "failed"; message: string }>;
        listPrinters(): Promise<{ name: string; displayName: string }[]>;
      };
      settings: {
        getBusiness(): Promise<any>;
        updateBusiness(data: any): Promise<any>;
      };
      returns: {
        create(data: any): Promise<any>;
        getAll(): Promise<any[]>;
        getSaleForReturn(saleId: number): Promise<any>;
      };
      users: {
        getAll(): Promise<any[]>;
        create(data: any): Promise<any>;
        update(id: number, data: any): Promise<any>;
        delete(id: number): Promise<boolean>;
      };
      inventory: {
        getMovements(productId?: number): Promise<any[]>;
        addMovement(data: any): Promise<boolean>;
      };
      priceChanges: {
        create(data: any): Promise<boolean>;
        getAll(productId?: number): Promise<any[]>;
      };
      reports: {
        getSalesByDateRange(startDate: string, endDate: string): Promise<any[]>;
        getDeletedProducts(): Promise<any[]>;
        getSummary(range: { from: string; to: string }): Promise<any>;
      };
      dashboard: {
        getStats(): Promise<any>;
      };
    };
  }
}
