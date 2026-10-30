/**
 * Cash-register session history and closing summaries. Read-only (no writes, no locks).
 *
 * Every figure comes from structured data, never from the text of a `reason`:
 *   - sales by payment method: the `sales` rows of the session (card sales are informational, never mixed with cash);
 *   - manual income / withdrawals: `cash_movements` that neither a sale (sale_id, migration 0008) nor a refund settlement
 *     (refund_settlements.cash_movement_id, migration 0009) created. A refund paid in cash is NOT a manual withdrawal;
 *   - refunds paid: `refund_settlements` of the session where the money was actually handed back (their payment date,
 *     which can differ from the date of the return or of the sale). Cash refunds reduce the expected cash exactly once;
 *     card refunds are informational (made on the terminal) and never reduce cash;
 *   - expected cash: initial + cash sales + manual income - withdrawals - cash refunds, cross-checked against the register
 *     balance the system keeps (`current_amount`), which is what the cashier saw when closing.
 *   - returns: counted through the sale they belong to, by refund state. A pending refund is money still OWED, not paid.
 *
 * Visibility (provisional, like the sales history): an administrator sees every session; a vendor sees the open session
 * (the register is shared and they already operate it) and the sessions they opened or closed.
 */
import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "./db";
import {
  cashSessions as sessionsTable,
  cashMovements as movementsTable,
  sales as salesTable,
  returns as returnsTable,
  refundSettlements as settlementsTable,
  users as usersTable,
} from "./schema";
import { BusinessError } from "./errors";
import { centsFromDb, centsToDb } from "./money";
import { parseId } from "./validation";
import { parseCashSessionsQuery } from "./cash-query";
import type { Viewer } from "./sales-history";

const visibleTo = (viewer: Viewer): SQL | undefined =>
  viewer.role === "admin" ? undefined : or(isNull(sessionsTable.closedAt), eq(sessionsTable.openedBy, viewer.id), eq(sessionsTable.closedBy, viewer.id));

