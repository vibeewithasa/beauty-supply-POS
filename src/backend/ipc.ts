import { db } from "./db";
import {
  products as productsTable,
  users as usersTable,
  sales as salesTable,
  cashSessions as cashSessionsTable,
  cashMovements as cashMovementsTable,
  returns as returnsTable,
  deletedProductsLog as deletedProductsLogTable,
} from "./schema";
import { eq, or, and, desc, sql, gte, lte, isNull } from "drizzle-orm";
import { registerAuthHandlers, secureHandle } from "./auth";
import { createUser, deactivateUser, listActiveUsers, updateUser } from "./users-service";
import { createReturn } from "./returns-service";
import {
  getSaleForReturn,
  listAllProducts,
  listMovements,
  listPriceChanges,
  listReturns,
  salesByRange,
  salesSummary,
} from "./read-service";
import {
  addInventoryMovement,
  createPriceChange,
  createProduct,
  updateProduct,
} from "./catalog-service";
import {
  addCashMovement,
  closeCashSession,
  createSale,
  openCashSession,
  softDeleteProduct,
} from "./pos-service";
import { getSaleDetail, legacyListSales, legacySaleById, listSales } from "./sales-history";
import { getBusinessSettings, updateBusinessSettings } from "./settings-service";
import { listPrinters, previewCashSummary, previewReceipt, printCashSummary, printReceipt } from "./receipt-service";
import { getCashSessionSummary, listCashSessions } from "./cash-summary";
import type { Access, IpcContext } from "./auth";

// Access policy for every protected channel. A channel without an entry cannot
// be registered (deny by default). Public channels (auth:*) live in auth.ts.
const ACCESS: Record<string, Access> = {
  "products:getAll": "authenticated",
  "products:listAdmin": "admin",
  "products:findBySkuOrBarcode": "authenticated",
  "products:create": "admin",
  "products:update": "admin",
  "products:softDelete": "admin",
  "cash:getActiveSession": "authenticated",
  "cash:openSession": "authenticated",
  "cash:closeSession": "authenticated",
  "cash:addMovement": "authenticated",
  "cash:getMovements": "authenticated",
  "sales:create": "authenticated",
  // PRODUCT DECISION PENDING: should vendors read the full sales history and process returns?
  // (returns:create, returns:getAll and returns:getSaleForReturn are still open to any authenticated user: owner decision pending.)
  // sales:getAll / sales:getById are authenticated but limited to the caller's own sales for vendors (enforced in main).
  "sales:getAll": "authenticated",
  "sales:getById": "authenticated",
  // history and receipts: authenticated, but a vendor only ever sees the sales they made (enforced in main)
  "sales:list": "authenticated",
  "sales:getDetail": "authenticated",
  "receipts:preview": "authenticated",
  "receipts:print": "authenticated",
  "receipts:listPrinters": "admin",
  // cash-register history and closing summaries: authenticated; a vendor sees the open session and the ones they opened/closed
  "cash:listSessions": "authenticated",
  "cash:getSessionSummary": "authenticated",
  "cash:previewSummary": "authenticated",
  "cash:printSummary": "authenticated",
  "settings:getBusiness": "admin",
  "settings:updateBusiness": "admin",
  "returns:create": "authenticated",
  "returns:getAll": "authenticated",
  "returns:getSaleForReturn": "authenticated",
  "users:getAll": "admin",
  "users:create": "admin",
  "users:update": "admin",
  "users:delete": "admin",
  "inventory:getMovements": "admin",
  "inventory:addMovement": "admin",
  "priceChanges:create": "admin",
  "priceChanges:getAll": "admin",
  "reports:getSalesByDateRange": "admin",
  "reports:getDeletedProducts": "admin",
  "reports:getSummary": "admin",
  "dashboard:getStats": "admin",
};

