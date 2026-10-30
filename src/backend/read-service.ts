/**
 * Read-only queries used by the administrative screens (products, movements, price history, returns lookup,
 * reports). No writes, no locks: the authoritative checks of every write stay in the write services.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "./db";
import {
  products as productsTable,
  refundSettlements as settlementsTable,
  sales as salesTable,
  saleItems as saleItemsTable,
  users as usersTable,
  returns as returnsTable,
  returnItems as returnItemsTable,
  inventoryMovements as inventoryMovementsTable,
  priceChanges as priceChangesTable,
} from "./schema";
import { BusinessError } from "./errors";
import { parseId } from "./validation";
import { parseReportRange } from "./reports-validation";

/** All products, including inactive and logically deleted ones (administrators only: see the ACCESS table). */
export async function listAllProducts() {
  return await db.select().from(productsTable).orderBy(productsTable.name);
}

const optionalProductId = (v: unknown) => (v === undefined || v === null ? null : parseId(v, "PRODUCTO_INVALIDO", "El producto"));

export async function listMovements(productIdRaw?: unknown) {
  const productId = optionalProductId(productIdRaw);
  const q = db
    .select({
      id: inventoryMovementsTable.id,
      productId: inventoryMovementsTable.productId,
      type: inventoryMovementsTable.type,
      amount: inventoryMovementsTable.amount,
      reason: inventoryMovementsTable.reason,
      createdAt: inventoryMovementsTable.createdAt,
      userName: usersTable.name,
      productName: productsTable.name,
      productSku: productsTable.sku,
    })
    .from(inventoryMovementsTable)
    .leftJoin(usersTable, eq(inventoryMovementsTable.userId, usersTable.id))
    .leftJoin(productsTable, eq(inventoryMovementsTable.productId, productsTable.id))
    .orderBy(desc(inventoryMovementsTable.createdAt), desc(inventoryMovementsTable.id))
    .limit(100);
  return productId === null ? await q : await q.where(eq(inventoryMovementsTable.productId, productId));
}

export async function listPriceChanges(productIdRaw?: unknown) {
  const productId = optionalProductId(productIdRaw);
  const q = db
    .select({
      id: priceChangesTable.id,
      productId: priceChangesTable.productId,
      oldPrice: priceChangesTable.oldPrice,
      newPrice: priceChangesTable.newPrice,
      reason: priceChangesTable.reason,
      createdAt: priceChangesTable.createdAt,
      userName: usersTable.name,
      productName: productsTable.name,
      productSku: productsTable.sku,
    })
    .from(priceChangesTable)
    .leftJoin(usersTable, eq(priceChangesTable.changedBy, usersTable.id))
    .leftJoin(productsTable, eq(priceChangesTable.productId, productsTable.id))
    .orderBy(desc(priceChangesTable.createdAt), desc(priceChangesTable.id))
    .limit(100);
  return productId === null ? await q : await q.where(eq(priceChangesTable.productId, productId));
}

/**
 * Returns history with who processed each one. refundStatus says whether the money was actually paid; when it was, the
 * settlement columns say how (cash / card), when, with which reference and who attended and authorized it (NULL otherwise).
 */
export async function listReturns() {
  const authorizer = alias(usersTable, "authorizer");
  const payer = alias(usersTable, "payer");
  return await db
    .select({
      id: returnsTable.id,
      saleId: returnsTable.saleId,
      totalRefund: returnsTable.totalRefund,
      refundStatus: returnsTable.refundStatus,
      reason: returnsTable.reason,
      createdAt: returnsTable.createdAt,
      processedBy: returnsTable.processedBy,
      processedByName: usersTable.name,
      paymentMethod: settlementsTable.paymentMethod,
      paidAmount: settlementsTable.amount,
      paidAt: settlementsTable.paidAt,
      externalReference: settlementsTable.externalReference,
      cashSessionId: settlementsTable.cashSessionId,
      authorizedBy: settlementsTable.authorizedBy,
      authorizedByName: authorizer.name,
      paidBy: settlementsTable.processedBy,
      paidByName: payer.name,
    })
    .from(returnsTable)
    .leftJoin(usersTable, eq(returnsTable.processedBy, usersTable.id))
    .leftJoin(settlementsTable, eq(settlementsTable.returnId, returnsTable.id))
    .leftJoin(authorizer, eq(settlementsTable.authorizedBy, authorizer.id))
    .leftJoin(payer, eq(settlementsTable.processedBy, payer.id))
    .orderBy(desc(returnsTable.createdAt), desc(returnsTable.id))
    .limit(100);
}

