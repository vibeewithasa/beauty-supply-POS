// Catalog suite: administrative operations on products, inventory movements and prices, exercised through
// the real IPC (real visual admin login) with every outcome verified in PostgreSQL: validation, audit
// trail, concurrency (real parallel IPC calls) and mid-transaction rollback (test-only DB triggers).
import { ui, ipc, expect, money, connectRunDb, waitFor, sleep } from "../lib/harness.mjs";

const LEAKS_SQL = /Failed query|params:|(select|insert into|update|delete from) .*(from|set|values) /i;

export async function run(c) {
  const { page, db, data, test } = c;
  const admin = await data.user("ADMIN", "admin");
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const J = JSON.stringify;
  const failedAt = async (mark, channel, sqlObj) => { await sleep(400); return new RegExp(`unexpected error in ${channel}[\\s\\S]*${sqlObj}`).test(c.mainLog.slice(mark).join("\n")); };
  // a business rejection carries a stable code AND never leaks SQL text or query parameters
  const biz = (r, code) => r.ok === false && String(r.err).includes(`[${code}]`) && !LEAKS_SQL.test(String(r.err));
  const call = (expr) => ipc(page, expr);
  const create = (body) => call(`api.products.create(${J(body)})`);
  const update = (id, body) => call(`api.products.update(${J(id)}, ${J(body)})`);
  const move = (productId, type, amount, reason = "e2e") => call(`api.inventory.addMovement(${J({ productId, type, amount, reason })})`);
  const reprice = (body) => call(`api.priceChanges.create(${J(body)})`);
  const stockOf = async (p) => Number((await one("select stock from products where id=$1", [p.id])).stock);
  const priceOf = async (p) => money((await one("select price from products where id=$1", [p.id])).price);
  const settled = (calls) => call(`Promise.allSettled([${calls.join(",")}]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))`);
  const snap = async () => J(await one(`select (select count(*) from products)::int products, (select coalesce(sum(stock),0) from products)::int stock,
    (select count(*) from inventory_movements)::int inv, (select count(*) from price_changes)::int prices, (select coalesce(sum(price),0) from products)::text price_sum`));
  const sku = (label) => `E2E-${c.runId}-${label}`;
  const withTrigger = async (table, timing, fn, fnBody, run) => {
    await db.query(`create or replace function ${fn}() returns trigger language plpgsql as $f$ begin ${fnBody} end $f$`);
    await db.query(`create trigger ${fn}_t ${timing} on ${table} for each row execute function ${fn}()`);
    try { return await run(); } finally {
      await db.query(`drop trigger if exists ${fn}_t on ${table}`);
      await db.query(`drop function if exists ${fn}()`);
    }
  };
  /**
   * Forces a real race. A second connection holds the product row lock while all the calls are issued;
   * we wait until every call is queued on a PostgreSQL row lock (pg_stat_activity), then release it, so the
   * outcome is decided by the database's lock queue (arrival order = issue order) and not by IPC timing.
   * A handler that read state without locking would act on a stale state here.
   */
  const contended = async (productId, exprs) => {
    const holder = await connectRunDb(c.runDb);
    const queuedNow = async () => (await one("select count(*)::int n from pg_stat_activity where application_name='e2e_app' and wait_event_type='Lock'")).n;
    try {
      await holder.query("BEGIN");
      await holder.query("select id from products where id=$1 for update", [productId]);
      const pending = [];
      for (let i = 0; i < exprs.length; i++) {
        pending.push(call(exprs[i])); // issued strictly one after the other: lock queue order = array order
        const queued = await waitFor(async () => (await queuedNow()) >= i + 1, 8000);
        if (!queued) { await holder.query("ROLLBACK"); await Promise.allSettled(pending); expect(false, `call ${i} never queued on the row lock, so this was not a race`); }
      }
      await holder.query("COMMIT");
      const results = await Promise.all(pending);
      return { ok: true, v: results.map((x) => ({ ok: x.ok, err: x.err })) };
    } finally { await holder.end().catch(() => {}); }
  };
  const closeAll = async () => { for (const r of await rows("select id from cash_sessions where closed_at is null")) await call(`api.cash.closeSession(${r.id},0)`); };

  await test("CAT-00.admin_visual_login", "e2e", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
  });

  // ================================================================== products: create
  await test("PROD-01.valid_create_with_initial_stock_records_the_history", "integration", async () => {
    const r = await create({ sku: sku("P1"), name: "  Shampoo  ", price: "12.30", stock: 7, barcode: "BAR-E2E-0001", category: " Cabello " });
    expect(r.ok, r.err);
    const p = await one("select * from products where id=$1", [r.v.id]);
    expect(p.sku === sku("P1") && p.name === "Shampoo" && money(p.price) === 12.3 && p.stock === 7 && p.barcode === "BAR-E2E-0001" && p.category === "Cabello" && p.status === "active", "row " + J(p));
    const mv = await rows("select type, amount, reason, user_id from inventory_movements where product_id=$1", [p.id]);
    expect(mv.length === 1 && mv[0].type === "IN" && mv[0].amount === 7 && mv[0].reason === "Stock inicial" && mv[0].user_id === admin.id, "initial stock history " + J(mv));
  });
  await test("PROD-02.create_without_stock_records_no_movement_and_defaults", "integration", async () => {
    const r = await create({ sku: sku("P2"), name: "Sin stock", price: 5 });
    expect(r.ok, r.err);
    const p = await one("select stock, status, barcode, category from products where id=$1", [r.v.id]);
    expect(p.stock === 0 && p.status === "active" && p.barcode === null && p.category === null, J(p));
    expect((await one("select count(*)::int n from inventory_movements where product_id=$1", [r.v.id])).n === 0, "no movement");
    expect((await create({ sku: sku("P2B"), name: "Inactivo", price: "1.00", status: "inactive" })).ok, "inactive allowed");
  });
  await test("PROD-03.invalid_prices_are_rejected_without_trace", "integration", async () => {
    const before = await snap();
    for (const price of ["-1", "NaN", "1.001", "'abc'", "1e12", "99999999999", "null", "undefined", "[]"]) {
      const r = await call(`api.products.create({sku:'${sku("P3")}', name:'x', price:${price}})`);
      expect(biz(r, "IMPORTE_INVALIDO"), `price ${price}: ${J(r)}`);
    }
    expect((await snap()) === before, "nothing persisted");
  });
  await test("PROD-04.invalid_stock_is_rejected_without_trace", "integration", async () => {
    const before = await snap();
    for (const stock of ["-1", "1.5", "NaN", "Infinity", "'5'", "null", "1000001"]) {
      const r = await call(`api.products.create({sku:'${sku("P4")}', name:'x', price:'1.00', stock:${stock}})`);
      expect(biz(r, "STOCK_INVALIDO"), `stock ${stock}: ${J(r)}`);
    }
    expect((await snap()) === before, "nothing persisted");
  });
  await test("PROD-05.duplicate_sku_is_a_clean_business_error_with_no_orphan_history", "integration", async () => {
    expect((await create({ sku: sku("P5"), name: "uno", price: "1.00", stock: 3 })).ok, "first");
    const before = await snap();
    const r = await create({ sku: sku("P5"), name: "dos", price: "2.00", stock: 9 });
    expect(biz(r, "SKU_DUPLICADO"), J(r));
    expect((await snap()) === before, "no product and no initial-stock movement for the rejected duplicate");
  });
  await test("PROD-06.disallowed_fields_and_statuses_are_rejected", "integration", async () => {
    const before = await snap();
    const base = { sku: sku("P6"), name: "x", price: "1.00" };
    for (const extra of [{ id: 999 }, { createdAt: "2020-01-01" }, { updatedAt: "2020-01-01" }, { userId: 1 }, { role: "admin" }, { isAdmin: true }]) {
      const r = await create({ ...base, ...extra });
      expect(biz(r, "CAMPO_NO_PERMITIDO"), J(extra) + " -> " + J(r));
    }
    expect(biz(await create({ ...base, status: "deleted" }), "OPERACION_INVALIDA"), "status deleted at creation");
    expect(biz(await create({ ...base, status: "weird" }), "ESTADO_INVALIDO"), "unknown status");
    expect((await snap()) === before, "nothing persisted");
  });
  await test("PROD-07.name_sku_barcode_formats_are_enforced", "integration", async () => {
    const before = await snap();
    const bad = [
      { sku: "", name: "x" }, { sku: " ", name: "x" }, { sku: "-lead", name: "x" }, { sku: "a b", name: "x" }, { sku: "x".repeat(65), name: "x" }, { sku: 5, name: "x" },
      { sku: sku("P7"), name: "" }, { sku: sku("P7"), name: "   " }, { sku: sku("P7"), name: "x".repeat(256) }, { sku: sku("P7"), name: "bad\u0000name" },
      { sku: sku("P7"), name: "x", barcode: "has space" }, { sku: sku("P7"), name: "x", category: "y".repeat(129) },
    ];
    for (const b of bad) { const r = await create({ price: "1.00", ...b }); expect(biz(r, "CAMPO_INVALIDO"), J(b).slice(0, 60) + " -> " + J(r).slice(0, 160)); }
    expect(biz(await call("api.products.create(null)"), "PRODUCTO_INVALIDO"), "null payload");
    expect(biz(await call("api.products.create([1])"), "PRODUCTO_INVALIDO"), "array payload");
    expect((await snap()) === before, "nothing persisted");
  });

  // ================================================================== products: update
  await test("PROD-08.valid_update_changes_only_the_given_fields", "integration", async () => {
    const p = await data.product("U1", "8.00", 4);
    const before = await one("select * from products where id=$1", [p.id]);
    await new Promise((r) => setTimeout(r, 15));
    const r = await update(p.id, { name: "Renombrado", category: "Nueva", barcode: "ABC-123", status: "inactive", sku: sku("U1-NEW") });
    expect(r.ok, r.err);
    const after = await one("select * from products where id=$1", [p.id]);
    expect(after.name === "Renombrado" && after.category === "Nueva" && after.barcode === "ABC-123" && after.status === "inactive" && after.sku === sku("U1-NEW"), "fields applied " + J(after));
    expect(money(after.price) === 8 && after.stock === 4 && String(after.created_at) === String(before.created_at), "price, stock and created_at untouched");
    expect(new Date(after.updated_at) > new Date(before.updated_at), "updated_at moved");
    expect((await update(p.id, { status: "active" })).ok, "reactivating an inactive (not deleted) product is allowed");
    expect((await update(p.id, { barcode: "" })).ok && (await one("select barcode from products where id=$1", [p.id])).barcode === null, "empty barcode clears it");
  });
  await test("PROD-09.update_cannot_touch_stock_price_identity_or_audit_fields", "integration", async () => {
    const p = await data.product("U2", "8.00", 4);
    const other = await data.product("U2B", "1.00", 1);
    const before = await snap();
    expect(biz(await update(p.id, { stock: 99 }), "STOCK_NO_MODIFICABLE"), "stock");
    expect(biz(await update(p.id, { name: "ok", stock: 0 }), "STOCK_NO_MODIFICABLE"), "stock mixed with allowed fields");
    expect(biz(await update(p.id, { price: "1.00" }), "PRECIO_NO_MODIFICABLE"), "price");
    for (const f of [{ id: 5 }, { createdAt: "2000-01-01" }, { updatedAt: "2000-01-01" }, { foo: 1 }]) expect(biz(await update(p.id, f), "CAMPO_NO_PERMITIDO"), J(f));
    expect(biz(await update(p.id, {}), "UPDATE_VACIO"), "empty update");
    expect(biz(await update(p.id, { status: "deleted" }), "OPERACION_INVALIDA"), "status deleted");
    expect(biz(await update(p.id, { status: "xyz" }), "ESTADO_INVALIDO"), "unknown status");
    expect(biz(await update(987654321, { name: "x" }), "PRODUCTO_NO_ENCONTRADO"), "nonexistent");
    expect(biz(await update("5", { name: "x" }), "PRODUCTO_INVALIDO"), "id type");
    expect(biz(await update(p.id, { name: "" }), "CAMPO_INVALIDO"), "empty name");
    expect(biz(await update(p.id, { sku: other.sku }), "SKU_DUPLICADO"), "duplicate sku on update");
    expect((await snap()) === before, "none of the rejected updates left a trace");
  });
  await test("PROD-10.deleted_products_cannot_be_edited_or_resurrected", "integration", async () => {
    const p = await data.product("U3", "8.00", 2);
    expect((await call(`api.products.softDelete(${p.id},'e2e')`)).ok, "delete");
    expect(biz(await update(p.id, { name: "x" }), "PRODUCTO_ELIMINADO"), "edit");
    expect(biz(await update(p.id, { status: "active" }), "PRODUCTO_ELIMINADO"), "resurrect");
    expect(biz(await update(p.id, { status: "active", name: "back" }), "PRODUCTO_ELIMINADO"), "resurrect with other fields");
    const row = await one("select status, stock, name from products where id=$1", [p.id]);
    expect(row.status === "deleted" && row.stock === 0 && row.name !== "back", J(row));
  });
  await test("PROD-11.update_racing_soft_delete_never_resurrects_a_deleted_product", "integration", async () => {
    const seen = { updateWon: 0, deleteWon: 0 };
    for (let i = 0; i < 12; i++) {
      const p = await data.product("RACE" + i, "3.00", 3);
      await db.query("update products set status='inactive' where id=$1", [p.id]); // update(status:'active') would resurrect
      const upd = `api.products.update(${p.id}, {status:'active', name:'race'})`, del = `api.products.softDelete(${p.id},'race')`;
      const r = await contended(p.id, i % 2 === 0 ? [upd, del] : [del, upd]);
      expect(r.ok, r.err);
      const [u, d] = i % 2 === 0 ? [r.v[0], r.v[1]] : [r.v[1], r.v[0]];
      r.v = [u, d];
      expect(r.v[1].ok, "soft delete always succeeds: " + J(r.v));
      const final = await one("select status, stock from products where id=$1", [p.id]);
      expect(final.status === "deleted" && final.stock === 0, `round ${i}: final state must be deleted, got ${J(final)} (outcomes ${J(r.v)})`);
      expect((await one("select count(*)::int n from deleted_products_log where product_id=$1", [p.id])).n === 1, "one audit row");
      if (r.v[0].ok) seen.updateWon++;
      else { expect(r.v[0].err.includes("[PRODUCTO_ELIMINADO]"), "the losing update says why: " + J(r.v[0])); seen.deleteWon++; }
    }
    expect(seen.updateWon > 0 && seen.deleteWon > 0, "both interleavings must have been exercised: " + J(seen));
    return `12 rounds, final state always deleted (update first: ${seen.updateWon}, delete first: ${seen.deleteWon})`;
  });

  // ================================================================== inventory movements
  const mv = async (p) => rows("select type, amount, reason, user_id from inventory_movements where product_id=$1 order by id", [p.id]);
  await test("INV-01.valid_in_out_and_both_adjusts_update_stock_and_history", "integration", async () => {
    const p = await data.product("I1", "5.00", 10);
    expect((await move(p.id, "IN", 5, "compra")).ok, "IN");
    expect((await stockOf(p)) === 15, "15");
    expect((await move(p.id, "OUT", -3, "merma")).ok, "OUT");
    expect((await stockOf(p)) === 12, "12");
    expect((await move(p.id, "ADJUST", 4, "conteo +")).ok, "ADJUST +");
    expect((await stockOf(p)) === 16, "16");
    expect((await move(p.id, "ADJUST", -6, "conteo -")).ok, "ADJUST -");
    expect((await stockOf(p)) === 10, "10: ADJUST stays a signed difference, never an absolute stock");
    const h = await mv(p);
    expect(h.length === 4 && h.every((x) => x.user_id === admin.id) && h.map((x) => `${x.type}:${x.amount}`).join() === "IN:5,OUT:-3,ADJUST:4,ADJUST:-6", "history " + J(h));
    expect(h[0].reason === "compra", "reason kept");
  });
  await test("INV-02.invalid_quantities_are_rejected", "integration", async () => {
    const p = await data.product("I2", "5.00", 10);
    const before = await snap();
    for (const amount of ["1.5", "-1.5", "0", "-0", "NaN", "Infinity", "'3'", "null", "undefined", "1000001", "-1000001"]) {
      const r = await call(`api.inventory.addMovement({productId:${p.id}, type:'ADJUST', amount:${amount}, reason:'e2e'})`);
      expect(biz(r, "CANTIDAD_INVALIDA"), `amount ${amount}: ${J(r)}`);
    }
    expect((await snap()) === before, "nothing persisted");
  });
  await test("INV-03.insufficient_stock_is_rejected_without_trace", "integration", async () => {
    const p = await data.product("I3", "5.00", 3);
    const before = await snap();
    expect(biz(await move(p.id, "OUT", -4), "STOCK_INSUFICIENTE"), "OUT");
    expect(biz(await move(p.id, "ADJUST", -4), "STOCK_INSUFICIENTE"), "ADJUST");
    expect((await snap()) === before, "no stock change, no movement");
    expect((await move(p.id, "OUT", -3)).ok && (await stockOf(p)) === 0, "taking exactly all the stock is allowed");
  });
  await test("INV-04.nonexistent_and_invalid_products_are_rejected", "integration", async () => {
    const before = await snap();
    expect(biz(await move(987654321, "IN", 1), "PRODUCTO_NO_ENCONTRADO"), "nonexistent");
    for (const id of ["0", "-1", "1.5", "'3'", "null"]) expect(biz(await call(`api.inventory.addMovement({productId:${id}, type:'IN', amount:1, reason:'x'})`), "PRODUCTO_INVALIDO"), "productId " + id);
    expect((await snap()) === before, "nothing persisted");
  });
  await test("INV-05.deleted_products_reject_movements", "integration", async () => {
    const p = await data.product("I5", "5.00", 2);
    expect((await call(`api.products.softDelete(${p.id},'e2e')`)).ok, "delete");
    const before = await snap();
    for (const [type, amount] of [["IN", 5], ["ADJUST", 5], ["OUT", -1]]) expect(biz(await move(p.id, type, amount), "PRODUCTO_ELIMINADO"), type);
    expect((await snap()) === before && (await stockOf(p)) === 0, "deleted product keeps stock 0 and gains no history");
  });
  await test("INV-06.type_and_sign_combinations_are_enforced", "integration", async () => {
    const p = await data.product("I6", "5.00", 5);
    const before = await snap();
    for (const t of ["'XX'", "'in'", "'Out'", "null", "undefined", "5", "''"]) expect(biz(await call(`api.inventory.addMovement({productId:${p.id}, type:${t}, amount:1, reason:'x'})`), "TIPO_INVALIDO"), "type " + t);
    expect(biz(await move(p.id, "DELETE", -1), "TIPO_RESERVADO"), "DELETE via the adjustment route");
    expect(biz(await move(p.id, "DELETE", 1), "TIPO_RESERVADO"), "DELETE positive");
    expect(biz(await move(p.id, "IN", -2), "SIGNO_INVALIDO"), "negative IN");
    expect(biz(await move(p.id, "OUT", 2), "SIGNO_INVALIDO"), "positive OUT (used to ADD stock before)");
    for (const reason of ["''", "'   '", "null", "'x'.repeat(501)"]) expect(biz(await call(`api.inventory.addMovement({productId:${p.id}, type:'IN', amount:1, reason:${reason}})`), "MOTIVO_INVALIDO"), "reason " + reason);
    expect((await snap()) === before, "nothing persisted");
  });
  await test("INV-07.session_user_is_recorded_whatever_the_client_claims", "integration", async () => {
    const p = await data.product("I7", "5.00", 1);
    const r = await call(`api.inventory.addMovement({productId:${p.id}, type:'IN', amount:1, reason:'forged', userId:99999, user_id:99999})`);
    expect(r.ok, r.err);
    expect((await mv(p))[0].user_id === admin.id, "movement attributed to the authenticated user");
  });
  await test("INV-08.concurrent_adjustments_never_drive_stock_negative", "integration", async () => {
    const p = await data.product("I8", "5.00", 5);
    const calls = Array.from({ length: 8 }, () => `api.inventory.addMovement({productId:${p.id}, type:'ADJUST', amount:-1, reason:'e2e'})`);
    const r = await contended(p.id, calls);
    expect(r.ok, r.err);
    expect(r.v.filter((x) => x.ok).length === 5, "exactly 5 of 8 succeed: " + J(r.v));
    expect(r.v.filter((x) => !x.ok).every((x) => x.err.includes("[STOCK_INSUFICIENTE]")), "the rest are told why");
    expect((await stockOf(p)) === 0, "stock 0");
    expect((await mv(p)).reduce((a, x) => a + x.amount, 0) === -5 && (await mv(p)).length === 5, "history matches the stock exactly");
  });
  await test("INV-09.concurrent_ins_and_outs_keep_stock_and_history_consistent", "integration", async () => {
    const p = await data.product("I9", "5.00", 0);
    const calls = [];
    for (let i = 0; i < 6; i++) calls.push(`api.inventory.addMovement({productId:${p.id}, type:'IN', amount:2, reason:'e2e'})`);
    for (let i = 0; i < 6; i++) calls.push(`api.inventory.addMovement({productId:${p.id}, type:'OUT', amount:-1, reason:'e2e'})`);
    const r = await settled(calls);
    expect(r.ok, r.err);
    const h = await mv(p);
    const final = await stockOf(p);
    expect(final >= 0 && final === h.reduce((a, x) => a + x.amount, 0), `stock ${final} must equal the sum of recorded movements ${h.reduce((a, x) => a + x.amount, 0)}`);
    expect(r.v.every((x) => x.ok || x.err.includes("[STOCK_INSUFICIENTE]")), "only stock rejections are allowed: " + J(r.v.filter((x) => !x.ok)));
    expect(h.length === r.v.filter((x) => x.ok).length, "one movement per accepted call");
  });
  await test("INV-10.sale_racing_an_adjustment_on_the_last_unit_has_one_winner", "integration", async () => {
    await closeAll();
    const sid = (await call("api.cash.openSession(0)")).v.id;
    const wins = { sale: 0, adjust: 0 };
    for (let i = 0; i < 6; i++) {
      const p = await data.product("I10" + i, "10.00", 1);
      const sale = J({ items: [{ productId: p.id, quantity: 1, unitPrice: 10, subtotal: 10 }], total: 10, paymentMethod: "card", sessionId: sid });
      const calls = [`api.sales.create(${sale})`, `api.inventory.addMovement(${J({ productId: p.id, type: "OUT", amount: -1, reason: "race" })})`];
      const r = await contended(p.id, i % 2 === 0 ? calls : [calls[1], calls[0]]);
      expect(r.ok, r.err);
      if (i % 2 === 1) r.v.reverse();
      if (r.v[0].ok) wins.sale++; else wins.adjust++;
      expect(r.v.filter((x) => x.ok).length === 1, `round ${i}: exactly one winner: ${J(r.v)}`);
      expect(r.v.find((x) => !x.ok).err.includes("[STOCK_INSUFICIENTE]"), "the loser is told why");
      expect((await stockOf(p)) === 0 && (await mv(p)).length === 1, "stock 0 and exactly one movement");
    }
    expect(wins.sale > 0 && wins.adjust > 0, "both orders exercised: " + J(wins));
    await closeAll();
    return J(wins);
  });
  await test("INV-11.failure_after_the_stock_update_rolls_everything_back", "integration", async () => {
    const p = await data.product("I11", "5.00", 5);
    await withTrigger("inventory_movements", "before insert", "e2e_fail_inv2", `if new.product_id = ${p.id} then raise exception 'e2e injected failure'; end if; return new;`, async () => {
      const before = await snap();
      const mark = c.mainLog.length;
      const r = await move(p.id, "IN", 10);
      expect(biz(r, "ERROR_INTERNO") && (await failedAt(mark, "inventory:addMovement", "insert into \"inventory_movements\"")), "an unexpected failure: generic public error + redacted diagnostic in the main log at the injected failure point: " + JSON.stringify(r).slice(0, 200));
      expect((await snap()) === before && (await stockOf(p)) === 5, "stock restored, no orphan movement");
    });
  });

  // ================================================================== price changes
  const history = (p) => rows("select old_price, new_price, changed_by, reason from price_changes where product_id=$1 order by id", [p.id]);
  await test("PRICE-01.valid_change_records_the_old_price_read_from_the_database", "integration", async () => {
    const p = await data.product("PR1", "10.00", 1);
    const r = await reprice({ productId: p.id, newPrice: "12.50", reason: "  inflación  " });
    expect(r.ok && r.v === true, J(r));
    expect((await priceOf(p)) === 12.5, "price updated");
    const h = await history(p);
    expect(h.length === 1 && money(h[0].old_price) === 10 && money(h[0].new_price) === 12.5 && h[0].changed_by === admin.id && h[0].reason === "inflación", "history " + J(h));
    expect((await reprice({ productId: p.id, newPrice: 9.99, oldPrice: 12.5 })).ok, "a correct claimed oldPrice is accepted");
    const h2 = await history(p);
    expect(h2.length === 2 && money(h2[1].old_price) === 12.5 && money(h2[1].new_price) === 9.99 && h2[1].reason === null, "chain old->new is continuous, reason optional");
  });
  await test("PRICE-02.forged_old_price_is_rejected", "integration", async () => {
    const p = await data.product("PR2", "10.00", 1);
    const before = await snap();
    for (const oldPrice of [1, 9.99, 10.01, "'7.00'", 0]) {
      const r = await call(`api.priceChanges.create({productId:${p.id}, newPrice:11, oldPrice:${oldPrice}, reason:'x'})`);
      expect(biz(r, "PRECIO_DESACTUALIZADO"), `oldPrice ${oldPrice}: ${J(r)}`);
    }
    expect((await snap()) === before && (await priceOf(p)) === 10, "nothing changed");
    expect((await reprice({ productId: p.id, newPrice: 11, oldPrice: 10 })).ok, "the true old price is accepted");
    expect(money((await history(p))[0].old_price) === 10, "recorded old price is the database one");
  });
  await test("PRICE-03.invalid_prices_and_payloads_are_rejected", "integration", async () => {
    const p = await data.product("PR3", "10.00", 1);
    const before = await snap();
    for (const v of ["-1", "NaN", "Infinity", "1.001", "'abc'", "null", "undefined", "1e12"]) expect(biz(await call(`api.priceChanges.create({productId:${p.id}, newPrice:${v}})`), "IMPORTE_INVALIDO"), "newPrice " + v);
    expect(biz(await call(`api.priceChanges.create({productId:${p.id}, newPrice:11, oldPrice:NaN})`), "IMPORTE_INVALIDO"), "oldPrice NaN");
    expect(biz(await reprice({ productId: p.id, newPrice: 10 }), "SIN_CAMBIO"), "same price is not a change");
    expect(biz(await reprice({ productId: p.id, newPrice: 11, reason: "x".repeat(501) }), "MOTIVO_INVALIDO"), "reason length");
    for (const id of ["0", "-3", "1.5", "'1'", "null"]) expect(biz(await call(`api.priceChanges.create({productId:${id}, newPrice:1})`), "PRODUCTO_INVALIDO"), "productId " + id);
    expect(biz(await call("api.priceChanges.create(null)"), "CAMBIO_INVALIDO"), "null payload");
    expect((await snap()) === before && (await priceOf(p)) === 10, "nothing changed");
  });
  await test("PRICE-04.deleted_and_missing_products_are_rejected", "integration", async () => {
    const p = await data.product("PR4", "10.00", 1);
    expect((await call(`api.products.softDelete(${p.id},'e2e')`)).ok, "delete");
    const before = await snap();
    expect(biz(await reprice({ productId: p.id, newPrice: 12 }), "PRODUCTO_ELIMINADO"), "deleted");
    expect(biz(await reprice({ productId: 987654321, newPrice: 12 }), "PRODUCTO_NO_ENCONTRADO"), "missing");
    expect((await snap()) === before && (await priceOf(p)) === 10, "nothing changed");
  });
  await test("PRICE-05.price_change_racing_a_sale_is_consistent", "integration", async () => {
    await closeAll();
    const sid = (await call("api.cash.openSession(0)")).v.id;
    const p = await data.product("PR5", "10.00", 100);
    let price = 10;
    const out = { saleFirst: 0, priceFirst: 0 };
    for (let i = 0; i < 8; i++) {
      const next = price + 1;
      const sale = J({ items: [{ productId: p.id, quantity: 1, unitPrice: price, subtotal: price }], total: price, paymentMethod: "card", sessionId: sid });
      const calls = [`api.sales.create(${sale})`, `api.priceChanges.create(${J({ productId: p.id, newPrice: next, oldPrice: price })})`];
      const r = await contended(p.id, i % 2 === 0 ? calls : [calls[1], calls[0]]);
      expect(r.ok, r.err);
      if (i % 2 === 1) r.v.reverse();
      expect(r.v[1].ok, `round ${i}: the price change must win or tie, never fail: ${J(r.v)}`);
      expect((await priceOf(p)) === next, "final price is the new one");
      if (r.v[0].ok) {
        const si = await one("select unit_price from sale_items si join sales s on s.id=si.sale_id where si.product_id=$1 order by si.id desc limit 1", [p.id]);
        expect(money(si.unit_price) === price, `a sale that won the race was priced at the OLD price (${price}), got ${si.unit_price}`);
        out.saleFirst++;
      } else {
        expect(r.v[0].err.includes("[PRECIO_DESACTUALIZADO]"), "a sale that lost the race is rejected as stale: " + J(r.v[0]));
        out.priceFirst++;
      }
      price = next;
    }
    const chain = await history(p);
    expect(chain.length === 8 && chain.every((h, i) => money(h.old_price) === 10 + i && money(h.new_price) === 11 + i), "price history is a continuous chain: " + J(chain.map((h) => [h.old_price, h.new_price])));
    expect(out.saleFirst > 0 && out.priceFirst > 0, "both interleavings exercised: " + J(out));
    await closeAll();
    return `8 rounds (sale first: ${out.saleFirst}, price first: ${out.priceFirst})`;
  });
  await test("PRICE-06.failure_at_history_or_at_the_price_update_rolls_back", "integration", async () => {
    const p = await data.product("PR6", "10.00", 1);
    await withTrigger("price_changes", "before insert", "e2e_fail_hist", `if new.product_id = ${p.id} then raise exception 'e2e injected failure'; end if; return new;`, async () => {
      const before = await snap();
      const mark = c.mainLog.length;
      const r = await reprice({ productId: p.id, newPrice: 15 });
      expect(biz(r, "ERROR_INTERNO") && (await failedAt(mark, "priceChanges:create", "insert into \"price_changes\"")), "an unexpected failure: generic public error + redacted diagnostic in the main log at the injected failure point: " + JSON.stringify(r).slice(0, 200));
      expect((await snap()) === before && (await priceOf(p)) === 10, "history failure: price unchanged");
    });
    await withTrigger("products", "before update", "e2e_fail_upd", `if new.id = ${p.id} and new.price <> old.price then raise exception 'e2e injected failure'; end if; return new;`, async () => {
      const before = await snap();
      const mark = c.mainLog.length;
      const r = await reprice({ productId: p.id, newPrice: 15 });
      expect(biz(r, "ERROR_INTERNO") && (await failedAt(mark, "priceChanges:create", "update \"products\"")), "an unexpected failure: generic public error + redacted diagnostic in the main log at the injected failure point: " + JSON.stringify(r).slice(0, 200));
      expect((await snap()) === before && (await history(p)).length === 0 && (await priceOf(p)) === 10, "update failure: the history row written before it is rolled back too");
    });
  });

  // ================================================================== interplay with the already fixed flows
  await test("MIX-01.sales_still_work_with_products_created_and_priced_through_the_new_paths", "integration", async () => {
    await closeAll();
    const sid = (await call("api.cash.openSession(0)")).v.id;
    const r = await create({ sku: sku("M1"), name: "Flujo completo", price: "20.00", stock: 5 });
    expect(r.ok, r.err);
    expect((await reprice({ productId: r.v.id, newPrice: "22.50" })).ok, "reprice");
    expect((await move(r.v.id, "IN", 3, "recepción")).ok, "add stock");
    const sale = await call(`api.sales.create(${J({ items: [{ productId: r.v.id, quantity: 2, unitPrice: 22.5, subtotal: 45 }], total: 45, paymentMethod: "cash", sessionId: sid })})`);
    expect(sale.ok, sale.err);
    expect((await one("select stock from products where id=$1", [r.v.id])).stock === 6, "5 + 3 - 2");
    const h = await rows("select type, amount from inventory_movements where product_id=$1 order by id", [r.v.id]);
    expect(h.map((x) => `${x.type}:${x.amount}`).join() === "IN:5,IN:3,OUT:-2", "history is complete and consistent with stock: " + J(h));
    const stale = await call(`api.sales.create(${J({ items: [{ productId: r.v.id, quantity: 1, unitPrice: 20, subtotal: 20 }], total: 20, paymentMethod: "cash", sessionId: sid })})`);
    expect(biz(stale, "PRECIO_DESACTUALIZADO"), "a client holding the old price is rejected: " + J(stale));
    await closeAll();
  });

  await closeAll();
  await ui.logout(page).catch(() => {});
}
