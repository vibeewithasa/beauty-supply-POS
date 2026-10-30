/**
 * Authorized refunds: a return and the settlement of its money, atomically (or the settlement of a return that was
 * registered earlier as pending).
 *
 * Policy (approved by the owner):
 *  - any signed-in user prepares a return; PAYING the refund needs the PIN of an active administrator, checked in main
 *    (admin-authorization.ts) without touching the operator's session;
 *  - the method of the refund is chosen freely (it may differ from how the sale was paid): 'cash' is taken from the open
 *    register, 'card' is a refund done outside the system on the card terminal (the POS performs no bank operation);
 *  - nothing is ever marked as paid unless the operator explicitly confirmed that the money was already handed back;
 *  - a refund is paid once: refund_settlements.return_id is unique and the status moves pending -> paid under a row lock.
 *
 * Money: the amount is the sum of return_items.refund_amount, which were computed from the persisted sale_items
 * (unit price x quantity, integer cents). Nothing monetary comes from the renderer.
 *
 * Locking order (global, shared with sales / cash movements / closing / plain returns):
 *    operation advisory lock -> cash session -> sale -> sale_items (ascending id) -> products (ascending id) -> return row.
 * Sales take session -> products; plain returns take sale -> items -> products; cash movements and the closing take the
 * session only. Every flow that takes several of these takes them in this order, so none of them can deadlock.
 *
 * Idempotency: the client generates an operationId per attempt. A repeated attempt (double click, retry after an uncertain
 * error) returns the stored result instead of paying again; the same key with different content is rejected.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import {
  returns as returnsTable,
  returnItems as returnItemsTable,
  refundSettlements as settlementsTable,
  cashSessions as cashSessionsTable,
  cashMovements as cashMovementsTable,
} from "./schema";
import { BusinessError, pgErrorCode } from "./errors";
import { centsFromDb, centsToDb } from "./money";
import { registerReturn } from "./returns-service";
import type { Tx } from "./returns-service";
import { parseNewRefundInput, parseSettleInput } from "./refund-validation";
import type { RefundPayment } from "./refund-validation";

export type Authorize = (pin: unknown) => Promise<{ adminId: number }>;

type Exec = Pick<Tx, "select">;
type CashSessionRow = typeof cashSessionsTable.$inferSelect;
type ReturnRow = typeof returnsTable.$inferSelect;
type SettlementRow = typeof settlementsTable.$inferSelect;

export type RefundResult = ReturnRow & { settlement: SettlementRow; replayed: boolean };

// ------------------------------------------------------------------ helpers
const lineSignature = (lines: { saleItemId: number; quantity: number }[]) =>
  lines
    .map((l) => `${l.saleItemId}:${l.quantity}`)
    .sort()
    .join("|");

/** Serializes attempts that carry the same operationId (double click, retry racing the original). */
async function lockOperation(tx: Tx, operationId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"refund:" + operationId}, 0))`);
}

async function loadResult(exec: Exec, settlement: SettlementRow): Promise<RefundResult> {
  const [ret] = await exec.select().from(returnsTable).where(eq(returnsTable.id, settlement.returnId));
  return { ...ret, settlement, replayed: false };
}

type ReplayShape =
  | { kind: "new"; saleId: number; reason: string; lines: { saleItemId: number; quantity: number }[] }
  | { kind: "pending"; returnId: number };

/**
 * The stored result of an earlier attempt with the same operationId, or null. It is a replay only when it was the same
 * operator asking for the same thing (same payment, same return / same sale lines); anything else is a client bug.
 */
async function findReplay(exec: Exec, operatorId: number, operationId: string, payment: RefundPayment, shape: ReplayShape) {
  const [settlement] = await exec.select().from(settlementsTable).where(eq(settlementsTable.operationId, operationId));
  if (!settlement) return null;
  const clash = () => new BusinessError("OPERACION_DUPLICADA", "El identificador de operación ya se usó para otro reembolso");
  if (settlement.processedBy !== operatorId || settlement.paymentMethod !== payment.method || settlement.externalReference !== payment.reference) {
    throw clash();
  }
  const result = await loadResult(exec, settlement);
  if (shape.kind === "pending") {
    if (settlement.returnId !== shape.returnId) throw clash();
  } else {
    const stored = await exec
      .select({ saleItemId: returnItemsTable.saleItemId, quantity: returnItemsTable.quantity })
      .from(returnItemsTable)
      .where(eq(returnItemsTable.returnId, settlement.returnId));
    // a return created together with its payment has the very same timestamp for both (one transaction)
    const createdTogether = result.createdAt.getTime() === settlement.paidAt.getTime();
    if (!createdTogether || result.saleId !== shape.saleId || result.reason !== shape.reason || lineSignature(stored) !== lineSignature(shape.lines)) {
      throw clash();
    }
  }
  return { ...result, replayed: true as const };
}

/**
 * Locks the register the refund is taken from. Cash needs the open register (row lock: it serializes with sales, movements
 * and the closing). A card refund moves no cash, but is attached to the open register for the closing report when there is one
 * (a share lock keeps the register from closing between the check and the write).
 */
async function lockRegister(tx: Tx, method: RefundPayment["method"]): Promise<CashSessionRow | null> {
  const query = tx.select().from(cashSessionsTable).where(isNull(cashSessionsTable.closedAt)).limit(1);
  const [session] = await (method === "cash" ? query.for("update") : query.for("share"));
  if (method === "cash" && !session) {
    throw new BusinessError("CAJA_CERRADA", "No hay una caja abierta: abre la caja para reembolsar en efectivo");
  }
  return session ?? null;
}

/** Writes the settlement (and, for cash, the register movement) of a return that is still pending. Caller holds the locks. */
async function settle(
  tx: Tx,
  p: { ret: ReturnRow; payment: RefundPayment; operationId: string; authorizedBy: number; processedBy: number; session: CashSessionRow | null }
) {
  const { ret, payment, session } = p;
  if (ret.refundStatus === "paid") throw new BusinessError("REEMBOLSO_YA_PAGADO", `La devolución #${ret.id} ya tiene su reembolso pagado`);
  if (ret.refundStatus === "legacy_unspecified") {
    throw new BusinessError(
      "REEMBOLSO_LEGACY",
      `La devolución #${ret.id} es anterior al control de reembolsos: no se sabe si el dinero ya se entregó, por eso no se puede pagar desde aquí`
    );
  }

  // the amount is what was persisted for the returned lines
  const [{ total }] = await tx
    .select({ total: sql<string>`coalesce(sum(${returnItemsTable.refundAmount}), 0)::text` })
    .from(returnItemsTable)
    .where(eq(returnItemsTable.returnId, ret.id));
  const amountCents = centsFromDb(total);
  if (ret.totalRefund !== null && centsFromDb(ret.totalRefund) !== amountCents) {
    throw new BusinessError("REEMBOLSO_INCONSISTENTE", `El importe de la devolución #${ret.id} no coincide con sus líneas`);
  }
  const amount = centsToDb(amountCents);

  let cashMovementId: number | null = null;
  if (payment.method === "cash") {
    if (!session) throw new BusinessError("CAJA_CERRADA", "No hay una caja abierta: abre la caja para reembolsar en efectivo");
    if (centsFromDb(session.currentAmount) < amountCents) {
      throw new BusinessError("FONDOS_INSUFICIENTES", `La caja no tiene efectivo suficiente para este reembolso (disponible $${session.currentAmount})`);
    }
    // conditional update: the balance can never go negative, whatever happened since the lock was taken
    const updated = await tx
      .update(cashSessionsTable)
      .set({ currentAmount: sql`${cashSessionsTable.currentAmount} - ${amount}::numeric` })
      .where(sql`${cashSessionsTable.id} = ${session.id} and ${cashSessionsTable.currentAmount} >= ${amount}::numeric`)
      .returning({ id: cashSessionsTable.id });
    if (updated.length !== 1) throw new BusinessError("FONDOS_INSUFICIENTES", "La caja no tiene efectivo suficiente para este reembolso");
    const [movement] = await tx
      .insert(cashMovementsTable)
      .values({
        sessionId: session.id,
        type: "OUT",
        amount,
        reason: `Reembolso en efectivo - Devolución #${ret.id} (venta #${ret.saleId})`,
        userId: p.processedBy,
      })
      .returning({ id: cashMovementsTable.id });
    cashMovementId = movement.id;
  }

  const [settlement] = await tx
    .insert(settlementsTable)
    .values({
      returnId: ret.id,
      paymentMethod: payment.method,
      amount,
      authorizedBy: p.authorizedBy,
      processedBy: p.processedBy,
      cashSessionId: session?.id ?? null,
      cashMovementId,
      externalReference: payment.reference,
      operationId: p.operationId,
    })
    .returning();
  const marked = await tx
    .update(returnsTable)
    .set({ refundStatus: "paid" })
    .where(and(eq(returnsTable.id, ret.id), eq(returnsTable.refundStatus, "pending")))
    .returning();
  if (marked.length !== 1) throw new BusinessError("REEMBOLSO_YA_PAGADO", `La devolución #${ret.id} ya no está pendiente`);
  return { ...marked[0], settlement, replayed: false as const };
}

