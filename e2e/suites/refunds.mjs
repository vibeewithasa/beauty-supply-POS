// Refunds suite (Sprint 05): returns paid with the PIN of an administrator. Cash and card refunds, authorization,
// atomicity, idempotency, concurrency, pending returns, reporting. Direct IPC for the contracts of the main process;
// every outcome is verified in PostgreSQL (the run's throwaway database only).
import { APP_URL, ui, ipc, expect, closeStrayCash, containsSecret, connectRunDb, waitFor } from "../lib/harness.mjs";
import crypto from "node:crypto";

const J = JSON.stringify;
const LEAKS = /Failed query|params:|\n\s+at |select |insert |update |relation "|password|postgres(ql)?:\/\//i;

export async function run(c) {
  const { page, db, data, test, mainLog } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const num = (v) => Number(v);
  const call = (expr) => ipc(page, expr);
  const code = (r) => (r.ok === false ? (String(r.err).match(/\[(\w+)\]/) || [])[1] ?? String(r.err).slice(0, 80) : "OK");
  const newOp = () => "op-" + crypto.randomBytes(8).toString("hex");

  const admin = await data.user("RF_ADMIN", "admin", { modern: true });
  const admin2 = await data.user("RF_ADMIN2", "admin"); // legacy 4-digit PIN
  const inactiveAdmin = await data.user("RF_OLDADMIN", "admin", { active: false, modern: true });
  const vendor = await data.user("RF_VENDOR", "vendor");
  const vendor2 = await data.user("RF_VENDOR2", "vendor");
  await closeStrayCash(db, admin.id);
  const P = [];
  for (let i = 0; i < 12; i++) P.push(await data.product("RF" + i, "10.00", 1000));
  const pCheap = await data.product("RFC", "2.50", 1000);

  const loginAs = async (u) => {
    await ipc(page, "api.auth.logout()");
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, u.pin);
    await page.waitForURL(u.role === "admin" ? /#\/dashboard$/ : /#\/sales$/, { timeout: 8000 });
  };
  const openRegister = async (amount) => {
    await closeStrayCash(db, admin.id);
    const r = await call(`api.cash.openSession(${amount})`);
    expect(r.ok, "open register: " + J(r));
    return r.v.id;
  };
  const register = () => one("select * from cash_sessions where closed_at is null");

  /** a sale as it was persisted (lines with their prices); no stock/cash side effects, only what a refund reads */
  const mkSale = async ({ userId = vendor.id, method = "cash", lines, sessionId = null }) => {
    const total = lines.reduce((s, l) => s + Math.round(num(l.p.price) * 100) * l.q, 0) / 100;
    const s = await one("insert into sales(user_id,cash_session_id,total,payment_method) values($1,$2,$3,$4) returning id", [userId, sessionId, total.toFixed(2), method]);
    const items = [];
    for (const l of lines) {
      const it = await one(
        "insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,$3,$4,$5,$6,$7) returning id,product_id,quantity,unit_price",
        [s.id, l.p.id, l.q, num(l.p.price).toFixed(2), (num(l.p.price) * l.q).toFixed(2), l.p.name, l.p.sku]
      );
      items.push(it);
    }
    return { id: s.id, items, total };
  };
  const body = (sale, picks, o = {}) => ({
    saleId: sale.id,
    reason: o.reason ?? "devolución e2e",
    items: picks.map(([i, q]) => ({ saleItemId: sale.items[i].id, quantity: q })),
    payment: { method: o.method ?? "cash", confirmed: o.confirmed === undefined ? true : o.confirmed, ...(o.reference ? { reference: o.reference } : {}) },
    operationId: o.op ?? newOp(),
    ...(o.extra ?? {}),
  });
  const pay = (payload, pin) => call(`api.returns.createWithRefund(${J(payload)}, ${J(pin)})`);
  const settle = (payload, pin) => call(`api.returns.settleRefund(${J(payload)}, ${J(pin)})`);
  const stockOf = async (p) => num((await one("select stock from products where id=$1", [p.id])).stock);
  const cashNow = async () => num((await register()).current_amount);
  const snap = async () =>
    J(
      await one(`select (select count(*) from returns)::int returns, (select count(*) from return_items)::int items,
        (select count(*) from refund_settlements)::int settlements, (select count(*) from inventory_movements)::int inv,
        (select coalesce(sum(stock),0) from products)::int stock, (select count(*) from cash_movements)::int cmov,
        (select coalesce(sum(current_amount),0) from cash_sessions)::text cash`)
    );
  const withTrigger = async (table, timing, fn, bodySql, runIt) => {
    await db.query(`create or replace function ${fn}() returns trigger language plpgsql as $f$ begin ${bodySql} end $f$`);
    await db.query(`create trigger ${fn}_t ${timing} on ${table} for each row execute function ${fn}()`);
    try { return await runIt(); } finally {
      await db.query(`drop trigger if exists ${fn}_t on ${table}`);
      await db.query(`drop function if exists ${fn}()`);
    }
  };

  // ================================================================== authorized cash / card refunds
  let sid;
  await test("RFD-00.vendor_signs_in_and_the_register_is_opened", "e2e", async () => {
    await loginAs(admin);
    sid = await openRegister(500);
    await loginAs(vendor);
    const me = await call("api.auth.me()");
    expect(me.ok && me.v.id === vendor.id && me.v.role === "vendor", "signed in as the vendor: " + J(me));
  });

  await test("RFD-01.vendor_prepares_and_an_administrator_PIN_authorizes_a_cash_refund_atomically", "integration", async () => {
    const sale = await mkSale({ method: "card", lines: [{ p: P[0], q: 3 }, { p: pCheap, q: 2 }] }); // paid by card, refunded in cash: allowed
    const stock0 = await stockOf(P[0]), stockC0 = await stockOf(pCheap);
    const cash0 = await cashNow();
    const r = await pay(body(sale, [[0, 2], [1, 2]], { method: "cash", reason: "  cliente se arrepintió  " }), admin.pin);
    expect(r.ok, "refund: " + J(r));
    expect(r.v.refundStatus === "paid" && r.v.replayed === false && num(r.v.totalRefund) === 25, "result: " + J(r.v));
    // the operator's session did not change: the vendor is still signed in
    const me = await call("api.auth.me()");
    expect(me.ok && me.v.id === vendor.id, "the vendor's session is untouched: " + J(me));
    const ret = await one("select * from returns where id=$1", [r.v.id]);
    expect(ret.refund_status === "paid" && num(ret.total_refund) === 25 && ret.processed_by === vendor.id && ret.reason === "cliente se arrepintió", "return row " + J(ret));
    const st = await one("select * from refund_settlements where return_id=$1", [ret.id]);
    expect(st.payment_method === "cash" && num(st.amount) === 25 && st.authorized_by === admin.id && st.processed_by === vendor.id, "settlement authority " + J(st));
    expect(st.cash_session_id === sid && st.cash_movement_id !== null && st.external_reference === null && st.paid_at, "settlement register " + J(st));
    const mv = await one("select * from cash_movements where id=$1", [st.cash_movement_id]);
    expect(mv.type === "OUT" && num(mv.amount) === 25 && mv.session_id === sid && mv.sale_id === null && mv.user_id === vendor.id && /Reembolso en efectivo/.test(mv.reason) && mv.reason.includes(`#${ret.id}`), "cash movement " + J(mv));
    expect((await cashNow()) === cash0 - 25, "the register lost exactly 25.00");
    expect((await stockOf(P[0])) === stock0 + 2 && (await stockOf(pCheap)) === stockC0 + 2, "stock restored through the existing logic");
    expect((await one("select count(*)::int n from inventory_movements where reason like $1", [`Devolución #${ret.id} de Venta #${sale.id}%`])).n === 2, "inventory history written");
    expect((await one("select count(*)::int n from return_items where return_id=$1", [ret.id])).n === 2, "return lines written");
  });

  await test("RFD-02.card_refund_needs_the_explicit_confirmation_stores_the_reference_and_never_touches_cash", "integration", async () => {
    const sale = await mkSale({ method: "cash", lines: [{ p: P[1], q: 2 }] });
    const cash0 = await cashNow(), cmov0 = (await one("select count(*)::int n from cash_movements")).n;
    const r = await pay(body(sale, [[0, 1]], { method: "card", reference: "AUT 9K2Q7M" }), admin.pin);
    expect(r.ok && r.v.refundStatus === "paid" && num(r.v.totalRefund) === 10, "card refund: " + J(r));
    const st = await one("select * from refund_settlements where return_id=$1", [r.v.id]);
    expect(st.payment_method === "card" && st.external_reference === "AUT 9K2Q7M" && st.cash_movement_id === null && st.authorized_by === admin.id && st.processed_by === vendor.id, "settlement " + J(st));
    expect(st.cash_session_id === sid, "attached to the open register for the closing report only");
    expect((await cashNow()) === cash0, "cash unchanged");
    expect((await one("select count(*)::int n from cash_movements")).n === cmov0, "no cash movement at all for a card refund");
    // without the register open a card refund is still possible (nothing leaves the drawer)
    await closeStrayCash(db, admin.id);
    const sale2 = await mkSale({ method: "card", lines: [{ p: P[1], q: 1 }] });
    const r2 = await pay(body(sale2, [[0, 1]], { method: "card" }), admin.pin);
    expect(r2.ok, "card refund with the register closed: " + J(r2));
    expect((await one("select cash_session_id from refund_settlements where return_id=$1", [r2.v.id])).cash_session_id === null, "no register to attach to");
    sid = await openRegister(500);
  });

  await test("RFD-03.an_administrator_can_start_and_authorize_with_their_own_PIN_including_legacy_PINs", "integration", async () => {
    await loginAs(admin);
    const sale = await mkSale({ lines: [{ p: P[2], q: 1 }] });
    const r = await pay(body(sale, [[0, 1]]), admin.pin);
    expect(r.ok, J(r));
    const st = await one("select authorized_by, processed_by from refund_settlements where return_id=$1", [r.v.id]);
    expect(st.authorized_by === admin.id && st.processed_by === admin.id, "same person on both: " + J(st));
    // another administrator with a legacy hash authorizes the vendor's operation; the hash is upgraded afterwards
    await loginAs(vendor);
    const sale2 = await mkSale({ lines: [{ p: P[2], q: 1 }] });
    const r2 = await pay(body(sale2, [[0, 1]]), admin2.pin);
    expect(r2.ok, J(r2));
    const st2 = await one("select authorized_by, processed_by from refund_settlements where return_id=$1", [r2.v.id]);
    expect(st2.authorized_by === admin2.id && st2.processed_by === vendor.id, "second administrator authorized for the vendor: " + J(st2));
    expect(/^scrypt\$/.test((await one("select pin_hash from users where id=$1", [admin2.id])).pin_hash), "the legacy hash was upgraded after authorizing");
  });

  await test("RFD-04.a_wrong_PIN_a_seller_PIN_an_inactive_administrator_and_malformed_PINs_write_nothing_and_look_alike", "security", async () => {
    const sale = await mkSale({ lines: [{ p: P[3], q: 2 }] });
    const before = await snap();
    const errs = new Set();
    for (const pin of ["0000", "999999", vendor.pin, vendor2.pin, inactiveAdmin.pin, "", "12", "abcdefgh", null, 604812, "908172635"]) {
      const r = await pay(body(sale, [[0, 1]]), pin);
      expect(code(r) === "AUTORIZACION_INVALIDA" && !LEAKS.test(r.err), `PIN ${J(pin === vendor.pin ? "<seller>" : pin === inactiveAdmin.pin ? "<inactive admin>" : pin)} -> AUTORIZACION_INVALIDA: ` + J(r));
      errs.add(r.err);
    }
    expect(errs.size === 1, "every rejection reads exactly the same (nothing to enumerate): " + J([...errs]));
    expect((await snap()) === before, "no return, stock, cash or settlement was written");
    const me = await call("api.auth.me()");
    expect(me.ok && me.v.id === vendor.id, "the operator is still the vendor");
  });

  await test("RFD-05.the_money_is_never_marked_paid_without_an_explicit_confirmation", "integration", async () => {
    const sale = await mkSale({ lines: [{ p: P[4], q: 1 }] });
    const before = await snap();
    for (const [label, o] of [["cash not confirmed", { confirmed: false }], ["card not confirmed", { method: "card", confirmed: false }]]) {
      const r = await pay(body(sale, [[0, 1]], o), admin.pin);
      expect(code(r) === "CONFIRMACION_REQUERIDA", `${label}: ` + J(r));
    }
    const missing = body(sale, [[0, 1]]);
    delete missing.payment.confirmed;
    expect(code(await pay(missing, admin.pin)) === "CONFIRMACION_REQUERIDA", "confirmation missing");
    const noPayment = body(sale, [[0, 1]]);
    delete noPayment.payment;
    expect(code(await pay(noPayment, admin.pin)) === "REEMBOLSO_INVALIDO", "payment missing");
    for (const bad of ["true", 1, "yes", {}, []]) {
      const payload = body(sale, [[0, 1]]);
      payload.payment.confirmed = bad;
      expect(code(await pay(payload, admin.pin)) === "CONFIRMACION_REQUERIDA", "confirmed must be the boolean true, got " + J(bad));
    }
    expect((await snap()) === before, "nothing was written");
  });

  await test("RFD-06.the_renderer_cannot_inject_amounts_authority_or_status", "security", async () => {
    const sale = await mkSale({ lines: [{ p: P[4], q: 2 }] });
    const before = await snap();
    for (const extra of [{ amount: 1 }, { totalRefund: 1 }, { authorizedBy: admin.id }, { refundStatus: "paid" }, { cashSessionId: 1 }, { processedBy: admin.id }]) {
      const r = await pay(body(sale, [[0, 1]], { extra }), admin.pin);
      expect(code(r) === "CAMPO_NO_PERMITIDO", `${J(extra)} rejected: ` + J(r));
    }
    for (const bad of [{ amount: 5 }, { cashMovementId: 3 }, { paidAt: "2020-01-01" }]) {
      const payload = body(sale, [[0, 1]]);
      Object.assign(payload.payment, bad);
      expect(code(await pay(payload, admin.pin)) === "CAMPO_NO_PERMITIDO", `payment ${J(bad)} rejected`);
    }
    const forged = body(sale, [[0, 1]]);
    forged.items[0].unitPrice = 0.01;
    expect(code(await pay(forged, admin.pin)) === "PRECIO_NO_COINCIDE", "a forged unit price is detected");
    const noop = body(sale, [[0, 1]], { op: "short" });
    expect(code(await pay(noop, admin.pin)) === "OPERACION_INVALIDA", "operationId is mandatory and validated");
    const noop2 = body(sale, [[0, 1]]);
    delete noop2.operationId;
    expect(code(await pay(noop2, admin.pin)) === "OPERACION_INVALIDA", "no operationId");
    for (const method of ["transfer", "CASH", "", null, 1]) {
      const payload = body(sale, [[0, 1]]);
      payload.payment.method = method;
      expect(code(await pay(payload, admin.pin)) === "METODO_INVALIDO", "method " + J(method));
    }
    const cashRef = body(sale, [[0, 1]], { reference: "ABC123" });
    expect(code(await pay(cashRef, admin.pin)) === "REFERENCIA_NO_APLICA", "a reference makes no sense for cash");
    for (const ref of ["<script>", "a".repeat(65), "x\ny", "'; drop table users;--"]) {
      const r = await pay(body(sale, [[0, 1]], { method: "card", reference: ref }), admin.pin);
      expect(code(r) === "REFERENCIA_INVALIDA", `reference ${J(ref)}: ` + J(r));
    }
    expect((await snap()) === before, "every rejected attempt left no trace");
  });

  await test("RFD-07.cash_needs_an_open_register_and_enough_cash_and_a_failure_leaves_no_trace", "integration", async () => {
    // closed register
    await closeStrayCash(db, admin.id);
    const sale = await mkSale({ lines: [{ p: P[5], q: 2 }] });
    const closedSnap = await snap();
    const closed = await pay(body(sale, [[0, 2]], { method: "cash" }), admin.pin);
    expect(code(closed) === "CAJA_CERRADA" && !LEAKS.test(closed.err), "cash without an open register: " + J(closed));
    expect((await snap()) === closedSnap, "rolled back completely (return, stock, movements)");
    // not enough cash
    sid = await openRegister(5);
    const poor = await snap();
    const r = await pay(body(sale, [[0, 2]], { method: "cash" }), admin.pin);
    expect(code(r) === "FONDOS_INSUFICIENTES" && !LEAKS.test(r.err), "20.00 owed but only 5.00 in the register: " + J(r));
    expect((await snap()) === poor, "no return was registered and no stock came back");
    expect((await cashNow()) === 5, "the balance never went negative");
    // exact amount works down to zero
    const sale2 = await mkSale({ lines: [{ p: P[5], q: 1 }, { p: pCheap, q: 2 }] }); // 10.00 + 5.00
    await db.query("update cash_sessions set current_amount='15.00' where closed_at is null");
    const exact = await pay(body(sale2, [[0, 1], [1, 2]], { method: "cash" }), admin.pin);
    expect(exact.ok && (await cashNow()) === 0, "exact balance can be refunded down to 0.00: " + J(exact));
    // the same refund by card still works with no cash
    const sale3 = await mkSale({ lines: [{ p: P[5], q: 1 }] });
    const card = await pay(body(sale3, [[0, 1]], { method: "card" }), admin.pin);
    expect(card.ok && (await cashNow()) === 0, "a card refund needs no cash: " + J(card));
    sid = await openRegister(500);
  });

  await test("RFD-08.partial_then_complete_returns_and_excess_is_rejected_without_a_trace", "integration", async () => {
    const sale = await mkSale({ lines: [{ p: P[6], q: 3 }] });
    const cash0 = await cashNow();
    const a = await pay(body(sale, [[0, 1]], { method: "cash" }), admin.pin);
    expect(a.ok && num(a.v.totalRefund) === 10, "partial: " + J(a));
    const before = await snap();
    const over = await pay(body(sale, [[0, 3]], { method: "cash" }), admin.pin);
    expect(code(over) === "DEVOLUCION_EXCEDE" && /Solo quedan 2/.test(over.err), "only 2 left: " + J(over));
    expect((await snap()) === before, "the excess attempt left no trace");
    const b = await pay(body(sale, [[0, 2]], { method: "card" }), admin.pin);
    expect(b.ok && num(b.v.totalRefund) === 20, "complete the rest by card: " + J(b));
    expect(code(await pay(body(sale, [[0, 1]], { method: "cash" }), admin.pin)) === "DEVOLUCION_EXCEDE", "the sale is exhausted");
    expect((await cashNow()) === cash0 - 10, "cash only left for the cash part (10.00)");
    expect((await one("select coalesce(sum(quantity),0)::int n from return_items where sale_item_id=$1", [sale.items[0].id])).n === 3, "exactly the sold quantity was returned");
  });

  // ------------------------------------------------------------------ idempotency
  await test("RFD-09.the_same_operation_never_pays_twice_and_a_changed_request_is_rejected", "integration", async () => {
    const sale = await mkSale({ lines: [{ p: P[7], q: 4 }, { p: pCheap, q: 2 }] });
    const op = newOp();
    const cash0 = await cashNow(), stock0 = await stockOf(P[7]);
    const first = await pay(body(sale, [[0, 2], [1, 1]], { method: "cash", op }), admin.pin);
    expect(first.ok && first.v.replayed === false, J(first));
    const mid = await snap();
    const same = await pay(body(sale, [[0, 2], [1, 1]], { method: "cash", op }), admin.pin);
    const reordered = await pay(body(sale, [[1, 1], [0, 2]], { method: "cash", op }), "000000"); // a stored result needs no PIN
    expect(same.ok && same.v.replayed === true && same.v.id === first.v.id && reordered.ok && reordered.v.id === first.v.id, "retries return the stored refund: " + J([same, reordered]));
    expect((await snap()) === mid, "no second return, settlement, stock or cash change");
    expect((await cashNow()) === cash0 - 22.5 + 0 && (await stockOf(P[7])) === stock0 + 2, "deducted exactly once");
    for (const [label, o, picks] of [
      ["other quantities", { method: "cash" }, [[0, 1], [1, 1]]],
      ["other lines", { method: "cash" }, [[0, 2]]],
      ["other method", { method: "card" }, [[0, 2], [1, 1]]],
      ["other reason", { method: "cash", reason: "otro motivo" }, [[0, 2], [1, 1]]],
    ]) {
      const r = await pay(body(sale, picks, { ...o, op }), admin.pin);
      expect(code(r) === "OPERACION_DUPLICADA" && !LEAKS.test(r.err), `${label} -> OPERACION_DUPLICADA: ` + J(r));
    }
    // another user cannot replay (or even confirm the existence of) that operation
    await loginAs(vendor2);
    const other = await pay(body(sale, [[0, 2], [1, 1]], { method: "cash", op }), admin.pin);
    expect(code(other) === "OPERACION_DUPLICADA", "another operator -> rejected, not served the stored refund: " + J(other));
    // the pending-payment channel does not accept it either
    await loginAs(vendor);
    const asSettle = await settle({ returnId: first.v.id, payment: { method: "card", confirmed: true }, operationId: op }, admin.pin);
    expect(code(asSettle) === "OPERACION_DUPLICADA", "an operation id cannot be reused to pay with another method: " + J(asSettle));
    expect((await snap()) === mid, "none of the rejected attempts wrote anything");
  });

  await test("RFD-10.a_double_click_and_parallel_retries_create_exactly_one_refund", "integration", async () => {
    for (const method of ["cash", "card"]) {
      const sale = await mkSale({ lines: [{ p: P[8], q: 2 }] });
      const op = newOp();
      const cash0 = await cashNow(), stock0 = await stockOf(P[8]);
      const res = await call(`Promise.allSettled(Array.from({length: 8}, () => api.returns.createWithRefund(${J(body(sale, [[0, 2]], { method, op }))}, ${J(admin.pin)}))).then(rs => rs.map(x => x.status === 'fulfilled' ? { ok: true, v: x.value } : { ok: false, err: x.reason && x.reason.message }))`);
      expect(res.ok && res.v.every((x) => x.ok), `${method}: every parallel attempt is answered with the same refund, no errors: ` + J(res.v.map((x) => x.ok ? x.v.id : x.err)));
      expect(new Set(res.v.map((x) => x.v.id)).size === 1 && res.v.filter((x) => x.v.replayed === false).length === 1, "one real creation, the rest replays");
      expect((await one("select count(*)::int n from returns where sale_id=$1", [sale.id])).n === 1, "one return");
      expect((await one("select count(*)::int n from refund_settlements where operation_id=$1", [op])).n === 1, "one settlement");
      expect((await stockOf(P[8])) === stock0 + 2, "stock restored once");
      expect((await cashNow()) === (method === "cash" ? cash0 - 20 : cash0), "cash moved once (cash) or not at all (card)");
    }
  });

  await test("RFD-11.two_different_operations_on_the_same_lines_cannot_over_return_or_double_pay", "integration", async () => {
    const sale = await mkSale({ lines: [{ p: P[9], q: 2 }] });
    const stock0 = await stockOf(P[9]), cash0 = await cashNow();
    const res = await call(`Promise.allSettled([${[0, 1, 2, 3].map(() => `api.returns.createWithRefund(${J(body(sale, [[0, 2]], { method: "cash", op: newOp() }))}, ${J(admin.pin)})`).join(",")}]).then(rs => rs.map(x => x.status === 'fulfilled' ? { ok: true, v: x.value } : { ok: false, err: x.reason && x.reason.message }))`);
    const okCount = res.v.filter((x) => x.ok).length;
    expect(okCount === 1, "exactly one of four concurrent full returns succeeded: " + J(res.v.map((x) => x.ok ? "ok" : code(x))));
    expect(res.v.filter((x) => !x.ok).every((x) => code(x) === "DEVOLUCION_EXCEDE"), "the others were told there is nothing left to return");
    expect((await stockOf(P[9])) === stock0 + 2 && (await cashNow()) === cash0 - 20, "stock and cash moved once");
  });

  // ------------------------------------------------------------------ atomicity
  await test("RFD-12.a_failure_while_recording_the_payment_rolls_back_inventory_return_and_cash_and_the_retry_pays_once", "integration", async () => {
    for (const method of ["cash", "card"]) {
      const sale = await mkSale({ lines: [{ p: P[10], q: 3 }] });
      const op = newOp();
      const before = await snap(), stock0 = await stockOf(P[10]);
      const failed = await withTrigger("refund_settlements", "before insert", "rfd_boom", "raise exception 'boom refund';", () => pay(body(sale, [[0, 3]], { method, op }), admin.pin));
      expect(code(failed) === "ERROR_INTERNO" && !LEAKS.test(failed.err) && !/boom/.test(failed.err), `${method}: unexpected failure is a generic error: ` + J(failed));
      expect((await snap()) === before, "the whole operation rolled back (return, items, stock, inventory, register, movement)");
      expect((await stockOf(P[10])) === stock0, "stock untouched");
      // the operator is told to verify, retries with the same key: it is paid exactly once
      const retry = await pay(body(sale, [[0, 3]], { method, op }), admin.pin);
      expect(retry.ok && retry.v.replayed === false && retry.v.refundStatus === "paid", "retry after the uncertain error: " + J(retry));
      const retry2 = await pay(body(sale, [[0, 3]], { method, op }), admin.pin);
      expect(retry2.ok && retry2.v.replayed === true && retry2.v.id === retry.v.id, "a second retry is a replay");
      expect((await one("select count(*)::int n from refund_settlements where operation_id=$1", [op])).n === 1, "one settlement");
    }
  });

  await test("RFD-13.a_failure_after_the_cash_movement_also_restores_the_register_balance", "integration", async () => {
    const sale = await mkSale({ lines: [{ p: P[11], q: 1 }] });
    const before = await snap(), cash0 = await cashNow();
    // fail on the LAST write (the status change), after the register was debited and the settlement inserted
    const failed = await withTrigger("returns", "before update", "rfd_boom2", "if new.refund_status = 'paid' then raise exception 'late boom'; end if; return new;", () => pay(body(sale, [[0, 1]], { method: "cash" }), admin.pin));
    expect(code(failed) === "ERROR_INTERNO", "late failure: " + J(failed));
    expect((await snap()) === before && (await cashNow()) === cash0, "register, movement, settlement, return and stock all rolled back");
  });

  // ------------------------------------------------------------------ concurrency with sales, movements and closing
  await test("RFD-14.refunds_sales_withdrawals_and_card_refunds_in_parallel_neither_deadlock_nor_lose_cash", "integration", async () => {
    sid = await openRegister(1000);
    const sales = [];
    for (let i = 0; i < 6; i++) sales.push(await mkSale({ lines: [{ p: P[i], q: 1 }] }));
    const cardSales = [];
    for (let i = 0; i < 3; i++) cardSales.push(await mkSale({ method: "card", lines: [{ p: P[i], q: 1 }] }));
    const mk = (p) => ({ items: [{ productId: p.id, quantity: 1, unitPrice: num(p.price), subtotal: num(p.price) }], total: num(p.price), paymentMethod: "cash", sessionId: sid, operationId: newOp() });
    const calls = [
      ...sales.map((s) => `api.returns.createWithRefund(${J(body(s, [[0, 1]], { method: "cash" }))}, ${J(admin.pin)})`),
      ...cardSales.map((s) => `api.returns.createWithRefund(${J(body(s, [[0, 1]], { method: "card" }))}, ${J(admin.pin)})`),
      ...P.slice(0, 6).map((p) => `api.sales.create(${J(mk(p))})`),
      ...[1, 2, 3].map((i) => `api.cash.addMovement(${J({ sessionId: sid, type: "OUT", amount: i, reason: "retiro e2e " + i })})`),
      ...[1, 2].map((i) => `api.cash.addMovement(${J({ sessionId: sid, type: "IN", amount: i, reason: "ingreso e2e " + i })})`),
    ];
    const res = await call(`Promise.allSettled([${calls.join(",")}]).then(rs => rs.map(x => x.status === 'fulfilled' ? { ok: true, v: x.value } : { ok: false, err: x.reason && x.reason.message }))`);
    expect(res.ok && res.v.every((x) => x.ok), "every operation succeeded (no deadlock, no internal error): " + J(res.v.filter((x) => !x.ok).map((x) => x.err)));
    const reg = await register();
    const m = await one(
      `select coalesce(sum(case when type='IN' then amount else -amount end),0)::numeric n from cash_movements where session_id=$1`,
      [sid]
    );
    expect(num(reg.current_amount) === num(reg.initial_amount) + num(m.n), `balance ${reg.current_amount} = initial ${reg.initial_amount} + movements ${m.n}`);
    expect((await one("select count(*)::int n from refund_settlements where cash_session_id=$1", [sid])).n === 9, "9 settlements (6 cash + 3 card)");
    const cashRefunds = num((await one("select coalesce(sum(amount),0)::numeric n from refund_settlements where cash_session_id=$1 and payment_method='cash'", [sid])).n);
    expect(cashRefunds === 60, "6 cash refunds of 10.00");
  });

  await test("RFD-15.closing_the_register_races_with_refunds_without_deadlock_and_without_money_after_the_close", "integration", async () => {
    sid = await openRegister(200);
    const sales = [];
    for (let i = 0; i < 4; i++) sales.push(await mkSale({ lines: [{ p: P[i], q: 1 }] }));
    const calls = [
      ...sales.map((s) => `api.returns.createWithRefund(${J(body(s, [[0, 1]], { method: "cash" }))}, ${J(admin.pin)})`),
      `api.cash.closeSession(${sid}, 0)`,
    ];
    const res = await call(`Promise.allSettled([${calls.join(",")}]).then(rs => rs.map(x => x.status === 'fulfilled' ? { ok: true, v: x.value } : { ok: false, err: x.reason && x.reason.message }))`);
    expect(res.ok && res.v.every((x) => x.ok || ["CAJA_CERRADA"].includes(code(x))), "refunds either completed or were told the register is closed: " + J(res.v.map((x) => x.ok ? "ok" : code(x))));
    const s = await one("select * from cash_sessions where id=$1", [sid]);
    expect(s.status === "closed", "the register closed");
    const after = await one("select coalesce(sum(amount),0)::numeric n from refund_settlements where cash_session_id=$1 and payment_method='cash' and paid_at > $2", [sid, s.closed_at]);
    expect(num(after.n) === 0, "no cash refund was registered in that register after it closed");
    const done = res.v.slice(0, 4).filter((x) => x.ok).length;
    expect(num(s.current_amount) === 200 - done * 10, "the closing saw every refund that was committed before it: balance " + s.current_amount);
    sid = await openRegister(500);
  });

  // ------------------------------------------------------------------ cash-register reporting of refunds
  await test("RFD-16.the_register_summary_separates_cash_refunds_from_manual_withdrawals_and_reconciles", "integration", async () => {
    await loginAs(admin);
    sid = await openRegister(300);
    const cashSale = await call(`api.sales.create(${J({ items: [{ productId: P[0].id, quantity: 2, unitPrice: 10, subtotal: 20 }], total: 20, paymentMethod: "cash", sessionId: sid, operationId: newOp() })})`);
    expect(cashSale.ok, J(cashSale));
    const w = await call(`api.cash.addMovement(${J({ sessionId: sid, type: "OUT", amount: 7, reason: "retiro manual" })})`);
    expect(w.ok, J(w));
    const sale = await mkSale({ method: "card", lines: [{ p: P[1], q: 4 }], sessionId: sid }); // informational: not part of the cash
    expect((await pay(body(sale, [[0, 1]], { method: "cash" }), admin.pin)).ok, "cash refund 10");
    expect((await pay(body(sale, [[0, 2]], { method: "card", reference: "T-1" }), admin.pin)).ok, "card refund 20");
    const sum = await call(`api.cash.getSessionSummary(${sid})`);
    expect(sum.ok, J(sum));
    const s = sum.v;
    expect(num(s.movements.manualOut.total) === 7 && s.movements.manualOut.count === 1, "the manual withdrawals do NOT include the refund: " + J(s.movements.manualOut));
    expect(num(s.refunds.cash.total) === 10 && s.refunds.cash.count === 1 && num(s.refunds.card.total) === 20 && s.refunds.card.count === 1, "refunds by method: " + J(s.refunds));
    expect(num(s.expected.fromRecords) === 300 + 20 - 7 - 10 && s.expected.reconciles && num(s.expected.registerBalance) === 303, "expected cash subtracts the cash refund once and the card refund never: " + J(s.expected));
    const list = await call("api.cash.listSessions({pageSize:5})");
    const row = list.v.rows.find((r) => r.id === sid);
    expect(num(row.cashRefunds) === 10 && num(row.cardRefunds) === 20, "the history list carries the refunds paid in the session: " + J(row));
    const closed = await call(`api.cash.closeSession(${sid}, 303)`);
    expect(closed.ok && num(closed.v.finalAmount) === 303, "closes at the expected amount: " + J(closed));
    const after = await call(`api.cash.getSessionSummary(${sid})`);
    expect(num(after.v.closing.difference) === 0 && num(after.v.refunds.cash.total) === 10, "difference 0 after closing, refunds unchanged: " + J(after.v.closing));
    sid = await openRegister(500);
  });

  await test("RFD-17.no_PIN_is_stored_logged_or_returned_anywhere", "security", async () => {
    // 6-8 digit PINs only: a 4-digit PIN could collide by chance with an id or a timestamp in the text being searched
    const WRONG = "73910462";
    const sale = await mkSale({ lines: [{ p: P[2], q: 1 }] });
    const r = await pay(body(sale, [[0, 1]], { method: "card", reference: "REF-PIN-TEST" }), admin.pin);
    const bad = await pay(body(sale, [[0, 1]]), WRONG);
    expect(r.ok && bad.ok === false, "setup: one accepted, one rejected");
    const text = J([r, bad, await call("api.returns.getAll()")]);
    for (const p of [admin.pin, WRONG]) expect(!text.includes(p), "a PIN value (" + p.length + " digits) appears in a response");
    const logged = mainLog.join("\n");
    expect(!containsSecret(logged), "no secret in the main log");
    for (const p of [admin.pin, WRONG]) expect(!logged.includes(p), "a PIN (" + p.length + " digits) was written to the main log");
    // the database: no table has a column that could hold it (only salted hashes of PINs exist, in users)
    const cols = await rows("select table_name, column_name from information_schema.columns where table_schema='public' and column_name ~* 'pin'");
    expect(J(cols.map((x) => x.table_name + "." + x.column_name)) === J(["users.pin_hash"]), "the only PIN-related column is users.pin_hash: " + J(cols));
    const st = await one("select * from refund_settlements where return_id=$1", [r.v.id]);
    expect(!J(st).includes(admin.pin) && !J(await rows("select * from returns")).includes(admin.pin), "the settlement and return rows carry ids, not PINs");
  });

  await test("RFD-18.the_settlement_ledger_reconciles_with_returns_and_the_register", "integration", async () => {
    const orphanPaid = await one("select count(*)::int n from returns r where r.refund_status='paid' and not exists (select 1 from refund_settlements s where s.return_id=r.id)");
    const orphanSettlement = await one("select count(*)::int n from refund_settlements s join returns r on r.id=s.return_id where r.refund_status<>'paid'");
    expect(orphanPaid.n === 0 && orphanSettlement.n === 0, `every paid return has exactly one settlement and vice versa: ${J([orphanPaid, orphanSettlement])}`);
    const amountMismatch = await one("select count(*)::int n from refund_settlements s join returns r on r.id=s.return_id where s.amount <> r.total_refund or s.amount <> (select coalesce(sum(refund_amount),0) from return_items i where i.return_id=r.id)");
    expect(amountMismatch.n === 0, "settlement amounts equal the persisted return amounts");
    const cashOrphans = await one("select count(*)::int n from refund_settlements s where s.payment_method='cash' and not exists (select 1 from cash_movements m where m.id=s.cash_movement_id and m.type='OUT' and m.amount=s.amount and m.session_id=s.cash_session_id)");
    expect(cashOrphans.n === 0, "every cash settlement has its matching register movement");
    const cardMovements = await one("select count(*)::int n from refund_settlements s where s.payment_method='card' and s.cash_movement_id is not null");
    expect(cardMovements.n === 0, "no card settlement carries a register movement");
    const dupMove = await one("select count(*)::int n from (select cash_movement_id from refund_settlements where cash_movement_id is not null group by 1 having count(*)>1) x");
    expect(dupMove.n === 0, "no movement is tied to two refunds");
    const noAuth = await one("select count(*)::int n from refund_settlements s join users u on u.id=s.authorized_by where u.role <> 'admin'");
    expect(noAuth.n === 0, "every refund was authorized by an administrator");
    // the database itself refuses an incoherent settlement, whatever code writes it
    const bad = async (sql, p) => { try { await db.query(sql, p); return "inserted"; } catch (e) { return e.code; } };
    const anyReturn = (await one("select id from returns where refund_status='pending' limit 1"))?.id ?? (await one("select id from returns limit 1")).id;
    expect(["23514", "23505"].includes(await bad("insert into refund_settlements(return_id,payment_method,amount,authorized_by,processed_by) values($1,'cash','1.00',$2,$2)", [anyReturn, admin.id])), "a cash settlement without register/movement violates the check");
    expect((await bad("insert into refund_settlements(return_id,payment_method,amount,authorized_by,processed_by,external_reference) values($1,'card','-1.00',$2,$2,'x')", [anyReturn, admin.id])) === "23514", "negative amounts are refused");
  });

  // ================================================================== block C: pending returns
  const mkPending = async (picks, o = {}) => {
    const sale = o.sale ?? (await mkSale({ method: o.saleMethod ?? "cash", lines: o.lines ?? [{ p: P[0], q: 3 }] }));
    const r = await call(`api.returns.create(${J({ saleId: sale.id, reason: "pendiente e2e", items: picks.map(([i, q]) => ({ saleItemId: sale.items[i].id, quantity: q })) })})`);
    expect(r.ok && r.v.refundStatus === "pending", "pending return: " + J(r));
    return { sale, ret: r.v };
  };
  const spay = (ret, o = {}) => ({ returnId: ret.id, payment: { method: o.method ?? "cash", confirmed: o.confirmed === undefined ? true : o.confirmed, ...(o.reference ? { reference: o.reference } : {}) }, operationId: o.op ?? newOp() });
  const stateOf = (retId) => one("select r.refund_status s, (select count(*)::int from refund_settlements where return_id=r.id) n from returns r where r.id=$1", [retId]);

  await test("RFD-20.a_pending_return_is_paid_in_cash_once_without_touching_stock_or_return_lines", "integration", async () => {
    await loginAs(vendor);
    sid = await openRegister(200);
    const { ret } = await mkPending([[0, 2]], { lines: [{ p: P[0], q: 3 }] });
    const stock0 = await stockOf(P[0]), cash0 = await cashNow();
    const items0 = (await one("select count(*)::int n from return_items")).n, inv0 = (await one("select count(*)::int n from inventory_movements")).n, ret0 = (await one("select count(*)::int n from returns")).n;
    const r = await settle(spay(ret, { method: "cash" }), admin.pin);
    expect(r.ok && r.v.refundStatus === "paid" && r.v.id === ret.id && r.v.replayed === false && num(r.v.totalRefund) === 20, "settled: " + J(r));
    expect((await stockOf(P[0])) === stock0, "stock was NOT incremented a second time");
    expect((await one("select count(*)::int n from return_items")).n === items0 && (await one("select count(*)::int n from inventory_movements")).n === inv0 && (await one("select count(*)::int n from returns")).n === ret0, "no return lines, stock movements or returns were created");
    expect((await cashNow()) === cash0 - 20, "the register lost exactly 20.00");
    const st = await one("select * from refund_settlements where return_id=$1", [ret.id]);
    const row = await one("select * from returns where id=$1", [ret.id]);
    expect(st.payment_method === "cash" && st.authorized_by === admin.id && st.processed_by === vendor.id && st.cash_session_id === sid && st.cash_movement_id !== null, "traceability: " + J(st));
    expect(row.processed_by === vendor.id && new Date(st.paid_at) > new Date(row.created_at), "the return keeps who registered it; the payment date is later than the return date");
    expect(/Reembolso en efectivo/.test((await one("select reason from cash_movements where id=$1", [st.cash_movement_id])).reason), "register movement written");
  });

  await test("RFD-21.a_pending_return_can_be_paid_by_card_with_a_reference_and_no_cash_moves", "integration", async () => {
    const { ret } = await mkPending([[0, 1]], { saleMethod: "cash" });
    const cash0 = await cashNow(), cmov0 = (await one("select count(*)::int n from cash_movements")).n;
    const r = await settle(spay(ret, { method: "card", reference: "TERM-77/B" }), admin2.pin);
    expect(r.ok && r.v.refundStatus === "paid", J(r));
    const st = await one("select * from refund_settlements where return_id=$1", [ret.id]);
    expect(st.payment_method === "card" && st.external_reference === "TERM-77/B" && st.authorized_by === admin2.id && st.cash_movement_id === null, "card settlement " + J(st));
    expect((await cashNow()) === cash0 && (await one("select count(*)::int n from cash_movements")).n === cmov0, "cash and movements untouched");
  });

  await test("RFD-22.an_already_paid_return_is_refused_whatever_the_channel_or_the_method", "integration", async () => {
    const { ret } = await mkPending([[0, 1]]);
    expect((await settle(spay(ret), admin.pin)).ok, "first payment");
    const cash0 = await cashNow(), before = await snap();
    for (const method of ["cash", "card"]) {
      const again = await settle(spay(ret, { method }), admin.pin);
      expect(code(again) === "REEMBOLSO_YA_PAGADO" && !LEAKS.test(again.err), `paying it again by ${method}: ` + J(again));
    }
    expect((await snap()) === before && (await cashNow()) === cash0, "nothing changed");
    // a return that was created and paid in one go cannot be paid again either
    const sale = await mkSale({ lines: [{ p: P[1], q: 1 }] });
    const created = await pay(body(sale, [[0, 1]], { method: "card" }), admin.pin);
    expect(created.ok, J(created));
    expect(code(await settle(spay(created.v, { method: "cash" }), admin.pin)) === "REEMBOLSO_YA_PAGADO", "paid-at-creation returns are final too");
    expect((await stateOf(ret.id)).n === 1 && (await stateOf(created.v.id)).n === 1, "exactly one settlement each");
  });

  await test("RFD-23.legacy_returns_are_never_turned_into_paid_automatically_or_by_accident", "integration", async () => {
    const sale = await mkSale({ lines: [{ p: P[2], q: 2 }] });
    const legacy = await one("insert into returns(sale_id,total_refund,reason,processed_by,refund_status) values($1,'10.00','anterior al control',$2,'legacy_unspecified') returning id", [sale.id, admin.id]);
    await db.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values($1,$2,$3,1,'10.00')", [legacy.id, sale.items[0].id, P[2].id]);
    const before = await snap();
    const r = await settle(spay(legacy), admin.pin);
    expect(code(r) === "REEMBOLSO_LEGACY" && !LEAKS.test(r.err), "legacy refund cannot be paid from here: " + J(r));
    const wrongPin = await settle(spay(legacy), "73910462");
    expect(code(wrongPin) === "REEMBOLSO_LEGACY", "the state is explained before any PIN is asked for: " + J(wrongPin));
    expect((await snap()) === before && (await stateOf(legacy.id)).s === "legacy_unspecified" && (await stateOf(legacy.id)).n === 0, "still legacy_unspecified, no settlement, nothing written");
    expect(code(await settle(spay({ id: 99999999 }), admin.pin)) === "DEVOLUCION_NO_ENCONTRADA", "unknown return");
    const listed = await call("api.returns.getAll()");
    const l = listed.v.find((x) => x.id === legacy.id);
    expect(l && l.refundStatus === "legacy_unspecified" && l.paymentMethod === null && l.paidAt === null, "history keeps it as legacy: " + J(l));
  });

  await test("RFD-24.paying_a_pending_return_needs_the_PIN_and_the_confirmation_and_needs_cash_for_cash", "integration", async () => {
    const { ret } = await mkPending([[0, 1]]);
    const before = await snap();
    expect(code(await settle(spay(ret), vendor.pin)) === "AUTORIZACION_INVALIDA", "a seller's PIN does not authorize");
    expect(code(await settle(spay(ret), inactiveAdmin.pin)) === "AUTORIZACION_INVALIDA", "an inactive administrator does not authorize");
    expect(code(await settle(spay(ret, { confirmed: false }), admin.pin)) === "CONFIRMACION_REQUERIDA", "no confirmation, no payment");
    expect(code(await settle({ ...spay(ret), amount: 1 }, admin.pin)) === "CAMPO_NO_PERMITIDO", "no client amount");
    expect((await snap()) === before && (await stateOf(ret.id)).s === "pending", "still pending, nothing written");
    // closed register: cash refused, card allowed
    await closeStrayCash(db, admin.id);
    const closed = await settle(spay(ret, { method: "cash" }), admin.pin);
    expect(code(closed) === "CAJA_CERRADA" && (await stateOf(ret.id)).s === "pending", "cash needs an open register: " + J(closed));
    // not enough cash
    sid = await openRegister(3);
    const poor = await settle(spay(ret, { method: "cash" }), admin.pin);
    expect(code(poor) === "FONDOS_INSUFICIENTES" && (await stateOf(ret.id)).s === "pending" && (await cashNow()) === 3, "10.00 owed, 3.00 in the register: " + J(poor));
    const card = await settle(spay(ret, { method: "card" }), admin.pin);
    expect(card.ok && (await cashNow()) === 3, "paying the same return by card is still possible: " + J(card));
    sid = await openRegister(500);
  });

  await test("RFD-25.the_same_payment_is_idempotent_and_competing_payments_pay_once", "integration", async () => {
    const { ret } = await mkPending([[0, 2]]);
    const cash0 = await cashNow();
    const op = newOp();
    const res = await call(`Promise.allSettled(Array.from({length: 6}, () => api.returns.settleRefund(${J(spay(ret, { method: "cash", op }))}, ${J(admin.pin)}))).then(rs => rs.map(x => x.status === 'fulfilled' ? { ok: true, v: x.value } : { ok: false, err: x.reason && x.reason.message }))`);
    expect(res.v.every((x) => x.ok) && new Set(res.v.map((x) => x.v.settlement.id)).size === 1 && res.v.filter((x) => !x.v.replayed).length === 1, "double click: one payment, the rest replays: " + J(res.v.map((x) => x.ok ? x.v.replayed : x.err)));
    expect((await cashNow()) === cash0 - 20 && (await stateOf(ret.id)).n === 1, "paid once");
    // different operations racing for the same pending return, mixing methods
    const { ret: ret2 } = await mkPending([[0, 1]]);
    const cash1 = await cashNow();
    const calls = ["cash", "card", "cash", "card", "cash", "card"].map((method) => `api.returns.settleRefund(${J(spay(ret2, { method }))}, ${J(admin.pin)})`);
    const race = await call(`Promise.allSettled([${calls.join(",")}]).then(rs => rs.map(x => x.status === 'fulfilled' ? { ok: true, v: x.value } : { ok: false, err: x.reason && x.reason.message }))`);
    expect(race.v.filter((x) => x.ok).length === 1, "exactly one of six competing payments won: " + J(race.v.map((x) => x.ok ? "ok" : code(x))));
    expect(race.v.filter((x) => !x.ok).every((x) => code(x) === "REEMBOLSO_YA_PAGADO"), "the others were told it is already paid");
    const st = await one("select payment_method m from refund_settlements where return_id=$1", [ret2.id]);
    expect((await stateOf(ret2.id)).n === 1 && (await cashNow()) === (st.m === "cash" ? cash1 - 10 : cash1), "one settlement; cash moved only if the winner was cash");
  });

  await test("RFD-26.a_failure_while_paying_a_pending_return_leaves_it_pending_and_the_retry_pays_once", "integration", async () => {
    const { ret } = await mkPending([[0, 1]]);
    const before = await snap(), cash0 = await cashNow(), op = newOp();
    const failed = await withTrigger("returns", "before update", "rfd_boom3", "if new.refund_status = 'paid' then raise exception 'late boom'; end if; return new;", () => settle(spay(ret, { method: "cash", op }), admin.pin));
    expect(code(failed) === "ERROR_INTERNO" && !LEAKS.test(failed.err), "unexpected failure is generic: " + J(failed));
    expect((await snap()) === before && (await cashNow()) === cash0 && (await stateOf(ret.id)).s === "pending", "pending, no movement, no settlement");
    const retry = await settle(spay(ret, { method: "cash", op }), admin.pin);
    expect(retry.ok && retry.v.replayed === false && (await cashNow()) === cash0 - 10, "retry with the same key pays exactly once: " + J(retry));
  });

  await test("RFD-27.the_history_distinguishes_pending_paid_in_cash_paid_by_card_and_legacy_with_who_authorized", "integration", async () => {
    const stillPending = await mkPending([[0, 1]]);
    const list = await call("api.returns.getAll()");
    expect(list.ok, J(list));
    expect(list.v.some((r) => r.id === stillPending.ret.id), "the newest return is listed");
    const by = (s, m) => list.v.filter((r) => r.refundStatus === s && (m === undefined || r.paymentMethod === m));
    expect(by("pending").length >= 1 && by("pending").every((r) => r.paymentMethod === null && r.paidAt === null && r.authorizedByName === null), "pending rows carry no payment data");
    expect(by("paid", "cash").length >= 1 && by("paid", "card").length >= 1, "both paid variants are present");
    expect(by("paid").every((r) => r.authorizedByName && r.paidByName && r.paidAt && num(r.paidAmount) === num(r.totalRefund)), "every paid row names who authorized, who attended, when and how much");
    expect(by("legacy_unspecified").length >= 1, "legacy rows are listed apart");
    const cardRow = by("paid", "card").find((r) => r.externalReference);
    expect(cardRow && cardRow.cashSessionId !== undefined, "the card reference is exposed");
    expect(Object.keys(list.v[0]).every((k) => !/pin|hash/i.test(k)), "no PIN or hash in the listing");
  });

  void connectRunDb; void waitFor;
}
