// Returns suite: transactional returns integrity through the real IPC (real admin login), every outcome
// verified in PostgreSQL. Covers amounts from sale_items, over-return protection (also under concurrency with
// a forced row-lock queue), deleted products, no automatic cash movement, 'pending' refund state, rollback.
import { ui, ipc, expect, money, connectRunDb, waitFor } from "../lib/harness.mjs";

const LEAKS_SQL = /Failed query|params:|(select|insert into|update|delete from) .*(from|set|values) /i;

export async function run(c) {
  const { page, db, data, test } = c;
  const admin = await data.user("ADMIN", "admin");
  const J = JSON.stringify;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const call = (expr) => ipc(page, expr);
  const biz = (r, code) => r.ok === false && String(r.err).includes(`[${code}]`) && !LEAKS_SQL.test(String(r.err));
  // an unexpected (non-business) failure; message shape differs once errors are sanitized, both are accepted here
  const internal = (r) => r.ok === false && String(r.err).includes("[ERROR_INTERNO]") && !LEAKS_SQL.test(String(r.err));
  const settled = (calls) => call(`Promise.allSettled([${calls.join(",")}]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))`);
  const doReturn = (saleId, items, reason = "devolución e2e") => call(`api.returns.create(${J({ saleId, items, reason })})`);
  const stockOf = async (p) => Number((await one("select stock from products where id=$1", [p.id])).stock);
  const snap = async () => J(await one(`select (select count(*) from returns)::int returns, (select count(*) from return_items)::int items,
    (select count(*) from inventory_movements)::int inv, (select coalesce(sum(stock),0) from products)::int stock,
    (select count(*) from cash_movements)::int cmov, (select coalesce(sum(current_amount),0) from cash_sessions)::text cash`));

  /** queues all calls on a PostgreSQL row lock held by a second connection, then releases it (real race) */
  const contended = async (lockSql, lockParams, exprs) => {
    const holder = await connectRunDb(c.runDb);
    const queuedNow = async () => (await one("select count(*)::int n from pg_stat_activity where application_name='e2e_app' and wait_event_type='Lock'")).n;
    try {
      await holder.query("BEGIN");
      await holder.query(lockSql, lockParams);
      const pending = [];
      for (let i = 0; i < exprs.length; i++) {
        pending.push(call(exprs[i]));
        const queued = await waitFor(async () => (await queuedNow()) >= i + 1, 8000);
        if (!queued) { await holder.query("ROLLBACK"); await Promise.allSettled(pending); expect(false, `call ${i} never queued on the row lock`); }
      }
      await holder.query("COMMIT");
      return (await Promise.all(pending)).map((x) => ({ ok: x.ok, err: x.err }));
    } finally { await holder.end().catch(() => {}); }
  };
  const withTrigger = async (table, timing, fn, body, runIt) => {
    await db.query(`create or replace function ${fn}() returns trigger language plpgsql as $f$ begin ${body} end $f$`);
    await db.query(`create trigger ${fn}_t ${timing} on ${table} for each row execute function ${fn}()`);
    try { return await runIt(); } finally {
      await db.query(`drop trigger if exists ${fn}_t on ${table}`);
      await db.query(`drop function if exists ${fn}()`);
    }
  };

  let sid;
  /** creates a real sale through the sales path; returns ids and line ids */
  const makeSale = async (lines, method = "cash") => {
    const items = lines.map(({ p, q }) => ({ productId: p.id, quantity: q, unitPrice: p.price, subtotal: Math.round(p.price * q * 100) / 100 }));
    const total = Math.round(items.reduce((a, i) => a + i.subtotal, 0) * 100) / 100;
    const r = await call(`api.sales.create(${J({ items, total, paymentMethod: method, sessionId: sid })})`);
    expect(r.ok, "sale failed: " + r.err);
    const lineRows = await rows("select id, product_id, quantity, unit_price from sale_items where sale_id=$1 order by id", [r.v.id]);
    return { saleId: r.v.id, lines: lineRows };
  };
  const lineOf = (sale, p) => sale.lines.find((l) => l.product_id === p.id);

  await test("RET-00.admin_visual_login", "e2e", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    for (const r of await rows("select id from cash_sessions where closed_at is null")) await call(`api.cash.closeSession(${r.id},0)`);
    const s = await call("api.cash.openSession(500)");
    expect(s.ok, s.err);
    sid = s.v.id;
  });

  // ------------------------------------------------------------------ valid returns
  await test("RET-01.partial_return_records_everything_with_server_prices", "integration", async () => {
    const p = await data.product("R1", "20.00", 10);
    const sale = await makeSale([{ p, q: 3 }]);
    const stockBefore = await stockOf(p);
    const line = lineOf(sale, p);
    const r = await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1 }], "  cliente se arrepintió  ");
    expect(r.ok, r.err);
    const ret = await one("select * from returns where id=$1", [r.v.id]);
    expect(ret.sale_id === sale.saleId && money(ret.total_refund) === 20 && ret.refund_status === "pending" && ret.processed_by === admin.id && ret.reason === "cliente se arrepintió", "return row " + J(ret));
    const it = await rows("select * from return_items where return_id=$1", [ret.id]);
    expect(it.length === 1 && it[0].sale_item_id === line.id && it[0].product_id === p.id && it[0].quantity === 1 && money(it[0].refund_amount) === 20, "return item " + J(it));
    expect((await stockOf(p)) === stockBefore + 1, "stock +1");
    const mv = await rows("select type, amount, reason, user_id from inventory_movements where reason=$1", [`Devolución #${ret.id} de Venta #${sale.saleId}`]);
    expect(mv.length === 1 && mv[0].type === "IN" && mv[0].amount === 1 && mv[0].user_id === admin.id, "inventory history " + J(mv));
  });
  await test("RET-02.full_return_of_a_two_line_sale", "integration", async () => {
    const a = await data.product("R2A", "10.50", 5), b = await data.product("R2B", "3.25", 5);
    const sale = await makeSale([{ p: a, q: 2 }, { p: b, q: 4 }]);
    const r = await doReturn(sale.saleId, sale.lines.map((l) => ({ saleItemId: l.id, quantity: l.quantity })));
    expect(r.ok, r.err);
    expect(money((await one("select total_refund from returns where id=$1", [r.v.id])).total_refund) === 34, "10.50*2 + 3.25*4 = 34.00");
    expect((await stockOf(a)) === 5 && (await stockOf(b)) === 5, "stock fully restored");
    expect((await rows("select refund_amount from return_items where return_id=$1 order by id", [r.v.id])).map((x) => money(x.refund_amount)).join() === "21,13", "line amounts");
    const again = await doReturn(sale.saleId, [{ saleItemId: sale.lines[0].id, quantity: 1 }]);
    expect(biz(again, "DEVOLUCION_EXCEDE"), "nothing left to return: " + J(again));
  });
  await test("RET-03.repeated_returns_cannot_exceed_what_was_sold", "integration", async () => {
    const p = await data.product("R3", "5.00", 10);
    const sale = await makeSale([{ p, q: 3 }]);
    const line = lineOf(sale, p);
    expect((await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 2 }])).ok, "first return of 2");
    const before = await snap();
    const over = await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 2 }]);
    expect(biz(over, "DEVOLUCION_EXCEDE") && /Solo quedan 1/.test(over.err), "remaining is 1: " + J(over));
    expect((await snap()) === before, "the rejected return left no trace");
    expect((await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1 }])).ok, "the last unit");
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1 }]), "DEVOLUCION_EXCEDE"), "now exhausted");
  });
  await test("RET-04.refund_uses_the_price_paid_not_the_current_price", "integration", async () => {
    const p = await data.product("R4", "20.00", 5);
    const sale = await makeSale([{ p, q: 2 }]);
    await db.query("update products set price='99.00' where id=$1", [p.id]); // price changed after the sale
    const r = await doReturn(sale.saleId, [{ saleItemId: lineOf(sale, p).id, quantity: 2 }]);
    expect(r.ok && money(r.v.totalRefund) === 40, "refund 40.00 (paid price), got " + J(r.v));
  });

  // ------------------------------------------------------------------ tampering and invalid references
  await test("RET-05.forged_price_or_product_claims_are_rejected", "integration", async () => {
    const p = await data.product("R5", "20.00", 5);
    const other = await data.product("R5B", "1.00", 5);
    const sale = await makeSale([{ p, q: 2 }]);
    const line = lineOf(sale, p);
    const before = await snap();
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1, unitPrice: 200 }]), "PRECIO_NO_COINCIDE"), "inflated price");
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1, unitPrice: 0.01 }]), "PRECIO_NO_COINCIDE"), "deflated price");
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1, productId: other.id }]), "PRODUCTO_NO_COINCIDE"), "another product's id");
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1, productId: 987654321 }]), "PRODUCTO_NO_COINCIDE"), "nonexistent product id");
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1, refundAmount: 999 }]), "CAMPO_NO_PERMITIDO"), "client-supplied refund amount");
    expect((await snap()) === before, "nothing persisted");
    const ok = await doReturn(sale.saleId, [{ saleItemId: line.id, quantity: 1, unitPrice: 20, productId: p.id }]);
    expect(ok.ok && money(ok.v.totalRefund) === 20, "correct claims are accepted: " + J(ok));
  });
  await test("RET-06.lines_of_other_sales_and_missing_references_are_rejected", "integration", async () => {
    const p = await data.product("R6", "5.00", 9), q = await data.product("R6B", "5.00", 9);
    const a = await makeSale([{ p, q: 1 }]), b = await makeSale([{ p: q, q: 1 }]);
    const before = await snap();
    expect(biz(await doReturn(a.saleId, [{ saleItemId: lineOf(b, q).id, quantity: 1 }]), "ITEM_AJENO_A_VENTA"), "line of another sale");
    expect(biz(await doReturn(a.saleId, [{ saleItemId: 987654321, quantity: 1 }]), "ITEM_NO_ENCONTRADO"), "nonexistent line");
    expect(biz(await doReturn(987654321, [{ saleItemId: lineOf(a, p).id, quantity: 1 }]), "VENTA_NO_ENCONTRADA"), "nonexistent sale");
    expect(biz(await doReturn(a.saleId, [{ saleItemId: lineOf(a, p).id, quantity: 1 }, { saleItemId: lineOf(b, q).id, quantity: 1 }]), "ITEM_AJENO_A_VENTA"), "mixed valid + foreign line rejects the whole return");
    expect((await snap()) === before, "nothing persisted");
  });
  await test("RET-07.invalid_payloads_and_quantities_are_rejected", "integration", async () => {
    const p = await data.product("R7", "5.00", 9);
    const sale = await makeSale([{ p, q: 3 }]);
    const id = lineOf(sale, p).id;
    const before = await snap();
    for (const q of ["-1", "0", "1.5", "NaN", "Infinity", "'2'", "null", "undefined", "100001"]) {
      const r = await call(`api.returns.create({saleId:${sale.saleId}, reason:'x', items:[{saleItemId:${id}, quantity:${q}}]})`);
      expect(biz(r, "CANTIDAD_INVALIDA"), `quantity ${q}: ${J(r)}`);
    }
    expect(biz(await doReturn(sale.saleId, []), "DEVOLUCION_SIN_ITEMS"), "no lines");
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: id, quantity: 1 }, { saleItemId: id, quantity: 1 }]), "ITEM_DUPLICADO"), "duplicated line");
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: id, quantity: 1 }], "   "), "MOTIVO_INVALIDO"), "empty reason");
    for (const sId of ["0", "-1", "1.5", "'1'", "null"]) expect(biz(await call(`api.returns.create({saleId:${sId}, reason:'x', items:[{saleItemId:${id}, quantity:1}]})`), "VENTA_INVALIDA"), "saleId " + sId);
    expect(biz(await call("api.returns.create(null)"), "DEVOLUCION_INVALIDA"), "null payload");
    expect(biz(await call(`api.returns.create({saleId:${sale.saleId}, reason:'x', items:[{saleItemId:'${id}', quantity:1}]})`), "ITEM_INVALIDO"), "line id type");
    expect((await snap()) === before, "none left a trace");
  });
  await test("RET-08.deleted_products_are_not_restocked", "integration", async () => {
    const p = await data.product("R8", "5.00", 4), q = await data.product("R8B", "5.00", 4);
    const sale = await makeSale([{ p, q: 2 }, { p: q, q: 2 }]);
    expect((await call(`api.products.softDelete(${p.id},'e2e')`)).ok, "delete p");
    const before = await snap();
    const r = await doReturn(sale.saleId, sale.lines.map((l) => ({ saleItemId: l.id, quantity: 1 })));
    expect(biz(r, "PRODUCTO_ELIMINADO"), J(r));
    expect((await snap()) === before && (await stockOf(p)) === 0, "no stock came back to the deleted product, and the other line was not returned either");
    expect((await doReturn(sale.saleId, [{ saleItemId: lineOf(sale, q).id, quantity: 1 }])).ok, "the live product can still be returned on its own");
  });

  // ------------------------------------------------------------------ financial policy
  await test("RET-09.a_return_is_pending_and_never_moves_cash", "integration", async () => {
    const p = await data.product("R9", "15.00", 5);
    const sale = await makeSale([{ p, q: 2 }], "cash");
    const cashBefore = await one("select current_amount from cash_sessions where id=$1", [sid]);
    const movBefore = (await one("select count(*)::int n from cash_movements")).n;
    const r = await doReturn(sale.saleId, [{ saleItemId: lineOf(sale, p).id, quantity: 2 }]);
    expect(r.ok && r.v.refundStatus === "pending", "returned row says pending: " + J(r.v));
    expect(money((await one("select current_amount from cash_sessions where id=$1", [sid])).current_amount) === money(cashBefore.current_amount), "cash balance untouched");
    expect((await one("select count(*)::int n from cash_movements")).n === movBefore, "no cash movement was created");
    expect((await one("select count(*)::int n from returns where refund_status <> 'pending'")).n === 0, "nothing is marked paid or legacy by the new code");
    const list = await call("api.returns.getAll()");
    expect(list.ok && list.v.find((x) => x.id === r.v.id)?.refundStatus === "pending", "returns:getAll exposes the state");
  });
  await test("RET-10.dashboard_separates_pending_refunds_from_paid_ones", "e2e", async () => {
    const stats = await call("api.dashboard.getStats()");
    expect(stats.ok, stats.err);
    const pending = Number(stats.v.returns.pending.total), paid = Number(stats.v.returns.paid.total);
    const sum = Number((await one("select coalesce(sum(total_refund),0) s from returns where created_at >= date_trunc('day', now())")).s);
    expect(pending > 0 && paid === 0 && Math.abs(pending - sum) < 0.005 && Math.abs(Number(stats.v.returns.total) - sum) < 0.005, "pending covers all of today's returns, paid is 0: " + J(stats.v.returns));
    await ui.nav(page, "Ver Stock"); // leave and re-enter: the dashboard loads its figures on mount
    await ui.nav(page, "Dashboard");
    await page.getByText("Reembolsos pendientes de pago (hoy)").waitFor({ timeout: 8000 });
    await page.getByText("Reembolsos pagados (hoy)").waitFor();
    const text = await page.evaluate(() => document.body.innerText);
    expect(text.includes("$" + pending.toFixed(2)) && text.includes("$0.00"), `the screen shows the pending amount apart from the paid one: pending=${pending} paid=${paid} excerpt=${J(text.slice(text.indexOf("Reembolsos"), text.indexOf("Reembolsos") + 120))}`);
    expect(!/\bDevoluciones\b\s*\$/.test(text), "no card presents returns as money handed back");
  });

  // ------------------------------------------------------------------ concurrency
  await test("CONC-RET-01.two_concurrent_full_returns_only_one_succeeds", "integration", async () => {
    const p = await data.product("C1", "5.00", 10);
    const sale = await makeSale([{ p, q: 2 }]);
    const id = lineOf(sale, p).id;
    const stockBefore = await stockOf(p);
    const body = J({ saleId: sale.saleId, reason: "race", items: [{ saleItemId: id, quantity: 2 }] });
    const r = await settled([`api.returns.create(${body})`, `api.returns.create(${body})`]);
    expect(r.ok, r.err);
    expect(r.v.filter((x) => x.ok).length === 1, "exactly one wins: " + J(r.v));
    expect(r.v.find((x) => !x.ok).err.includes("[DEVOLUCION_EXCEDE]"), "the loser is told why: " + J(r.v));
    expect((await one("select coalesce(sum(quantity),0)::int q from return_items where sale_item_id=$1", [id])).q === 2, "returned exactly the 2 sold");
    expect((await stockOf(p)) === stockBefore + 2, "stock restored once");
  });
  await test("CONC-RET-02.forced_queue_on_the_sale_row_and_many_small_returns", "integration", async () => {
    const p = await data.product("C2", "5.00", 10);
    const sale = await makeSale([{ p, q: 3 }]);
    const id = lineOf(sale, p).id;
    const one1 = (q) => `api.returns.create(${J({ saleId: sale.saleId, reason: "queued", items: [{ saleItemId: id, quantity: q }] })})`;
    // both calls are queued on the sale row lock before it is released: the first in the queue wins
    const r = await contended("select id from sales where id=$1 for update", [sale.saleId], [one1(3), one1(1)]);
    expect(r[0].ok && !r[1].ok && r[1].err.includes("[DEVOLUCION_EXCEDE]"), "queue order decides, never over-returns: " + J(r));
    const q = await data.product("C2B", "5.00", 10);
    const sale2 = await makeSale([{ p: q, q: 3 }]);
    const id2 = lineOf(sale2, q).id;
    const calls = Array.from({ length: 6 }, () => `api.returns.create(${J({ saleId: sale2.saleId, reason: "many", items: [{ saleItemId: id2, quantity: 1 }] })})`);
    const many = await contended("select id from sales where id=$1 for update", [sale2.saleId], calls);
    expect(many.filter((x) => x.ok).length === 3, "6 single-unit returns over 3 sold units: exactly 3 succeed: " + J(many.map((x) => x.ok)));
    expect((await one("select coalesce(sum(quantity),0)::int q from return_items where sale_item_id=$1", [id2])).q === 3, "sum returned = sold");
  });

  // ------------------------------------------------------------------ rollback
  await test("ROLLBACK-RET-01.failure_halfway_through_a_return_rolls_everything_back", "integration", async () => {
    const a = await data.product("RB1A", "5.00", 5), b = await data.product("RB1B", "5.00", 5);
    const sale = await makeSale([{ p: a, q: 2 }, { p: b, q: 2 }]);
    await withTrigger("inventory_movements", "before insert", "e2e_fail_ret_inv", `if new.product_id = ${b.id} and new.reason like 'Devoluci%' then raise exception 'e2e injected failure'; end if; return new;`, async () => {
      const before = await snap();
      const r = await doReturn(sale.saleId, sale.lines.map((l) => ({ saleItemId: l.id, quantity: 1 })));
      expect(internal(r), "an unexpected failure at the second line's history insert: " + J(r).slice(0, 200));
      expect((await snap()) === before, "return, lines, stock and history all rolled back (the first line had already been written)");
    });
    await withTrigger("return_items", "before insert", "e2e_fail_ret_item", `if new.sale_item_id = ${lineOf(sale, a).id} then raise exception 'e2e injected failure'; end if; return new;`, async () => {
      const before = await snap();
      const r = await doReturn(sale.saleId, [{ saleItemId: lineOf(sale, a).id, quantity: 1 }]);
      expect(internal(r), J(r).slice(0, 200));
      expect((await snap()) === before, "the returns header row is rolled back too");
    });
  });

  // ------------------------------------------------------------------ integrity after many returns
  await test("RET-11.integrity_holds_after_multiple_returns", "integration", async () => {
    const p = await data.product("R11", "7.25", 20);
    const sale = await makeSale([{ p, q: 5 }]);
    const id = lineOf(sale, p).id;
    const afterSale = await stockOf(p);
    for (const q of [1, 2, 1]) expect((await doReturn(sale.saleId, [{ saleItemId: id, quantity: q }])).ok, "return " + q);
    expect(biz(await doReturn(sale.saleId, [{ saleItemId: id, quantity: 2 }]), "DEVOLUCION_EXCEDE"), "1 unit left, 2 requested");
    expect((await stockOf(p)) === afterSale + 4, "stock = after-sale + 4 returned");
    const rets = await rows("select r.id, r.total_refund, coalesce(sum(i.refund_amount),0) as lines from returns r left join return_items i on i.return_id=r.id where r.sale_id=$1 group by r.id order by r.id", [sale.saleId]);
    expect(rets.length === 3 && rets.every((x) => money(x.total_refund) === money(x.lines)), "each header equals the sum of its lines: " + J(rets));
    expect((await one("select sum(refund_amount)::text s from return_items where sale_item_id=$1", [id])).s === "29.00", "4 x 7.25 = 29.00 refunded in total");
    expect((await one(`select count(*)::int n from (select s.id from sale_items s join return_items r on r.sale_item_id=s.id group by s.id, s.quantity having sum(r.quantity) > s.quantity) d`)).n === 0, "no sale line is returned beyond its sold quantity, anywhere in the database");
    const mvSum = (await one("select coalesce(sum(amount),0)::int s from inventory_movements where product_id=$1", [p.id])).s;
    expect(mvSum === -5 + 4, "history: -5 sold + 4 returned = " + mvSum);
  });

  for (const r of await rows("select id from cash_sessions where closed_at is null")) await call(`api.cash.closeSession(${r.id},0)`);
  await ui.logout(page).catch(() => {});
}