/**
 * A sale with its lines, how much of each line was already returned and how much can still be returned.
 * Informational only: createReturn re-validates everything under locks.
 */
export async function getSaleForReturn(saleIdRaw: unknown) {
  const saleId = parseId(saleIdRaw, "VENTA_INVALIDA", "La venta");
  const [sale] = await db
    .select({
      id: salesTable.id,
      total: salesTable.total,
      paymentMethod: salesTable.paymentMethod,
      createdAt: salesTable.createdAt,
      userName: usersTable.name,
    })
    .from(salesTable)
    .leftJoin(usersTable, eq(salesTable.userId, usersTable.id))
    .where(eq(salesTable.id, saleId));
  if (!sale) throw new BusinessError("VENTA_NO_ENCONTRADA", "La venta no existe");

  const lines = await db
    .select({
      id: saleItemsTable.id,
      productId: saleItemsTable.productId,
      quantity: saleItemsTable.quantity,
      unitPrice: saleItemsTable.unitPrice,
      subtotal: saleItemsTable.subtotal,
      productName: productsTable.name,
      productSku: productsTable.sku,
      productStatus: productsTable.status,
    })
    .from(saleItemsTable)
    .leftJoin(productsTable, eq(saleItemsTable.productId, productsTable.id))
    .where(eq(saleItemsTable.saleId, saleId))
    .orderBy(saleItemsTable.id);

  const returned = lines.length
    ? await db
        .select({ saleItemId: returnItemsTable.saleItemId, qty: sql<number>`sum(${returnItemsTable.quantity})::int` })
        .from(returnItemsTable)
        .where(inArray(returnItemsTable.saleItemId, lines.map((l) => l.id)))
        .groupBy(returnItemsTable.saleItemId)
    : [];
  const byLine = new Map(returned.map((r) => [r.saleItemId, r.qty]));
  return {
    sale,
    lines: lines.map((l) => {
      const returnedQuantity = byLine.get(l.id) ?? 0;
      return { ...l, returnedQuantity, remaining: Math.max(l.quantity - returnedQuantity, 0) };
    }),
  };
}