function handle<A extends unknown[], R>(
  channel: string,
  fn: (ctx: IpcContext, ...args: A) => Promise<R> | R
) {
  const access = ACCESS[channel];
  if (!access) throw new Error("Sin política de acceso para " + channel);
  secureHandle(channel, access, fn);
}

export function registerIpcHandlers() {
  registerAuthHandlers();

  // ============= PRODUCTS =============
  handle("products:getAll", async () => {
    return await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.status, "active"))
      .orderBy(productsTable.name);
  });

  // administrators only: inactive and logically deleted products too (sellers keep seeing active ones only)
  handle("products:listAdmin", async () => listAllProducts());

  handle("products:findBySkuOrBarcode", async (ctx, q: string) => {
    const rows = await db
      .select()
      .from(productsTable)
      .where(
        and(
          or(eq(productsTable.sku, q), eq(productsTable.barcode, q)),
          eq(productsTable.status, "active")
        )
      )
      .limit(1);
    return rows[0] ?? null;
  });

  handle("products:create", async (ctx, data: unknown) =>
    createProduct(ctx.user.id, data)
  );

  handle("products:update", async (_ctx, id: unknown, data: unknown) =>
    updateProduct(id, data)
  );

  handle("products:softDelete", async (ctx, id: unknown, reason: unknown) =>
    softDeleteProduct(ctx.user.id, id, reason)
  );

  // ============= CASH SESSIONS =============
  handle("cash:getActiveSession", async () => {
    const [session] = await db
      .select()
      .from(cashSessionsTable)
      .where(isNull(cashSessionsTable.closedAt))
      .orderBy(desc(cashSessionsTable.openedAt))
      .limit(1);
    return session ?? null;
  });

  handle("cash:openSession", async (ctx, initialAmount: unknown) =>
    openCashSession(ctx.user.id, initialAmount)
  );

  handle("cash:closeSession", async (ctx, sessionId: unknown, realTotal: unknown) =>
    closeCashSession(ctx.user.id, sessionId, realTotal)
  );

  handle("cash:addMovement", async (ctx, data: unknown) =>
    addCashMovement(ctx.user.id, data)
  );

  handle("cash:getMovements", async (ctx, sessionId: number) => {
    return await db
      .select({
        id: cashMovementsTable.id,
        sessionId: cashMovementsTable.sessionId,
        type: cashMovementsTable.type,
        amount: cashMovementsTable.amount,
        reason: cashMovementsTable.reason,
        userId: cashMovementsTable.userId,
        createdAt: cashMovementsTable.createdAt,
        userName: usersTable.name,
      })
      .from(cashMovementsTable)
      .leftJoin(usersTable, eq(cashMovementsTable.userId, usersTable.id))
      .where(eq(cashMovementsTable.sessionId, sessionId))
      .orderBy(desc(cashMovementsTable.createdAt));
  });

  handle("cash:listSessions", async (ctx, query: unknown) => listCashSessions(ctx.user, query));
  handle("cash:getSessionSummary", async (ctx, id: unknown) => getCashSessionSummary(ctx.user, id));
  handle("cash:previewSummary", async (ctx, id: unknown) => previewCashSummary(ctx.user, id));
  handle("cash:printSummary", async (ctx, id: unknown) => printCashSummary(ctx.user, id));

  // ============= SALES =============
  handle("sales:create", async (ctx, data: unknown) =>
    createSale(ctx.user.id, data)
  );

  // Original channels, kept for compatibility but under the same rule as the history: a vendor only sees their own sales.
  handle("sales:getAll", async (ctx) => legacyListSales(ctx.user));

  handle("sales:getById", async (ctx, id: unknown) => legacySaleById(ctx.user, id));

  // ============= SALES HISTORY, RECEIPTS, SETTINGS =============
  handle("sales:list", async (ctx, query: unknown) => listSales(ctx.user, query));
  handle("sales:getDetail", async (ctx, id: unknown) => getSaleDetail(ctx.user, id));
  handle("receipts:preview", async (ctx, saleId: unknown, copy?: unknown) => previewReceipt(ctx.user, saleId, copy));
  handle("receipts:print", async (ctx, saleId: unknown, copy?: unknown) => printReceipt(ctx.user, saleId, copy));
  handle("receipts:listPrinters", async (ctx) => listPrinters(ctx.event));
  handle("settings:getBusiness", async () => getBusinessSettings());
  handle("settings:updateBusiness", async (ctx, data: unknown) => updateBusinessSettings(ctx.user.id, data));

  // ============= RETURNS =============
  handle("returns:create", async (ctx, data: unknown) =>
    createReturn(ctx.user.id, data)
  );

  handle("returns:getAll", async () => listReturns());

  // read-only lookup for the returns screen: sale lines, already returned and still returnable quantities
  handle("returns:getSaleForReturn", async (_ctx, saleId: unknown) => getSaleForReturn(saleId));

  // ============= USERS =============
  // active users only: "deleted" users are deactivated (their history is kept) and no longer listed
  handle("users:getAll", async () => listActiveUsers());

  handle("users:create", async (_ctx, data: unknown) => createUser(data));

  handle("users:update", async (_ctx, id: unknown, data: unknown) =>
    updateUser(id, data)
  );

  // logical deactivation, never a physical delete (history references users)
  handle("users:delete", async (ctx, id: unknown) => deactivateUser(ctx.user.id, id));

  // ============= INVENTORY =============
  handle("inventory:getMovements", async (_ctx, productId?: unknown) => listMovements(productId));

  handle("inventory:addMovement", async (ctx, data: unknown) =>
    addInventoryMovement(ctx.user.id, data)
  );

  // ============= PRICE CHANGES =============
  handle("priceChanges:create", async (ctx, data: unknown) =>
    createPriceChange(ctx.user.id, data)
  );

  handle("priceChanges:getAll", async (_ctx, productId?: unknown) => listPriceChanges(productId));

  // ============= REPORTS =============
  handle("reports:getSalesByDateRange", async (_ctx, startDate: unknown, endDate: unknown) =>
    salesByRange(startDate, endDate)
  );

  // real aggregated figures for the reports screen (dates validated in main)
  handle("reports:getSummary", async (_ctx, range: unknown) => salesSummary(range));

  handle("reports:getDeletedProducts", async () => {
    return await db
      .select({
        id: deletedProductsLogTable.id,
        productId: deletedProductsLogTable.productId,
        sku: deletedProductsLogTable.sku,
        name: deletedProductsLogTable.name,
        reason: deletedProductsLogTable.reason,
        deletedAt: deletedProductsLogTable.deletedAt,
        deletedByName: usersTable.name,
      })
      .from(deletedProductsLogTable)
      .leftJoin(
        usersTable,
        eq(deletedProductsLogTable.deletedBy, usersTable.id)
      )
      .orderBy(desc(deletedProductsLogTable.deletedAt));
  });

  // ============= DASHBOARD STATS =============
  handle("dashboard:getStats", async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Ventas de hoy
    const todaySalesResult = await db
      .select({
        total: sql<string>`COALESCE(SUM(${salesTable.total}::numeric), 0)`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(salesTable)
      .where(
        and(
          gte(salesTable.createdAt, today),
          lte(salesTable.createdAt, tomorrow)
        )
      );

    const todaySales = todaySalesResult[0];

    // Ventas por método de pago hoy
    const paymentMethodsResult = await db
      .select({
        paymentMethod: salesTable.paymentMethod,
        total: sql<string>`COALESCE(SUM(${salesTable.total}::numeric), 0)`,
      })
      .from(salesTable)
      .where(
        and(
          gte(salesTable.createdAt, today),
          lte(salesTable.createdAt, tomorrow)
        )
      )
      .groupBy(salesTable.paymentMethod);

    // Productos totales activos
    const productsResult = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
      })
      .from(productsTable)
      .where(eq(productsTable.status, "active"));

    // Productos con stock bajo (menos de 10)
    const lowStockResult = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
      })
      .from(productsTable)
      .where(
        and(
          eq(productsTable.status, "active"),
          sql`${productsTable.stock} < 10`
        )
      );

    // Usuarios activos
    const usersResult = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
      })
      .from(usersTable)
      .where(eq(usersTable.active, true));

    // Devoluciones de hoy, por estado de liquidación (pendiente != pagado)
    const returnsResult = await db
      .select({
        status: returnsTable.refundStatus,
        total: sql<string>`COALESCE(SUM(${returnsTable.totalRefund}::numeric), 0)`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(returnsTable)
      .where(
        and(
          gte(returnsTable.createdAt, today),
          lte(returnsTable.createdAt, tomorrow)
        )
      )
      .groupBy(returnsTable.refundStatus);
    const returnsBy = (status: string) => {
      const r = returnsResult.find((x) => x.status === status);
      return { total: r?.total || "0", count: r?.count || 0 };
    };
    const returnsAllTotal = returnsResult.reduce((a, x) => a + Number(x.total), 0);
    const returnsAllCount = returnsResult.reduce((a, x) => a + x.count, 0);

    // Stock total
    const stockResult = await db
      .select({
        total: sql<number>`COALESCE(SUM(${productsTable.stock}), 0)::int`,
      })
      .from(productsTable)
      .where(eq(productsTable.status, "active"));

    // Sesión de caja activa
    const activeSession = await db
      .select()
      .from(cashSessionsTable)
      .where(isNull(cashSessionsTable.closedAt))
      .orderBy(desc(cashSessionsTable.openedAt))
      .limit(1);

    // Última venta con tiempo relativo calculado en el servidor
    const lastSaleResult = await db
      .select({
        createdAt: salesTable.createdAt,
      })
      .from(salesTable)
      .orderBy(desc(salesTable.createdAt))
      .limit(1);

    let lastSaleText = "N/A";
    if (lastSaleResult[0]) {
      const now = new Date();
      const saleTime = new Date(lastSaleResult[0].createdAt);
      const diffMs = now.getTime() - saleTime.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 1) {
        lastSaleText = "Justo ahora";
      } else if (diffMins < 60) {
        lastSaleText = `Hace ${diffMins} min`;
      } else {
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) {
          lastSaleText = `Hace ${diffHours}h`;
        } else {
          const diffDays = Math.floor(diffHours / 24);
          lastSaleText = `Hace ${diffDays} ${diffDays === 1 ? "día" : "días"}`;
        }
      }
    }

    // Ventas de la semana
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const weekSalesResult = await db
      .select({
        total: sql<string>`COALESCE(SUM(${salesTable.total}::numeric), 0)`,
      })
      .from(salesTable)
      .where(gte(salesTable.createdAt, weekAgo));

    return {
      todaySales: {
        total: todaySales?.total || "0",
        count: todaySales?.count || 0,
      },
      paymentMethods: paymentMethodsResult.map((pm) => ({
        method: pm.paymentMethod,
        total: pm.total,
      })),
      products: {
        total: productsResult[0]?.total || 0,
        lowStock: lowStockResult[0]?.total || 0,
      },
      users: {
        total: usersResult[0]?.total || 0,
      },
      returns: {
        // registered returns (all states). A return is NOT money handed back: see pending / paid.
        total: returnsAllTotal.toFixed(2),
        count: returnsAllCount,
        pending: returnsBy("pending"), // owed to customers, not yet paid out
        paid: returnsBy("paid"), // actually paid (no settlement operation exists yet)
        legacy: returnsBy("legacy_unspecified"), // registered before the state existed
      },
      stock: {
        total: stockResult[0]?.total || 0,
      },
      cashSession: activeSession[0] || null,
      lastSale: lastSaleText,
      weekSales: {
        total: weekSalesResult[0]?.total || "0",
      },
    };
  });
}
