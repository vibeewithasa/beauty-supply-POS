/**
 * Transactional business operations for sales, cash and product deletion.
 *
 * Concurrency model (PostgreSQL, READ COMMITTED):
 *  - the single open cash session row is the serialization point: sales, cash movements and the
 *    closing all take `SELECT ... FOR UPDATE` on it, so they cannot interleave;
 *  - product rows are then locked in ascending id order (no deadlocks) and stock is decremented
 *    with a conditional UPDATE (`stock >= qty`); the CHECK constraint is the last safety net;
 *  - at most one open session is guaranteed by the partial unique index cash_sessions_single_open.
 * Every operation is one transaction: any failure rolls back sale, items, inventory and cash.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import {
  products as productsTable,
  sales as salesTable,
  saleItems as saleItemsTable,
  cashSessions as cashSessionsTable,
  cashMovements as cashMovementsTable,
  inventoryMovements as inventoryMovementsTable,
  deletedProductsLog as deletedProductsLogTable,
} from "./schema";
import { BusinessError, pgErrorCode } from "./errors";
import { MAX_CENTS, centsFromDb, centsToDb, toCents } from "./money";
import { parseCashMovement, parseId, parseReason, parseSaleInput } from "./validation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Locks and returns the session row; it must exist and be open. */
async function lockOpenSession(tx: Tx, sessionId: number) {
  const [session] = await tx
    .select()
    .from(cashSessionsTable)
    .where(eq(cashSessionsTable.id, sessionId))
    .for("update");
  if (!session) throw new BusinessError("CAJA_NO_ENCONTRADA", "La sesión de caja no existe");
  if (session.closedAt !== null || session.status !== "open") {
    throw new BusinessError("CAJA_CERRADA", "La caja ya está cerrada");
  }
  return session;
}

// ------------------------------------------------------------------ sales
export async function createSale(userId: number, data: unknown) {
  const input = parseSaleInput(data);

  return await db.transaction(async (tx) => {
    await lockOpenSession(tx, input.sessionId);

    const ids = input.items.map((i) => i.productId);
    const rows = await tx
      .select()
      .from(productsTable)
      .where(inArray(productsTable.id, ids))
      .orderBy(productsTable.id)
      .for("update");
    const byId = new Map(rows.map((p) => [p.id, p]));

    // Server-side prices and totals (integer cents); the client values are only compared.
    let totalCents = 0;
    const priced = input.items.map((item) => {
      const p = byId.get(item.productId);
      if (!p) throw new BusinessError("PRODUCTO_NO_ENCONTRADO", `El producto ${item.productId} no existe`);
      if (p.status !== "active") throw new BusinessError("PRODUCTO_NO_DISPONIBLE", `"${p.name}" no está disponible para la venta`);
      if (p.stock < item.quantity) {
        throw new BusinessError("STOCK_INSUFICIENTE", `Stock insuficiente para "${p.name}": hay ${p.stock}, se pidieron ${item.quantity}`);
      }
      const unitCents = centsFromDb(p.price);
      const subtotal = unitCents * item.quantity;
      // numeric(12,2) ceiling (also keeps the integer math exact: unit price x quantity can reach 1e17)
      if (subtotal > MAX_CENTS) throw new BusinessError("IMPORTE_INVALIDO", `El subtotal de "${p.name}" excede el máximo permitido`);
      if (item.unitPriceCents !== unitCents) {
        throw new BusinessError("PRECIO_DESACTUALIZADO", `El precio de "${p.name}" cambió: ahora es $${centsToDb(unitCents)}`);
      }
      if (item.subtotalCents !== subtotal) {
        throw new BusinessError("SUBTOTAL_INCORRECTO", `Subtotal incorrecto para "${p.name}"`);
      }
      totalCents += subtotal;
      if (totalCents > MAX_CENTS) throw new BusinessError("IMPORTE_INVALIDO", "El total de la venta excede el máximo permitido");
      return { item, product: p, unitCents, subtotal };
    });
    if (input.totalCents !== totalCents) {
      throw new BusinessError("TOTAL_INCORRECTO", `El total no coincide con el calculado ($${centsToDb(totalCents)})`);
    }

    const total = centsToDb(totalCents);
    const [sale] = await tx
      .insert(salesTable)
      .values({
        userId,
        cashSessionId: input.sessionId,
        total,
        paymentMethod: input.paymentMethod,
      })
      .returning();

    for (const { item, product, unitCents, subtotal } of priced) {
      await tx.insert(saleItemsTable).values({
        saleId: sale.id,
        productId: product.id,
        quantity: item.quantity,
        unitPrice: centsToDb(unitCents),
        subtotal: centsToDb(subtotal),
      });
      const updated = await tx
        .update(productsTable)
        .set({ stock: sql`${productsTable.stock} - ${item.quantity}` })
        .where(sql`${productsTable.id} = ${product.id} and ${productsTable.stock} >= ${item.quantity}`)
        .returning({ id: productsTable.id });
      if (updated.length !== 1) {
        throw new BusinessError("STOCK_INSUFICIENTE", `Stock insuficiente para "${product.name}"`);
      }
      await tx.insert(inventoryMovementsTable).values({
        productId: product.id,
        type: "OUT",
        amount: -item.quantity,
        reason: `Venta #${sale.id}`,
        userId,
      });
    }

    if (input.paymentMethod === "cash") {
      await tx
        .update(cashSessionsTable)
        .set({ currentAmount: sql`${cashSessionsTable.currentAmount} + ${total}::numeric` })
        .where(eq(cashSessionsTable.id, input.sessionId));
      await tx.insert(cashMovementsTable).values({
        sessionId: input.sessionId,
        type: "IN",
        amount: total,
        reason: `Venta #${sale.id} - Efectivo`,
        userId,
      });
    } else {
      // Card sales never touch the cash balance: informational movement of amount 0.
      await tx.insert(cashMovementsTable).values({
        sessionId: input.sessionId,
        type: "IN",
        amount: "0.00",
        reason: `Venta #${sale.id} - Tarjeta ($${total})`,
        userId,
      });
    }
    return sale;
  });
}