/** Real figures only: gross sales as recorded, no costs, profit or taxes (the system does not record them). */
export async function salesSummary(data: unknown) {
  const range = parseReportRange(data);
  const inSales = and(gte(salesTable.createdAt, range.start), lt(salesTable.createdAt, range.endExclusive));

  const [totals] = await db
    .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${salesTable.total}), 0)::text` })
    .from(salesTable)
    .where(inSales);
  const byMethod = await db
    .select({ method: salesTable.paymentMethod, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${salesTable.total}), 0)::text` })
    .from(salesTable)
    .where(inSales)
    .groupBy(salesTable.paymentMethod);
  const byProduct = await db
    .select({
      productId: saleItemsTable.productId,
      sku: productsTable.sku,
      name: productsTable.name,
      quantity: sql<number>`sum(${saleItemsTable.quantity})::int`,
      total: sql<string>`sum(${saleItemsTable.subtotal})::text`,
    })
    .from(saleItemsTable)
    .innerJoin(salesTable, eq(saleItemsTable.saleId, salesTable.id))
    .leftJoin(productsTable, eq(saleItemsTable.productId, productsTable.id))
    .where(inSales)
    .groupBy(saleItemsTable.productId, productsTable.sku, productsTable.name)
    .orderBy(sql`sum(${saleItemsTable.subtotal}) desc`)
    .limit(20);
  const returnsRows = await db
    .select({ status: returnsTable.refundStatus, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${returnsTable.totalRefund}), 0)::text` })
    .from(returnsTable)
    .where(and(gte(returnsTable.createdAt, range.start), lt(returnsTable.createdAt, range.endExclusive)))
    .groupBy(returnsTable.refundStatus);
  const ret = (status: string) => {
    const r = returnsRows.find((x) => x.status === status);
    return { count: r?.count ?? 0, total: r?.total ?? "0" };
  };
  // Money actually handed back in the range, by method and by PAYMENT date (a refund can be paid days after its return)
  const paidRows = await db
    .select({ method: settlementsTable.paymentMethod, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${settlementsTable.amount}), 0)::text` })
    .from(settlementsTable)
    .where(and(gte(settlementsTable.paidAt, range.start), lt(settlementsTable.paidAt, range.endExclusive)))
    .groupBy(settlementsTable.paymentMethod);
  const paidBy = (m: "cash" | "card") => {
    const r = paidRows.find((x) => x.method === m);
    return { count: r?.count ?? 0, total: r?.total ?? "0" };
  };
  const [owed] = await db
    .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${returnsTable.totalRefund}), 0)::text` })
    .from(returnsTable)
    .where(eq(returnsTable.refundStatus, "pending"));
  return {
    from: range.from,
    to: range.to,
    days: range.days,
    sales: { count: totals?.count ?? 0, total: totals?.total ?? "0" },
    byMethod,
    byProduct,
    returns: {
      // a registered return is NOT money handed back: pending refunds are owed, paid ones were actually paid
      pending: ret("pending"),
      paid: ret("paid"),
      legacy: ret("legacy_unspecified"),
    },
    // by payment date: cash left a register, card was refunded on the terminal (informational, never subtracted from cash)
    refundsPaid: { cash: paidBy("cash"), card: paidBy("card") },
    // still owed to customers right now, whatever the date of the return
    refundsOwed: { count: owed?.count ?? 0, total: owed?.total ?? "0" },
  };
}

/** Kept for compatibility (no screen uses it): the same validation as the summary, raw sale rows. */
export async function salesByRange(startRaw: unknown, endRaw: unknown) {
  const start = typeof startRaw === "string" ? new Date(startRaw) : null;
  const end = typeof endRaw === "string" ? new Date(endRaw) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BusinessError("FECHA_INVALIDA", "Fechas inválidas");
  }
  if (start.getTime() > end.getTime()) throw new BusinessError("RANGO_INVALIDO", "La fecha inicial no puede ser posterior a la final");
  return await db
    .select()
    .from(salesTable)
    .where(and(gte(salesTable.createdAt, start), lt(salesTable.createdAt, end)))
    .orderBy(desc(salesTable.createdAt))
    .limit(1000);
}

/**
 * Everything the return voucher prints, from PostgreSQL only: the return, its lines as sold (the name stored with the sale, or the
 * catalogue name for old sales) and, when the refund was paid, how/when and who attended and authorized it.
 */
export async function getReturnVoucher(returnIdRaw: unknown) {
  const returnId = parseId(returnIdRaw, "DEVOLUCION_INVALIDA", "La devolución");
  const authorizer = alias(usersTable, "authorizer");
  const payer = alias(usersTable, "payer");
  const [ret] = await db
    .select({
      id: returnsTable.id,
      saleId: returnsTable.saleId,
      createdAt: returnsTable.createdAt,
      reason: returnsTable.reason,
      status: returnsTable.refundStatus,
      totalRefund: returnsTable.totalRefund,
      processedByName: usersTable.name,
    })
    .from(returnsTable)
    .leftJoin(usersTable, eq(returnsTable.processedBy, usersTable.id))
    .where(eq(returnsTable.id, returnId));
  if (!ret) throw new BusinessError("DEVOLUCION_NO_ENCONTRADA", "La devolución no existe");

  const items = await db
    .select({
      name: sql<string>`coalesce(${saleItemsTable.productName}, ${productsTable.name}, 'Producto #' || ${returnItemsTable.productId})`,
      sku: sql<string | null>`coalesce(${saleItemsTable.productSku}, ${productsTable.sku})`,
      quantity: returnItemsTable.quantity,
      unitPrice: saleItemsTable.unitPrice,
      refundAmount: returnItemsTable.refundAmount,
    })
    .from(returnItemsTable)
    .innerJoin(saleItemsTable, eq(returnItemsTable.saleItemId, saleItemsTable.id))
    .leftJoin(productsTable, eq(returnItemsTable.productId, productsTable.id))
    .where(eq(returnItemsTable.returnId, returnId))
    .orderBy(returnItemsTable.id);

  const [s] = await db
    .select({
      method: settlementsTable.paymentMethod,
      amount: settlementsTable.amount,
      paidAt: settlementsTable.paidAt,
      reference: settlementsTable.externalReference,
      authorizedByName: authorizer.name,
      paidByName: payer.name,
    })
    .from(settlementsTable)
    .leftJoin(authorizer, eq(settlementsTable.authorizedBy, authorizer.id))
    .leftJoin(payer, eq(settlementsTable.processedBy, payer.id))
    .where(eq(settlementsTable.returnId, returnId));

  return { ...ret, items, settlement: s ?? null };
}