export async function listCashSessions(viewer: Viewer, data: unknown) {
  const q = parseCashSessionsQuery(data);
  const conds: SQL[] = [];
  const vis = visibleTo(viewer);
  if (vis) conds.push(vis);
  if (q.start) conds.push(gte(sessionsTable.openedAt, q.start));
  if (q.endExclusive) conds.push(lt(sessionsTable.openedAt, q.endExclusive));
  if (q.status === "open") conds.push(isNull(sessionsTable.closedAt));
  if (q.status === "closed") conds.push(sql`${sessionsTable.closedAt} is not null`);
  const where = conds.length ? and(...conds) : undefined;

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(sessionsTable).where(where);
  const opener = alias(usersTable, "opener");
  const closer = alias(usersTable, "closer");
  const rows = await db
    .select({
      id: sessionsTable.id,
      status: sessionsTable.status,
      openedAt: sessionsTable.openedAt,
      closedAt: sessionsTable.closedAt,
      openedByName: opener.name,
      closedByName: closer.name,
      initialAmount: sessionsTable.initialAmount,
      currentAmount: sessionsTable.currentAmount,
      finalAmount: sessionsTable.finalAmount,
      salesCount: sql<number>`(select count(*)::int from ${salesTable} where ${salesTable.cashSessionId} = ${sessionsTable.id})`,
      cashSales: sql<string>`(select coalesce(sum(${salesTable.total}), 0)::text from ${salesTable} where ${salesTable.cashSessionId} = ${sessionsTable.id} and ${salesTable.paymentMethod} = 'cash')`,
      cardSales: sql<string>`(select coalesce(sum(${salesTable.total}), 0)::text from ${salesTable} where ${salesTable.cashSessionId} = ${sessionsTable.id} and ${salesTable.paymentMethod} = 'card')`,
      cashRefunds: sql<string>`(select coalesce(sum(${settlementsTable.amount}), 0)::text from ${settlementsTable} where ${settlementsTable.cashSessionId} = ${sessionsTable.id} and ${settlementsTable.paymentMethod} = 'cash')`,
      cardRefunds: sql<string>`(select coalesce(sum(${settlementsTable.amount}), 0)::text from ${settlementsTable} where ${settlementsTable.cashSessionId} = ${sessionsTable.id} and ${settlementsTable.paymentMethod} = 'card')`,
    })
    .from(sessionsTable)
    .leftJoin(opener, eq(sessionsTable.openedBy, opener.id))
    .leftJoin(closer, eq(sessionsTable.closedBy, closer.id))
    .where(where)
    .orderBy(desc(sessionsTable.openedAt), desc(sessionsTable.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return {
    rows: rows.map((r) => ({
      ...r,
      // the difference the cashier saw when closing: counted - register balance (null while the session is open)
      difference: r.finalAmount === null ? null : centsToDb(centsFromDb(r.finalAmount) - centsFromDb(r.currentAmount)),
    })),
    total: n,
    page: q.page,
    pageSize: q.pageSize,
    pageCount: Math.max(1, Math.ceil(n / q.pageSize)),
  };
}

export async function getCashSessionSummary(viewer: Viewer, sessionIdRaw: unknown) {
  const sessionId = parseId(sessionIdRaw, "CAJA_INVALIDA", "La sesión de caja");
  const opener = alias(usersTable, "opener");
  const closer = alias(usersTable, "closer");
  const [s] = await db
    .select({
      id: sessionsTable.id,
      status: sessionsTable.status,
      openedBy: sessionsTable.openedBy,
      closedBy: sessionsTable.closedBy,
      openedByName: opener.name,
      closedByName: closer.name,
      openedAt: sessionsTable.openedAt,
      closedAt: sessionsTable.closedAt,
      initialAmount: sessionsTable.initialAmount,
      currentAmount: sessionsTable.currentAmount,
      finalAmount: sessionsTable.finalAmount,
    })
    .from(sessionsTable)
    .leftJoin(opener, eq(sessionsTable.openedBy, opener.id))
    .leftJoin(closer, eq(sessionsTable.closedBy, closer.id))
    .where(eq(sessionsTable.id, sessionId));
  // a session the caller may not see answers exactly like a missing one
  if (!s || !(viewer.role === "admin" || s.closedAt === null || s.openedBy === viewer.id || s.closedBy === viewer.id)) {
    throw new BusinessError("CAJA_NO_ENCONTRADA", "La sesión de caja no existe");
  }

  const bySale = await db
    .select({ method: salesTable.paymentMethod, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${salesTable.total}), 0)::text` })
    .from(salesTable)
    .where(eq(salesTable.cashSessionId, sessionId))
    .groupBy(salesTable.paymentMethod);
  const pick = (m: "cash" | "card") => {
    const r = bySale.find((x) => x.method === m);
    return { count: r?.count ?? 0, total: r?.total ?? "0" };
  };
  const cash = pick("cash");
  const card = pick("card");

  const manual = await db
    .select({ type: movementsTable.type, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${movementsTable.amount}), 0)::text` })
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.sessionId, sessionId),
        isNull(movementsTable.saleId),
        // a refund paid in cash is a refund, not a manual withdrawal
        sql`not exists (select 1 from ${settlementsTable} where ${settlementsTable.cashMovementId} = ${movementsTable.id})`
      )
    )
    .groupBy(movementsTable.type);
  const mv = (t: "IN" | "OUT") => {
    const r = manual.find((x) => x.type === t);
    return { count: r?.count ?? 0, total: r?.total ?? "0" };
  };
  const manualIn = mv("IN");
  const manualOut = mv("OUT");
  const [linked] = await db
    .select({ total: sql<string>`coalesce(sum(${movementsTable.amount}), 0)::text` })
    .from(movementsTable)
    .where(and(eq(movementsTable.sessionId, sessionId), sql`${movementsTable.saleId} is not null`));

  const paid = await db
    .select({ method: settlementsTable.paymentMethod, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${settlementsTable.amount}), 0)::text` })
    .from(settlementsTable)
    .where(eq(settlementsTable.cashSessionId, sessionId))
    .groupBy(settlementsTable.paymentMethod);
  const refundBy = (m: "cash" | "card") => {
    const r = paid.find((x) => x.method === m);
    return { count: r?.count ?? 0, total: r?.total ?? "0" };
  };
  const cashRefunds = refundBy("cash");
  const cardRefunds = refundBy("card");

  const expectedCents =
    centsFromDb(s.initialAmount) + centsFromDb(cash.total) + centsFromDb(manualIn.total) - centsFromDb(manualOut.total) - centsFromDb(cashRefunds.total);
  const balanceCents = centsFromDb(s.currentAmount);
  const closed = s.finalAmount !== null;

  const rets = await db
    .select({ status: returnsTable.refundStatus, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${returnsTable.totalRefund}), 0)::text` })
    .from(returnsTable)
    .innerJoin(salesTable, eq(returnsTable.saleId, salesTable.id))
    .where(eq(salesTable.cashSessionId, sessionId))
    .groupBy(returnsTable.refundStatus);
  const ret = (st: string) => {
    const r = rets.find((x) => x.status === st);
    return { count: r?.count ?? 0, total: r?.total ?? "0" };
  };

  return {
    session: {
      id: s.id,
      status: s.status,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      openedByName: s.openedByName,
      closedByName: s.closedByName,
    },
    initialAmount: s.initialAmount,
    sales: { count: cash.count + card.count, cash, card },
    movements: { manualIn, manualOut, saleLinkedCashIn: linked?.total ?? "0" },
    // refunds whose money was handed back while this register was open (payment date, not return date)
    refunds: { cash: cashRefunds, card: cardRefunds },
    expected: {
      fromRecords: centsToDb(expectedCents),
      registerBalance: s.currentAmount,
      // false means the stored balance and the records disagree (old data): shown, never hidden
      reconciles: expectedCents === balanceCents,
    },
    closing: {
      counted: s.finalAmount,
      difference: closed ? centsToDb(centsFromDb(s.finalAmount as string) - balanceCents) : null,
    },
    // registered returns of this session's SALES, by refund state. Pending means owed to the customer, NOT paid; `paid` may have
    // been paid in another session (see `refunds` for what was paid in this one).
    returns: { pending: ret("pending"), paid: ret("paid"), legacy: ret("legacy_unspecified") },
  };
}

export type CashSessionSummary = Awaited<ReturnType<typeof getCashSessionSummary>>;