// ------------------------------------------------------------------ cash
export async function openCashSession(userId: number, amount: unknown) {
  const cents = toCents(amount, "monto inicial");
  const value = centsToDb(cents);
  try {
    const [session] = await db
      .insert(cashSessionsTable)
      .values({ openedBy: userId, initialAmount: value, currentAmount: value })
      .returning();
    return session;
  } catch (e) {
    // The partial unique index (closed_at IS NULL) is the real guard; no SELECT-then-INSERT race.
    if (pgErrorCode(e) === "23505") {
      throw new BusinessError("CAJA_YA_ABIERTA", "Ya hay una caja abierta; ciérrala antes de abrir otra");
    }
    throw e;
  }
}

export async function addCashMovement(userId: number, data: unknown) {
  const m = parseCashMovement(data);
  const amount = centsToDb(m.amountCents);
  return await db.transaction(async (tx) => {
    const session = await lockOpenSession(tx, m.sessionId);
    if (m.type === "OUT" && centsFromDb(session.currentAmount) < m.amountCents) {
      throw new BusinessError("FONDOS_INSUFICIENTES", `El retiro excede el efectivo disponible ($${session.currentAmount})`);
    }
    const sign = m.type === "IN" ? sql`+` : sql`-`;
    const updated = await tx
      .update(cashSessionsTable)
      .set({ currentAmount: sql`${cashSessionsTable.currentAmount} ${sign} ${amount}::numeric` })
      .where(
        m.type === "OUT"
          ? sql`${cashSessionsTable.id} = ${m.sessionId} and ${cashSessionsTable.currentAmount} >= ${amount}::numeric`
          : eq(cashSessionsTable.id, m.sessionId)
      )
      .returning({ id: cashSessionsTable.id });
    if (updated.length !== 1) throw new BusinessError("FONDOS_INSUFICIENTES", "El retiro excede el efectivo disponible");
    const [movement] = await tx
      .insert(cashMovementsTable)
      .values({ sessionId: m.sessionId, type: m.type, amount, reason: m.reason, userId })
      .returning();
    return movement;
  });
}

export async function closeCashSession(userId: number, sessionIdRaw: unknown, counted: unknown) {
  const sessionId = parseId(sessionIdRaw, "CAJA_INVALIDA", "La sesión de caja");
  const finalAmount = centsToDb(toCents(counted, "monto contado"));
  return await db.transaction(async (tx) => {
    await lockOpenSession(tx, sessionId);
    const [closed] = await tx
      .update(cashSessionsTable)
      .set({ status: "closed", closedAt: new Date(), closedBy: userId, finalAmount })
      .where(eq(cashSessionsTable.id, sessionId))
      .returning();
    return closed;
  });
}

// ------------------------------------------------------------------ products
/**
 * Logical deletion: status 'deleted' (distinct from 'inactive'), stock zeroed with a DELETE
 * inventory movement so stock and movements stay consistent, plus a deleted_products_log row.
 * The row is never physically removed (sales reference it).
 */
export async function softDeleteProduct(userId: number, idRaw: unknown, reasonRaw: unknown) {
  const id = parseId(idRaw, "PRODUCTO_INVALIDO", "El producto");
  const reason = parseReason(reasonRaw);
  return await db.transaction(async (tx) => {
    const [product] = await tx.select().from(productsTable).where(eq(productsTable.id, id)).for("update");
    if (!product) throw new BusinessError("PRODUCTO_NO_ENCONTRADO", "El producto no existe");
    if (product.status === "deleted") throw new BusinessError("PRODUCTO_YA_ELIMINADO", "El producto ya fue eliminado");

    await tx.update(productsTable).set({ status: "deleted", stock: 0, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await tx.insert(deletedProductsLogTable).values({
      productId: id,
      sku: product.sku,
      name: product.name,
      reason,
      deletedBy: userId,
    });
    if (product.stock > 0) {
      await tx.insert(inventoryMovementsTable).values({
        productId: id,
        type: "DELETE",
        amount: -product.stock,
        reason: `Producto eliminado: ${reason}`,
        userId,
      });
    }
    return true;
  });
}
