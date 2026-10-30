// Integration suite: transactional integrity of sales, cash and inventory, exercised through the real IPC
// (after a real visual login as an administrator) with every outcome verified in PostgreSQL.
// The six bugs confirmed in Phase 0.5 are fixed; their former KNOWN_FAIL probes now assert the
// corrected behaviour as normal tests (ids "BUG-n.fixed.*").
import { ui, ipc, expect, money, sleep } from "../lib/harness.mjs";

const LEAKS_SQL = /Failed query|params:|(select|insert into|update|delete from) .*(from|set|values) /i;

export async function run(c) {
  const { page, db, data, test } = c;
  const admin = await data.user("ADMIN", "admin");
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  // a business rejection carries a stable code AND never leaks SQL text or query parameters
  const biz = (r, code) => r.ok === false && String(r.err).includes(`[${code}]`) && !LEAKS_SQL.test(String(r.err));
  const failedAt = async (mark, channel, sqlObj) => { await sleep(400); return new RegExp(`unexpected error in ${channel}[\\s\\S]*${sqlObj}`).test(c.mainLog.slice(mark).join("\n")); };
  const round2 = (n) => Math.round(n * 100) / 100;
  const payload = (sessionId, lines, method = "cash", over = {}) => {
    const items = lines.map(({ p, q }) => ({ productId: p.id, quantity: q, unitPrice: p.price, subtotal: round2(p.price * q) }));
    return { items, total: round2(items.reduce((a, i) => a + i.subtotal, 0)), paymentMethod: method, sessionId, ...over };
  };
  const sell = (body) => ipc(page, `api.sales.create(${JSON.stringify(body)})`);
  const openSession = async (amount = 100) => {
    const r = await ipc(page, `api.cash.openSession(${amount})`);
    expect(r.ok, "open session failed: " + r.err);
    return r.v.id;
  };
  const closeAll = async () => {
    for (const row of (await db.query("select id from cash_sessions where closed_at is null")).rows) await ipc(page, `api.cash.closeSession(${row.id},0)`);
  };
  const stockOf = async (p) => Number((await one("select stock from products where id=$1", [p.id])).stock);
  const cashOf = async (sid) => money((await one("select current_amount from cash_sessions where id=$1", [sid])).current_amount);
  const snap = async () => JSON.stringify(await one(`select (select count(*) from sales)::int sales, (select count(*) from sale_items)::int items,
    (select count(*) from inventory_movements)::int inv, (select count(*) from cash_movements)::int cmov,
    (select coalesce(sum(stock),0) from products)::int stock, (select coalesce(sum(current_amount),0) from cash_sessions)::text cash`));
  // every test starts with no open cash session, so tests cannot depend on each other
  const t = (id, kind, fn, opts) => test(id, kind, async () => { await closeAll(); return fn(); }, opts);

  await test("I0.admin_visual_login", "e2e", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
  });

  // ------------------------------------------------------------------ sales: valid
  await t("SALE-01.valid_cash_sale_persists_everything_with_the_session_user", "integration", async () => {
    const p = await data.product("S1", "12.34", 5);
    const sid = await openSession(10);
    const r = await sell(payload(sid, [{ p, q: 2 }]));
    expect(r.ok, r.err);
    const sale = await one("select * from sales where id=$1", [r.v.id]);
    expect(sale.user_id === admin.id && sale.payment_method === "cash" && sale.cash_session_id === sid && money(sale.total) === 24.68, "sale row " + JSON.stringify(sale));
    const it = (await db.query("select * from sale_items where sale_id=$1", [sale.id])).rows;
    expect(it.length === 1 && it[0].quantity === 2 && money(it[0].unit_price) === 12.34 && money(it[0].subtotal) === 24.68, "sale item");
    expect((await stockOf(p)) === 3, "stock 3");
    const inv = (await db.query("select * from inventory_movements where product_id=$1", [p.id])).rows;
    expect(inv.length === 1 && inv[0].type === "OUT" && inv[0].amount === -2 && inv[0].user_id === admin.id && inv[0].reason === `Venta #${sale.id}`, "inventory movement");
    const cm = (await db.query("select * from cash_movements where session_id=$1 and reason like $2", [sid, `Venta #${sale.id}%`])).rows;
    expect(cm.length === 1 && cm[0].type === "IN" && money(cm[0].amount) === 24.68 && cm[0].user_id === admin.id, "cash movement");
    expect((await cashOf(sid)) === 34.68, "cash 34.68");
  });
  await t("SALE-02.valid_card_sale_does_not_change_cash", "integration", async () => {
    const p = await data.product("S2", "20.00", 3);
    const sid = await openSession(50);
    const r = await sell(payload(sid, [{ p, q: 1 }], "card"));
    expect(r.ok, r.err);
    expect((await cashOf(sid)) === 50, "cash unchanged");
    const cm = (await db.query("select amount, reason from cash_movements where session_id=$1 and reason like $2", [sid, `Venta #${r.v.id}%`])).rows;
    expect(cm.length === 1 && money(cm[0].amount) === 0 && /Tarjeta \(\$20\.00\)/.test(cm[0].reason), "informational card movement " + JSON.stringify(cm));
    expect((await stockOf(p)) === 2, "stock 2");
  });
  await t("SALE-03.float_prone_prices_are_exact", "integration", async () => {
    const p = await data.product("S3", "0.10", 100);
    const q = await data.product("S3B", "19.99", 100);
    const sid = await openSession(0);
    const r = await sell(payload(sid, [{ p, q: 3 }, { p: q, q: 3 }]));
    expect(r.ok, r.err);
    expect(money((await one("select total from sales where id=$1", [r.v.id])).total) === 60.27, "0.30 + 59.97 = 60.27 exactly");
  });

  // ------------------------------------------------------------------ sales: rejected, nothing persisted
  const rejectedSale = async (id, code, build) =>
    t(id, "integration", async () => {
      const p = await data.product(id.replace(/\W/g, "").slice(0, 12), "10.00", 5);
      const sid = await openSession(100);
      const before = await snap();
      const r = await sell(build(p, sid));
      expect(biz(r, code), `expected [${code}] got ${JSON.stringify(r)}`);
      expect((await snap()) === before, "a rejected sale must leave no trace");
      expect((await stockOf(p)) === 5, "stock untouched");
    });
  await rejectedSale("SALE-04.manipulated_total_is_rejected", "TOTAL_INCORRECTO", (p, sid) => payload(sid, [{ p, q: 2 }], "cash", { total: 0.01 }));
  await rejectedSale("SALE-05.manipulated_unit_price_is_rejected", "PRECIO_DESACTUALIZADO", (p, sid) => {
    const b = payload(sid, [{ p, q: 2 }]); b.items[0].unitPrice = 1; b.items[0].subtotal = 2; b.total = 2; return b;
  });
  await rejectedSale("SALE-06.manipulated_subtotal_is_rejected", "SUBTOTAL_INCORRECTO", (p, sid) => {
    const b = payload(sid, [{ p, q: 2 }]); b.items[0].subtotal = 1; return b;
  });
  await rejectedSale("SALE-07.negative_quantity_is_rejected", "CANTIDAD_INVALIDA", (p, sid) => { const b = payload(sid, [{ p, q: 1 }]); b.items[0].quantity = -1; return b; });
  await rejectedSale("SALE-08.decimal_quantity_is_rejected", "CANTIDAD_INVALIDA", (p, sid) => { const b = payload(sid, [{ p, q: 1 }]); b.items[0].quantity = 1.5; return b; });
  await rejectedSale("SALE-09.zero_quantity_is_rejected", "CANTIDAD_INVALIDA", (p, sid) => { const b = payload(sid, [{ p, q: 1 }]); b.items[0].quantity = 0; return b; });
  await rejectedSale("SALE-10.nonexistent_product_is_rejected", "PRODUCTO_NO_ENCONTRADO", (p, sid) => { const b = payload(sid, [{ p, q: 1 }]); b.items[0].productId = 987654321; return b; });
  await rejectedSale("SALE-11.empty_sale_is_rejected", "VENTA_SIN_ITEMS", (p, sid) => ({ items: [], total: 0, paymentMethod: "cash", sessionId: sid }));
  await rejectedSale("SALE-12.insufficient_stock_is_rejected", "STOCK_INSUFICIENTE", (p, sid) => payload(sid, [{ p, q: 6 }]));
  await rejectedSale("SALE-13.duplicate_items_cannot_split_the_stock_check", "ITEM_DUPLICADO", (p, sid) => {
    const b = payload(sid, [{ p, q: 3 }]); b.items.push({ ...b.items[0] }); b.total = 60; return b;
  });
  await rejectedSale("SALE-14.invalid_payment_method_is_rejected", "PAGO_INVALIDO", (p, sid) => payload(sid, [{ p, q: 1 }], "cheque"));
  await t("SALE-15.nan_total_is_rejected", "integration", async () => {
    const p = await data.product("S15", "10.00", 5);
    const sid = await openSession(1);
    const before = await snap();
    const r = await ipc(page, `api.sales.create({items:[{productId:${p.id},quantity:1,unitPrice:10,subtotal:10}],total:NaN,paymentMethod:'cash',sessionId:${sid}})`);
    expect(biz(r, "IMPORTE_INVALIDO"), JSON.stringify(r));
    expect((await snap()) === before, "no trace");
  });
  await t("SALE-21.amounts_beyond_numeric_12_2_are_rejected_cleanly", "integration", async () => {
    const p = await data.product("S21", "9999999999.99", 100);
    const sid = await openSession(1);
    const before = await snap();
    const r = await sell({ items: [{ productId: p.id, quantity: 2, unitPrice: 9999999999.99, subtotal: 9999999999.99 }], total: 9999999999.99, paymentMethod: "card", sessionId: sid });
    expect(biz(r, "IMPORTE_INVALIDO"), JSON.stringify(r));
    expect((await snap()) === before, "no trace");
    const ok = await sell({ items: [{ productId: p.id, quantity: 1, unitPrice: 9999999999.99, subtotal: 9999999999.99 }], total: 9999999999.99, paymentMethod: "card", sessionId: sid });
    expect(ok.ok, "the maximum amount itself is still accepted: " + ok.err);
  });
  await t("SALE-16.inactive_product_cannot_be_sold", "integration", async () => {
    const p = await data.product("S16", "10.00", 5);
    await db.query("update products set status='inactive' where id=$1", [p.id]);
    const sid = await openSession(1);
    const r = await sell(payload(sid, [{ p, q: 1 }]));
    expect(biz(r, "PRODUCTO_NO_DISPONIBLE"), JSON.stringify(r));
    expect((await stockOf(p)) === 5, "stock untouched");
  });
  await t("SALE-17.deleted_product_cannot_be_sold", "integration", async () => {
    const p = await data.product("S17", "10.00", 5);
    const sid = await openSession(1);
    expect((await ipc(page, `api.products.softDelete(${p.id},'e2e')`)).ok, "soft delete");
    const r = await sell(payload(sid, [{ p, q: 1 }]));
    expect(biz(r, "PRODUCTO_NO_DISPONIBLE"), JSON.stringify(r));
  });
  await t("SALE-18.sale_without_cash_session_is_rejected", "integration", async () => {
    const p = await data.product("S18", "10.00", 5);
    const before = await snap();
    const r = await sell({ ...payload(1, [{ p, q: 1 }]), sessionId: null });
    expect(biz(r, "CAJA_REQUERIDA"), JSON.stringify(r));
    expect((await snap()) === before, "no trace");
  });
  await t("SALE-19.sale_on_closed_session_is_rejected", "integration", async () => {
    const p = await data.product("S19", "10.00", 5);
    const sid = await openSession(1);
    expect((await ipc(page, `api.cash.closeSession(${sid},1)`)).ok, "close");
    const before = await snap();
    const r = await sell(payload(sid, [{ p, q: 1 }]));
    expect(biz(r, "CAJA_CERRADA"), JSON.stringify(r));
    expect((await snap()) === before, "no trace");
  });
  await t("SALE-20.sale_on_nonexistent_session_is_rejected", "integration", async () => {
    const p = await data.product("S20", "10.00", 5);
    const r = await sell(payload(987654321, [{ p, q: 1 }]));
    expect(biz(r, "CAJA_NO_ENCONTRADA"), JSON.stringify(r));
  });

  // ------------------------------------------------------------------ concurrency
  await t("CONC-01.two_concurrent_sales_on_the_last_unit_only_one_succeeds", "integration", async () => {
    const p = await data.product("C1", "10.00", 1);
    const sid = await openSession(0);
    const body = JSON.stringify(payload(sid, [{ p, q: 1 }], "card"));
    const r = await ipc(page, `Promise.allSettled([api.sales.create(${body}), api.sales.create(${body})]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))`);
    expect(r.ok, r.err);
    const ok = r.v.filter((x) => x.ok).length;
    expect(ok === 1, "exactly one sale may win: " + JSON.stringify(r.v));
    expect(r.v.find((x) => !x.ok).err.includes("[STOCK_INSUFICIENTE]"), "the loser is told why: " + JSON.stringify(r.v));
    expect((await stockOf(p)) === 0, "stock 0, never negative");
    expect((await one("select count(*)::int n from sales where cash_session_id=$1", [sid])).n === 1, "one sale persisted");
  });
  await t("CONC-02.eight_concurrent_sales_over_three_units_sell_exactly_three", "integration", async () => {
    const p = await data.product("C2", "10.00", 3);
    const sid = await openSession(0);
    const body = JSON.stringify(payload(sid, [{ p, q: 1 }], "cash"));
    const calls = Array.from({ length: 8 }, () => `api.sales.create(${body})`).join(",");
    const r = await ipc(page, `Promise.allSettled([${calls}]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))`);
    expect(r.ok, r.err);
    expect(r.v.filter((x) => x.ok).length === 3, JSON.stringify(r.v));
    expect((await stockOf(p)) === 0, "stock 0");
    expect((await cashOf(sid)) === 30, "cash reflects exactly three cash sales");
    expect((await one("select coalesce(sum(amount),0)::int s from inventory_movements where product_id=$1", [p.id])).s === -3, "inventory movements sum -3");
  });
  await t("CONC-03.two_concurrent_withdrawals_cannot_overdraw", "integration", async () => {
    const sid = await openSession(100);
    const mv = `api.cash.addMovement({sessionId:${sid},type:'OUT',amount:70,reason:'e2e'})`;
    const r = await ipc(page, `Promise.allSettled([${mv}, ${mv}]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))`);
    expect(r.ok, r.err);
    expect(r.v.filter((x) => x.ok).length === 1 && r.v.find((x) => !x.ok).err.includes("[FONDOS_INSUFICIENTES]"), JSON.stringify(r.v));
    expect((await cashOf(sid)) === 30, "balance 30");
    expect((await one("select count(*)::int n from cash_movements where session_id=$1", [sid])).n === 1, "one movement persisted");
  });
  await t("CONC-04.two_concurrent_openings_create_a_single_session", "integration", async () => {
    const before = (await one("select count(*)::int n from cash_sessions")).n;
    const r = await ipc(page, "Promise.allSettled([api.cash.openSession(5), api.cash.openSession(6)]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))");
    expect(r.ok, r.err);
    expect(r.v.filter((x) => x.ok).length === 1 && r.v.find((x) => !x.ok).err.includes("[CAJA_YA_ABIERTA]"), JSON.stringify(r.v));
    expect((await one("select count(*)::int n from cash_sessions")).n === before + 1, "one new row");
    expect((await one("select count(*)::int n from cash_sessions where closed_at is null")).n === 1, "one open session");
  });
  await t("CONC-05.close_racing_a_sale_stays_consistent", "integration", async () => {
    const p = await data.product("C5", "10.00", 5);
    const sid = await openSession(0);
    const body = JSON.stringify(payload(sid, [{ p, q: 1 }], "cash"));
    const r = await ipc(page, `Promise.allSettled([api.sales.create(${body}), api.cash.closeSession(${sid},0)]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))`);
    expect(r.ok, r.err);
    expect(r.v[1].ok, "the close always succeeds: " + JSON.stringify(r.v));
    const sales = (await one("select count(*)::int n from sales where cash_session_id=$1", [sid])).n;
    const cm = (await one("select count(*)::int n from cash_movements where session_id=$1", [sid])).n;
    if (r.v[0].ok) expect(sales === 1 && cm === 1 && (await stockOf(p)) === 4, "sale won the race: fully recorded");
    else expect(r.v[0].err.includes("[CAJA_CERRADA]") && sales === 0 && cm === 0 && (await stockOf(p)) === 5, "close won the race: sale rejected, nothing recorded " + JSON.stringify(r.v));
    return r.v[0].ok ? "sale won" : "close won";
  });

  // ------------------------------------------------------------------ cash
  await t("CASH-01.valid_income_and_withdrawal", "integration", async () => {
    const sid = await openSession(100);
    const a = await ipc(page, `api.cash.addMovement({sessionId:${sid},type:'IN',amount:20,reason:'ingreso'})`);
    const b = await ipc(page, `api.cash.addMovement({sessionId:${sid},type:'OUT',amount:10.5,reason:'retiro'})`);
    expect(a.ok && b.ok, JSON.stringify([a.err, b.err]));
    expect((await cashOf(sid)) === 109.5, "100 + 20 - 10.50");
    const rows = (await db.query("select type, amount, user_id from cash_movements where session_id=$1 order by id", [sid])).rows;
    expect(rows.length === 2 && rows.every((x) => x.user_id === admin.id) && rows[0].type === "IN" && rows[1].type === "OUT", "movements attributed to the session user");
  });
  await t("CASH-02.withdrawal_above_balance_is_rejected_without_trace", "integration", async () => {
    const sid = await openSession(10);
    const before = await snap();
    const r = await ipc(page, `api.cash.addMovement({sessionId:${sid},type:'OUT',amount:10.01,reason:'x'})`);
    expect(biz(r, "FONDOS_INSUFICIENTES"), JSON.stringify(r));
    expect((await snap()) === before, "no movement, balance unchanged");
    const exact = await ipc(page, `api.cash.addMovement({sessionId:${sid},type:'OUT',amount:10,reason:'todo'})`);
    expect(exact.ok && (await cashOf(sid)) === 0, "withdrawing exactly the balance is allowed");
  });
  await t("CASH-03.invalid_movements_are_rejected", "integration", async () => {
    const sid = await openSession(10);
    const before = await snap();
    const cases = [
      ["TIPO_INVALIDO", `{sessionId:${sid},type:'XX',amount:1,reason:'x'}`],
      ["IMPORTE_INVALIDO", `{sessionId:${sid},type:'IN',amount:0,reason:'x'}`],
      ["IMPORTE_INVALIDO", `{sessionId:${sid},type:'IN',amount:-5,reason:'x'}`],
      ["IMPORTE_INVALIDO", `{sessionId:${sid},type:'IN',amount:NaN,reason:'x'}`],
      ["IMPORTE_INVALIDO", `{sessionId:${sid},type:'IN',amount:1.001,reason:'x'}`],
      ["MOTIVO_INVALIDO", `{sessionId:${sid},type:'IN',amount:1,reason:'  '}`],
      ["CAJA_NO_ENCONTRADA", `{sessionId:987654321,type:'IN',amount:1,reason:'x'}`],
      ["CAJA_INVALIDA", `{sessionId:null,type:'IN',amount:1,reason:'x'}`],
    ];
    for (const [code, body] of cases) { const r = await ipc(page, `api.cash.addMovement(${body})`); expect(biz(r, code), `${body} -> ${JSON.stringify(r)}`); }
    expect((await snap()) === before, "none left a trace");
  });
  await t("CASH-04.close_updates_status_and_audit_fields", "integration", async () => {
    const sid = await openSession(100);
    const r = await ipc(page, `api.cash.closeSession(${sid},95.5)`);
    expect(r.ok, r.err);
    const s = await one("select * from cash_sessions where id=$1", [sid]);
    expect(s.status === "closed" && s.closed_at && s.closed_by === admin.id && money(s.final_amount) === 95.5 && s.opened_by === admin.id, "closed row " + JSON.stringify(s));
    expect(money(s.current_amount) === 100, "history preserved: expected cash is kept apart from the counted amount");
  });
  await t("CASH-05.second_close_is_rejected", "integration", async () => {
    const sid = await openSession(10);
    expect((await ipc(page, `api.cash.closeSession(${sid},10)`)).ok, "first close");
    const first = await one("select closed_at, final_amount from cash_sessions where id=$1", [sid]);
    const r = await ipc(page, `api.cash.closeSession(${sid},999)`);
    expect(biz(r, "CAJA_CERRADA"), JSON.stringify(r));
    const after = await one("select closed_at, final_amount from cash_sessions where id=$1", [sid]);
    expect(String(first.closed_at) === String(after.closed_at) && money(after.final_amount) === 10, "closing data untouched");
  });
  await t("CASH-06.movement_after_close_is_rejected", "integration", async () => {
    const sid = await openSession(10);
    expect((await ipc(page, `api.cash.closeSession(${sid},10)`)).ok, "close");
    const before = await snap();
    const r = await ipc(page, `api.cash.addMovement({sessionId:${sid},type:'IN',amount:5,reason:'tarde'})`);
    expect(biz(r, "CAJA_CERRADA"), JSON.stringify(r));
    expect((await snap()) === before, "no trace");
  });
  await t("CASH-07.invalid_close_requests_are_rejected", "integration", async () => {
    const sid = await openSession(10);
    expect(biz(await ipc(page, `api.cash.closeSession(987654321,1)`), "CAJA_NO_ENCONTRADA"), "nonexistent");
    expect(biz(await ipc(page, `api.cash.closeSession(${sid},-1)`), "IMPORTE_INVALIDO"), "negative counted amount");
    expect(biz(await ipc(page, `api.cash.closeSession(${sid},NaN)`), "IMPORTE_INVALIDO"), "NaN counted amount");
    expect((await one("select status from cash_sessions where id=$1", [sid])).status === "open", "still open");
  });
  await t("CASH-08.opening_while_another_is_open_is_rejected_and_amounts_validated", "integration", async () => {
    await openSession(1);
    expect(biz(await ipc(page, "api.cash.openSession(2)"), "CAJA_YA_ABIERTA"), "second opening");
    await closeAll();
    for (const bad of ["-1", "NaN", "1.234", "'abc'"]) expect(biz(await ipc(page, `api.cash.openSession(${bad})`), "IMPORTE_INVALIDO"), "amount " + bad);
    expect((await one("select count(*)::int n from cash_sessions where closed_at is null")).n === 0, "invalid openings created nothing");
  });
  await t("CASH-09.reopening_after_close_works", "integration", async () => {
    const a = await openSession(1);
    expect((await ipc(page, `api.cash.closeSession(${a},1)`)).ok, "close");
    const b = await openSession(2);
    expect(b !== a, "a new session can be opened once the previous one is closed");
  });

  // ------------------------------------------------------------------ rollback (real mid-transaction failure)
  await t("ROLLBACK-01.failure_halfway_through_a_sale_rolls_everything_back", "integration", async () => {
    const a = await data.product("R1A", "10.00", 5);
    const b = await data.product("R1B", "10.00", 5);
    const sid = await openSession(10);
    // test-only trigger in the throwaway database: the second item's inventory insert fails AFTER
    // the sale, both items, the first stock decrement and its inventory movement already happened
    await db.query(`create or replace function e2e_fail_inv() returns trigger language plpgsql as $f$ begin
      if new.product_id = ${b.id} and new.reason like 'Venta #%' then raise exception 'e2e injected failure'; end if; return new; end $f$`);
    await db.query("create trigger e2e_fail_inv_t before insert on inventory_movements for each row execute function e2e_fail_inv()");
    try {
      const before = await snap();
      const mark = c.mainLog.length;
      const r = await sell(payload(sid, [{ p: a, q: 2 }, { p: b, q: 1 }], "cash"));
      expect(biz(r, "ERROR_INTERNO") && (await failedAt(mark, "sales:create", "insert into \"inventory_movements\"")), "an unexpected failure: generic public error + redacted diagnostic in the main log at the injected failure point: " + JSON.stringify(r).slice(0, 200));
      expect((await snap()) === before, "sale, items, stock, inventory and cash all rolled back");
      expect((await stockOf(a)) === 5 && (await stockOf(b)) === 5, "both stocks restored");
      expect((await cashOf(sid)) === 10, "cash restored");
    } finally {
      await db.query("drop trigger if exists e2e_fail_inv_t on inventory_movements");
      await db.query("drop function if exists e2e_fail_inv()");
    }
  });
  await t("ROLLBACK-02.failure_after_the_balance_update_rolls_the_movement_back", "integration", async () => {
    const sid = await openSession(100);
    await db.query(`create or replace function e2e_fail_cash() returns trigger language plpgsql as $f$ begin
      if new.reason = 'e2e-rollback' then raise exception 'e2e injected failure'; end if; return new; end $f$`);
    await db.query("create trigger e2e_fail_cash_t before insert on cash_movements for each row execute function e2e_fail_cash()");
    try {
      const before = await snap();
      const mark = c.mainLog.length;
      const r = await ipc(page, `api.cash.addMovement({sessionId:${sid},type:'OUT',amount:30,reason:'e2e-rollback'})`);
      expect(biz(r, "ERROR_INTERNO") && (await failedAt(mark, "cash:addMovement", "insert into \"cash_movements\"")), "an unexpected failure: generic public error + redacted diagnostic in the main log at the injected failure point: " + JSON.stringify(r).slice(0, 200));
      expect((await snap()) === before && (await cashOf(sid)) === 100, "balance update rolled back, no orphan movement");
    } finally {
      await db.query("drop trigger if exists e2e_fail_cash_t on cash_movements");
      await db.query("drop function if exists e2e_fail_cash()");
    }
  });
  await t("ROLLBACK-03.failed_soft_delete_changes_nothing", "integration", async () => {
    const p = await data.product("R3", "10.00", 4);
    await db.query(`create or replace function e2e_fail_log() returns trigger language plpgsql as $f$ begin raise exception 'e2e injected failure'; end $f$`);
    await db.query("create trigger e2e_fail_log_t before insert on deleted_products_log for each row execute function e2e_fail_log()");
    try {
      const mark = c.mainLog.length;
      const r = await ipc(page, `api.products.softDelete(${p.id},'e2e')`);
      expect(biz(r, "ERROR_INTERNO") && (await failedAt(mark, "products:softDelete", "insert into \"deleted_products_log\"")), "an unexpected failure: generic public error + redacted diagnostic in the main log at the injected failure point: " + JSON.stringify(r).slice(0, 200));
      const row = await one("select status, stock from products where id=$1", [p.id]);
      expect(row.status === "active" && row.stock === 4, "product untouched: " + JSON.stringify(row));
      expect((await one("select count(*)::int n from inventory_movements where product_id=$1", [p.id])).n === 0, "no DELETE movement");
    } finally {
      await db.query("drop trigger if exists e2e_fail_log_t on deleted_products_log");
      await db.query("drop function if exists e2e_fail_log()");
    }
  });

  // ------------------------------------------------------------------ soft delete
  await t("BUG-2.fixed.soft_delete_marks_product_logs_and_zeroes_stock", "integration", async () => {
    const p = await data.product("D1", "5.00", 3);
    const r = await ipc(page, `api.products.softDelete(${p.id},'  descontinuado  ')`);
    expect(r.ok && r.v === true, JSON.stringify(r));
    const row = await one("select status, stock from products where id=$1", [p.id]);
    expect(row.status === "deleted" && row.stock === 0, "row kept, logically deleted, stock 0: " + JSON.stringify(row));
    const log = (await db.query("select * from deleted_products_log where product_id=$1", [p.id])).rows;
    expect(log.length === 1 && log[0].deleted_by === admin.id && log[0].reason === "descontinuado" && log[0].sku === p.sku, "audit log " + JSON.stringify(log));
    const mv = (await db.query("select type, amount, user_id from inventory_movements where product_id=$1", [p.id])).rows;
    expect(mv.length === 1 && mv[0].type === "DELETE" && mv[0].amount === -3 && mv[0].user_id === admin.id, "DELETE movement keeps stock and movements consistent");
    const list = await ipc(page, "api.products.getAll()");
    expect(list.ok && !list.v.some((x) => x.id === p.id), "deleted product is not listed");
    expect((await ipc(page, `api.products.findBySkuOrBarcode('${p.sku}')`)).v === null, "deleted product is not found for sale");
  });
  await t("SOFTDEL-02.repeated_soft_delete_is_rejected_and_adds_no_history", "integration", async () => {
    const p = await data.product("D2", "5.00", 2);
    expect((await ipc(page, `api.products.softDelete(${p.id},'uno')`)).ok, "first");
    const r = await ipc(page, `api.products.softDelete(${p.id},'dos')`);
    expect(biz(r, "PRODUCTO_YA_ELIMINADO"), JSON.stringify(r));
    expect((await one("select count(*)::int n from deleted_products_log where product_id=$1", [p.id])).n === 1, "one log row");
    expect((await one("select count(*)::int n from inventory_movements where product_id=$1", [p.id])).n === 1, "one movement");
  });
  await t("SOFTDEL-04.deleted_products_cannot_regain_stock_through_other_handlers", "integration", async () => {
    const p = await data.product("D4", "5.00", 2);
    expect((await ipc(page, `api.products.softDelete(${p.id},'e2e')`)).ok, "delete");
    const before = await snap();
    // out-of-scope handlers still lack validation, but the database invariant (deleted => stock 0) holds for them
    const inv = await ipc(page, `api.inventory.addMovement({productId:${p.id},type:'IN',amount:5,reason:'e2e'})`);
    expect(biz(inv, "PRODUCTO_ELIMINADO"), "inventory:addMovement must not give a deleted product stock: " + JSON.stringify(inv));
    expect((await one("select stock from products where id=$1", [p.id])).stock === 0, "stock stays 0");
    expect((await snap()) === before, "the failed inventory movement left no orphan row (rolled back)");
    const p2 = await data.product("D4B", "5.00", 0);
    expect((await ipc(page, `api.products.softDelete(${p2.id},'e2e')`)).ok, "delete second");
    const upd = await ipc(page, `api.products.update(${p2.id},{name:'x'})`);
    expect(biz(upd, "PRODUCTO_ELIMINADO"), "products:update is blocked for deleted products: " + JSON.stringify(upd));
  });
  await t("SOFTDEL-03.soft_delete_guards_and_deleted_products_cannot_be_resurrected", "integration", async () => {
    expect(biz(await ipc(page, "api.products.softDelete(987654321,'x')"), "PRODUCTO_NO_ENCONTRADO"), "nonexistent");
    const p = await data.product("D3", "5.00", 0);
    expect(biz(await ipc(page, `api.products.softDelete(${p.id},'   ')`), "MOTIVO_INVALIDO"), "empty reason");
    expect(biz(await ipc(page, `api.products.softDelete('${p.id}','x')`), "PRODUCTO_INVALIDO"), "id must be a number");
    expect(biz(await ipc(page, `api.products.update(${p.id},{status:'deleted'})`), "OPERACION_INVALIDA"), "update cannot delete");
    expect((await ipc(page, `api.products.softDelete(${p.id},'ok')`)).ok, "delete (stock 0: no movement)");
    expect((await one("select count(*)::int n from inventory_movements where product_id=$1", [p.id])).n === 0, "no movement for stock 0");
    expect(biz(await ipc(page, `api.products.update(${p.id},{status:'active',name:'back'})`), "PRODUCTO_ELIMINADO"), "deleted product cannot be edited/reactivated");
    expect((await one("select status from products where id=$1", [p.id])).status === "deleted", "still deleted");
  });

  // ------------------------------------------------------------------ the sales screen (visual)
  await test("BUG-6.fixed.zero_stock_product_cannot_enter_cart", "e2e", async () => {
    await closeAll();
    const p = await data.product("ZERO", "9.00", 0);
    await ui.nav(page, "Vender");
    await page.getByPlaceholder("Código, SKU o nombre...").fill(p.sku);
    await page.getByText("Agotado").first().waitFor();
    await page.getByRole("option", { name: new RegExp(p.name) }).first().click();
    await page.getByText(/está agotado/).first().waitFor({ timeout: 4000 });
    expect((await page.getByText("Carrito (1 artículo)").count()) === 0, "zero-stock product was added to the cart");
    expect((await page.getByText("Carrito (0 artículos)").count()) === 1, "cart is still empty");
  });
  await test("UI-STOCK-02.cannot_exceed_displayed_stock", "e2e", async () => {
    const p = await data.product("UI2", "9.00", 2);
    await ui.nav(page, "Ver Stock"); // leave and re-enter so the sales screen reloads the catalog
    await ui.nav(page, "Vender");
    const search = page.getByPlaceholder("Código, SKU o nombre...");
    for (let i = 0; i < 3; i++) {
      await search.fill(p.sku);
      await page.getByRole("option", { name: new RegExp(p.name) }).first().click();
    }
    await page.getByText(/Solo hay 2 unidades/).first().waitFor({ timeout: 4000 });
    expect(Number(await page.locator('input[type="number"]').first().inputValue()) === 2, "quantity capped at the stock");
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Limpiar carrito" }).click(); // clearing now asks first
  });
  await test("UI-STOCK-03.rejected_sale_refreshes_the_catalog_and_cart", "e2e", async () => {
    const sid = await openSession(0);
    const p = await data.product("UI3", "9.00", 3);
    await ui.nav(page, "Ver Stock");
    await ui.nav(page, "Vender");
    await page.getByPlaceholder("Código, SKU o nombre...").fill(p.sku);
    await page.getByRole("option", { name: new RegExp(p.name) }).first().click();
    await page.locator('input[type="number"]').first().fill("3");
    // someone else sells/removes stock while this cart is open
    await db.query("update products set stock=1 where id=$1", [p.id]);
    await page.getByRole("button", { name: "Pagar" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("tab", { name: "Efectivo" }).click();
    await dlg.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByText(/Stock insuficiente/).first().waitFor({ timeout: 6000 });
    await page.waitForFunction(() => document.querySelector('input[type="number"]')?.value === "1", null, { timeout: 6000 });
    expect((await one("select count(*)::int n from sales where cash_session_id=$1", [sid])).n === 0, "no sale persisted");
    expect((await stockOf(p)) === 1, "stock untouched");
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Limpiar carrito" }).click(); // clearing now asks first
  });

  await closeAll();
  await ui.logout(page).catch(() => {});
}
