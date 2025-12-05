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
      };
      products: {
        getAll(): Promise<any[]>;
        findBySkuOrBarcode(q: string): Promise<any | null>;
        create(data: any): Promise<any>;
        update(id: number, data: any): Promise<any>;
        softDelete(
          id: number,
          reason: string,
          userId: number
        ): Promise<boolean>;
      };
      cash: {
        getActiveSession(): Promise<any | null>;
        openSession(initialAmount: number, userId: number): Promise<any>;
        closeSession(
          sessionId: number,
          realTotal: number,
          userId: number
        ): Promise<any>;
        addMovement(data: any): Promise<any>;
        getMovements(sessionId: number): Promise<any[]>;
      };
      sales: {
        create(data: any): Promise<any>;
        getAll(): Promise<any[]>;
        getById(id: number): Promise<any>;
      };
      returns: {
        create(data: any): Promise<any>;
        getAll(): Promise<any[]>;
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
        getAll(): Promise<any[]>;
      };
      reports: {
        getSalesByDateRange(startDate: string, endDate: string): Promise<any[]>;
        getDeletedProducts(): Promise<any[]>;
      };
      dashboard: {
        getStats(): Promise<any>;
      };
    };
  }
}
