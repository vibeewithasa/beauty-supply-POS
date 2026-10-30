/**
 * Sales history: paginated search and persisted detail. Read-only (no writes, no locks).
 *
 * Visibility: administrators see every sale; a vendor sees only the sales they made. This never widens what the
 * existing authenticated channels (sales:getAll / sales:getById, open to every authenticated user) already allow.
 * A sale the caller may not see is reported as "not found", so ids cannot be probed.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "./db";
import {
  sales as salesTable,
  saleItems as saleItemsTable,
  users as usersTable,
  products as productsTable,
  returns as returnsTable,
  returnItems as returnItemsTable,
  cashSessions as cashSessionsTable,
} from "./schema";
import { BusinessError } from "./errors";
import { parseId } from "./validation";
import { parseSalesQuery } from "./sales-query";
import type { Role } from "../common/types";

export type Viewer = { id: number; role: Role };

export async function listSales(viewer: Viewer, data: unknown) {
  const q = parseSalesQuery(data);
  const conds: SQL[] = [];
  if (viewer.role !== "admin") conds.push(eq(salesTable.userId, viewer.id));
  if (q.folio !== null) conds.push(eq(salesTable.id, q.folio));
  if (q.start) conds.push(gte(salesTable.createdAt, q.start));
  if (q.endExclusive) conds.push(lt(salesTable.createdAt, q.endExclusive));
  if (q.method) conds.push(eq(salesTable.paymentMethod, q.method));
  const where = conds.length ? and(...conds) : undefined;

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(salesTable).where(where);
  const pageCount = Math.max(1, Math.ceil(n / q.pageSize));
  const rows = await db
    .select({
      id: salesTable.id,
      total: salesTable.total,
      paymentMethod: salesTable.paymentMethod,
      createdAt: salesTable.createdAt,
      userId: salesTable.userId,
      sellerName: usersTable.name,
      itemCount: sql<number>`(select coalesce(sum(${saleItemsTable.quantity}), 0)::int from ${saleItemsTable} where ${saleItemsTable.saleId} = ${salesTable.id})`,
      returnCount: sql<number>`(select count(*)::int from ${returnsTable} where ${returnsTable.saleId} = ${salesTable.id})`,
    })
    .from(salesTable)
    .leftJoin(usersTable, eq(salesTable.userId, usersTable.id))
    .where(where)
    .orderBy(desc(salesTable.createdAt), desc(salesTable.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { rows, total: n, page: q.page, pageSize: q.pageSize, pageCount };
}

/** Full persisted detail of one sale: lines as sold, related returns, cash session. */
export async function getSaleDetail(viewer: Viewer, saleIdRaw: unknown) {
  const saleId = parseId(saleIdRaw, "VENTA_INVALIDA", "La venta");
  const [sale] = await db
    .select({
      id: salesTable.id,
      total: salesTable.total,
      paymentMethod: salesTable.paymentMethod,
      createdAt: salesTable.createdAt,
      userId: salesTable.userId,
      sellerName: usersTable.name,
      cashSessionId: salesTable.cashSessionId,
    })
    .from(salesTable)
    .leftJoin(usersTable, eq(salesTable.userId, usersTable.id))
    .where(eq(salesTable.id, saleId));
  if (!sale || (viewer.role !== "admin" && sale.userId !== viewer.id)) {
    throw new BusinessError("VENTA_NO_ENCONTRADA", "La venta no existe");
  }

  const lines = await db
    .select({
      id: saleItemsTable.id,
      productId: saleItemsTable.productId,
      quantity: saleItemsTable.quantity,
      unitPrice: saleItemsTable.unitPrice,
      subtotal: saleItemsTable.subtotal,
      soldName: saleItemsTable.productName,
      soldSku: saleItemsTable.productSku,
      catalogName: productsTable.name,
      catalogSku: productsTable.sku,
      productStatus: productsTable.status,
    })
    .from(saleItemsTable)
    .leftJoin(productsTable, eq(saleItemsTable.productId, productsTable.id))
    .where(eq(saleItemsTable.saleId, saleId))
    .orderBy(saleItemsTable.id);
  // Sales made before the snapshot columns existed have no stored name: the current catalog name is shown and
  // flagged (nameSource "catalog"), never presented as the historical one.
  const items = lines.map((l) => ({
    id: l.id,
    productId: l.productId,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    subtotal: l.subtotal,
    name: l.soldName ?? l.catalogName ?? `Producto #${l.productId}`,
    sku: l.soldSku ?? l.catalogSku ?? null,
    nameSource: l.soldName ? ("snapshot" as const) : ("catalog" as const),
    productStatus: l.productStatus,
  }));

  const rets = await db
    .select({
      id: returnsTable.id,
      totalRefund: returnsTable.totalRefund,
      refundStatus: returnsTable.refundStatus,
      reason: returnsTable.reason,
      createdAt: returnsTable.createdAt,
    })
    .from(returnsTable)
    .where(eq(returnsTable.saleId, saleId))
    .orderBy(desc(returnsTable.createdAt), desc(returnsTable.id));
  const retLines = rets.length
    ? await db
        .select({
          returnId: returnItemsTable.returnId,
          saleItemId: returnItemsTable.saleItemId,
          quantity: returnItemsTable.quantity,
          refundAmount: returnItemsTable.refundAmount,
        })
        .from(returnItemsTable)
        .innerJoin(returnsTable, eq(returnItemsTable.returnId, returnsTable.id))
        .where(eq(returnsTable.saleId, saleId))
    : [];
  const returns = rets.map((r) => ({
    ...r,
    items: retLines
      .filter((x) => x.returnId === r.id)
      .map((x) => ({ saleItemId: x.saleItemId, quantity: x.quantity, refundAmount: x.refundAmount })),
  }));

  let cashSession: { id: number; openedAt: Date; closedAt: Date | null } | null = null;
  if (sale.cashSessionId !== null) {
    const [s] = await db
      .select({ id: cashSessionsTable.id, openedAt: cashSessionsTable.openedAt, closedAt: cashSessionsTable.closedAt })
      .from(cashSessionsTable)
      .where(eq(cashSessionsTable.id, sale.cashSessionId));
    cashSession = s ?? null;
  }
  return { sale, items, returns, cashSession };
}