/** Runs one refund attempt; a lost race on the unique indexes is translated into the stable business errors. */
async function attempt<T>(run: () => Promise<T>, replay: () => Promise<T | null>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (pgErrorCode(e) === "23505") {
      const again = await replay();
      if (again) return again;
      throw new BusinessError("REEMBOLSO_YA_PAGADO", "Este reembolso ya fue pagado");
    }
    throw e;
  }
}

// ------------------------------------------------------------------ new return + payment
/** Registers a new return and pays its refund in one transaction. Authorization happens before anything is written. */
export async function createReturnWithRefund(operatorId: number, authorize: Authorize, adminPin: unknown, data: unknown): Promise<RefundResult> {
  const { sale, payment, operationId } = parseNewRefundInput(data);
  const shape: ReplayShape = { kind: "new", saleId: sale.saleId, reason: sale.reason, lines: sale.items };
  const replay = () => findReplay(db, operatorId, operationId, payment, shape);

  // a stored result is returned as it is: the payment was already authorized when it was made
  const stored = await replay();
  if (stored) return stored;

  const { adminId } = await authorize(adminPin);

  return attempt(() =>
    db.transaction(async (tx) => {
      await lockOperation(tx, operationId);
      const again = await findReplay(tx, operatorId, operationId, payment, shape);
      if (again) return again;

      const session = await lockRegister(tx, payment.method);
      const { ret } = await registerReturn(tx, operatorId, sale);
      return settle(tx, { ret, payment, operationId, authorizedBy: adminId, processedBy: operatorId, session });
    }), replay
  );
}

// ------------------------------------------------------------------ pending return -> paid
/** Pays a return that was registered earlier as pending: no stock, no return lines, only the settlement. */
export async function settlePendingReturn(operatorId: number, authorize: Authorize, adminPin: unknown, data: unknown): Promise<RefundResult> {
  const { returnId, payment, operationId } = parseSettleInput(data);
  const shape: ReplayShape = { kind: "pending", returnId };
  const replay = () => findReplay(db, operatorId, operationId, payment, shape);

  const stored = await replay();
  if (stored) return stored;

  // an unknown or already settled return is told before asking an administrator to type a PIN for nothing
  const [current] = await db.select().from(returnsTable).where(eq(returnsTable.id, returnId));
  if (!current) throw new BusinessError("DEVOLUCION_NO_ENCONTRADA", "La devolución no existe");
  if (current.refundStatus !== "pending") await explainNotPending(current);

  const { adminId } = await authorize(adminPin);

  return attempt(() =>
    db.transaction(async (tx) => {
      await lockOperation(tx, operationId);
      const again = await findReplay(tx, operatorId, operationId, payment, shape);
      if (again) return again;

      const session = await lockRegister(tx, payment.method);
      const [ret] = await tx.select().from(returnsTable).where(eq(returnsTable.id, returnId)).for("update");
      if (!ret) throw new BusinessError("DEVOLUCION_NO_ENCONTRADA", "La devolución no existe");
      return settle(tx, { ret, payment, operationId, authorizedBy: adminId, processedBy: operatorId, session });
    }), replay
  );
}

async function explainNotPending(ret: ReturnRow): Promise<never> {
  if (ret.refundStatus === "paid") throw new BusinessError("REEMBOLSO_YA_PAGADO", `La devolución #${ret.id} ya tiene su reembolso pagado`);
  throw new BusinessError(
    "REEMBOLSO_LEGACY",
    `La devolución #${ret.id} es anterior al control de reembolsos: no se sabe si el dinero ya se entregó, por eso no se puede pagar desde aquí`
  );
}
