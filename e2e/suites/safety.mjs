// Safety suite (Sprint 04, block B): sales visibility on the ORIGINAL channels, checkout idempotency against the
// persisted lines, safe errors, and recovery after the database connection is lost. Everything runs on the run's
// throwaway database. Direct IPC is used because these are contracts of the main process; the visual part signs in
// through the real screen.
import { APP_URL, ui, ipc, expect, closeStrayCash, containsSecret } from "../lib/harness.mjs";

const J = JSON.stringify;

export async function run(c) {
  const { page, app, db, data, test, mainLog } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const num = (v) => Number(v);
  const call = (expr) => ipc(page, expr);
  const LEAKS = /Failed query|params:|\n\s+at |select |insert |update |relation "|password|postgres(ql)?:\/\//i;

  const admin = await data.user("SAF_ADMIN", "admin");
  const v1 = await data.user("SAF_V1", "vendor");
  const v2 = await data.user("SAF_V2", "vendor");
  await closeStrayCash(db, admin.id);
  const pA = await data.product("SA", "5.00", 500);
  const pB = await data.product("SB", "2.50", 500);
  const pLeg = await data.product("SLEG", "9.00", 50);
  const sess = (await one("insert into cash_sessions(opened_by,initial_amount,current_amount,status,opened_at,closed_at,closed_by,final_amount) values($1,'0','0','closed',$2,$3,$1,'0') returning id", [admin.id, new Date(2026, 5, 1, 8), new Date(2026, 5, 1, 20)])).id;
  const mkSale = async (userId, total, at, items) => {
    const s = await one("insert into sales(user_id,cash_session_id,total,payment_method,created_at) values($1,$2,$3,'cash',$4) returning id", [userId, sess, total, at]);
    for (const it of items) await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,$3,$4,$5,$6,$7)", [s.id, it.p.id, it.q, it.price, (num(it.price) * it.q).toFixed(2), it.name ?? null, it.sku ?? null]);
    return s.id;
  };
  const sV1 = [];
  for (let i = 0; i < 3; i++) sV1.push(await mkSale(v1.id, "5.00", new Date(2026, 5, 1, 9 + i), [{ p: pA, q: 1, price: "5.00", name: "V1 artículo " + i, sku: "V1-" + i }]));
  const sV2 = [];
  for (let i = 0; i < 2; i++) sV2.push(await mkSale(v2.id, "2.50", new Date(2026, 5, 1, 13 + i), [{ p: pB, q: 1, price: "2.50", name: "V2 artículo " + i, sku: "V2-" + i }]));
  const sAdmin = await mkSale(admin.id, "9.00", new Date(2026, 5, 1, 16), [{ p: pLeg, q: 1, price: "9.00" }]); // legacy-style line: no stored name
  const fixtureIds = [...sV1, ...sV2, sAdmin];

  const loginAs = async (u) => {
    await ipc(page, "api.auth.logout()");
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, u.pin);
    await page.waitForURL(u.role === "admin" ? /#\/dashboard$/ : /#\/sales$/, { timeout: 8000 });
  };

  // ================================================================== B1: the original channels
  await test("SAF-00.admin_signs_in_and_opens_the_register", "e2e", async () => {
    await loginAs(admin);
    const r = await call("api.cash.openSession(100)");
    expect(r.ok && r.v.id, "register opened: " + J(r));
  });
  await test("SAF-01.admin_sees_every_sale_on_the_original_channels", "security", async () => {
    const all = await call("api.sales.getAll()");
    expect(all.ok && Array.isArray(all.v), "getAll answers a list");
    const ids = new Set(all.v.map((s) => s.id));
    expect(fixtureIds.every((id) => ids.has(id)), "every fixture sale is visible to the administrator");
    expect(J(all.v.map((s) => s.id)) === J((await rows("select id from sales order by created_at desc, id desc limit 100")).map((r) => r.id)), "same order and limit as before (newest first, 100)");
    const one1 = await call(`api.sales.getById(${sV2[0]})`);
    expect(one1.ok && one1.v && one1.v.id === sV2[0] && one1.v.items.length === 1, "getById of another seller's sale works for the administrator");
    const keys = Object.keys(one1.v).sort();
    expect(["cashSessionId", "createdAt", "id", "items", "paymentMethod", "total", "userId"].every((k) => keys.includes(k)), "contract keys preserved: " + keys.join());
    expect(J(Object.keys(one1.v.items[0]).sort()) === J(["id", "productId", "productName", "productSku", "quantity", "subtotal", "unitPrice"]), "line shape preserved");
    expect(one1.v.items[0].productName === "V2 artículo 0" && one1.v.items[0].productSku === "V2-0", "the name as sold is used when stored");
    const legacy = await call(`api.sales.getById(${sAdmin})`);
    expect(legacy.v.items[0].productName === pLeg.name, "an old sale without a stored name falls back to the catalogue name");
  });
  await test("SAF-02.vendor_sees_only_their_own_sales_on_the_original_channels", "security", async () => {
    await loginAs(v1);
    const all = await call("api.sales.getAll()");
    expect(all.ok, "getAll still works for a vendor: " + J(all));
    expect(all.v.length >= 3 && all.v.every((s) => s.userId === v1.id), "only the vendor's own sales: " + J(all.v.map((s) => [s.id, s.userId])));
    expect(J(all.v.map((s) => s.id).filter((id) => fixtureIds.includes(id)).sort()) === J([...sV1].sort()), "exactly their 3 fixture sales");
    for (const id of [...sV2, sAdmin]) {
      const r = await call(`api.sales.getById(${id})`);
      expect(r.ok && r.v === null, `another seller's sale ${id} is denied (null) and reveals nothing: ` + J(r));
    }
    const own = await call(`api.sales.getById(${sV1[1]})`);
    expect(own.ok && own.v && own.v.items[0].productName === "V1 artículo 1", "their own sale is readable");
    const missing = await call("api.sales.getById(99999999)");
    expect(missing.ok && missing.v === null, "a missing sale answers exactly like a foreign one (null): no way to probe ids");
    // the new channels agree with the old ones
    const list = await call("api.sales.list({page:1,pageSize:100})");
    expect(list.ok && J(list.v.rows.map((r) => r.id).sort()) === J(all.v.map((s) => s.id).sort()), "sales:list and sales:getAll show the same set to a vendor");
  });
  await test("SAF-03.the_vendor_screen_matches_visually", "e2e", async () => {
    await ui.nav(page, "Historial");
    const table = page.getByRole("table", { name: "Ventas" });
    await table.waitFor();
    const text = await table.innerText();
    for (const id of sV1) expect(text.includes(`#${id}`), "own folio #" + id + " listed");
    for (const id of [...sV2, sAdmin]) expect(!text.includes(`#${id}\t`) && !new RegExp(`#${id}(\\D|$)`).test(text), "foreign folio #" + id + " not listed");
    await page.locator("#hs-q").fill(String(sV2[0]));
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByText("No hay ventas que coincidan").waitFor();
  });
  await test("SAF-04.invalid_ids_and_errors_leak_no_sql_connection_details_or_foreign_data", "security", async () => {
    const before = mainLog.length;
    for (const bad of ["'abc'", "-1", "0", "1.5", "{}", "null", "undefined", "1e20", "'1 OR 1=1'", "[1]", "true"]) {
      for (const ch of ["api.sales.getById", "api.sales.getDetail", "api.receipts.preview", "api.returns.getSaleForReturn"]) {
        const r = await call(`${ch}(${bad})`);
        expect(r.ok === false && /\[(VENTA_INVALIDA|VENTA_NO_ENCONTRADA)\]/.test(r.err) && !LEAKS.test(r.err), `${ch}(${bad}) -> stable business error without internals: ` + J(r));
      }
    }
    const logged = mainLog.slice(before).join("\n");
    expect(!containsSecret(logged), "nothing secret reached the main log");
    const foreign = await call(`api.sales.getDetail(${sV2[0]})`);
    expect(foreign.ok === false && /\[VENTA_NO_ENCONTRADA\]/.test(foreign.err) && !foreign.err.includes("V2 artículo") && !foreign.err.includes("2.50"), "a foreign sale reveals none of its data: " + J(foreign));
  });
  await test("SAF-05.returns_channels_stay_open_to_every_signed_in_user_as_documented", "security", async () => {
    // DOCUMENTED, NOT ENDORSED: the owner has not decided a policy for returns, so nothing changed here. This pins the
    // current behaviour so any change to it is a conscious decision (docs/STATUS.md lists it as an open item).
    const lookup = await call(`api.returns.getSaleForReturn(${sV2[0]})`);
    expect(lookup.ok && lookup.v.sale.id === sV2[0], "a vendor can look up ANOTHER seller's sale for a return (open item): " + J(lookup.ok ? lookup.v.sale : lookup));
    const list = await call("api.returns.getAll()");
    expect(list.ok && Array.isArray(list.v), "returns:getAll answers any signed-in user");
    const src = (await import("node:fs")).default.readFileSync(new URL("../../src/backend/ipc.ts", import.meta.url), "utf8");
    expect(/"returns:create": "authenticated"/.test(src) && /"returns:getAll": "authenticated"/.test(src) && /"returns:getSaleForReturn": "authenticated"/.test(src), "the ACCESS table still lists the three returns channels as authenticated");
  });

  // ================================================================== B2: idempotent checkout
  await loginAs(admin);
  const openId = () => one("select id from cash_sessions where closed_at is null").then((r) => r.id);
  const items = (...l) => l.map(([p, q]) => ({ productId: p.id, quantity: q, unitPrice: num(p.price), subtotal: num(p.price) * q }));
  const payload = (op, sessionId, list, method = "cash") => ({ items: list, total: list.reduce((s, i) => s + i.subtotal, 0), paymentMethod: method, sessionId, operationId: op });
  const create = (p) => call(`api.sales.create(${J(p)})`);
  const code = (r) => (r.ok === false ? (String(r.err).match(/^.*?\[(\w+)\]/) || [])[1] : "OK");
  const counts = async (saleId) => ({
    sales: (await one("select count(*)::int n from sales")).n,
    cash: (await one("select count(*)::int n from cash_movements where reason like $1", [`Venta #${saleId} %`])).n,
    inv: (await one("select count(*)::int n from inventory_movements where reason=$1", [`Venta #${saleId}`])).n,
  });
  const stock = async (p) => (await one("select stock from products where id=$1", [p.id])).stock;
  let op1 = null;

  await test("SAF-06.replay_returns_the_original_sale_and_the_lines_are_compared_with_what_was_stored", "integration", async () => {
    const sid = await openId();
    const op = "op-" + c.runId + "-idem0001";
    const original = items([pA, 1], [pB, 2]); // 5.00 + 5.00 = 10.00
    const a0 = await stock(pA), b0 = await stock(pB);
    const r1 = await create(payload(op, sid, original));
    expect(r1.ok && r1.v.replayed === false, "first checkout: " + J(r1));
    const after1 = await counts(r1.v.id);
    expect(after1.cash === 1 && after1.inv === 2, "one cash movement and one stock movement per line: " + J(after1));
    // identical retry, and the same lines in another order
    const again = await create(payload(op, sid, original));
    const reordered = await create(payload(op, sid, [...original].reverse()));
    expect(again.ok && again.v.id === r1.v.id && again.v.replayed === true && reordered.ok && reordered.v.id === r1.v.id, "identical and reordered retries return the original sale: " + J([again, reordered]));
    // same total, different articles / quantities / unit price: rejected
    const cases = [
      ["different articles, same total", payload(op, sid, items([pA, 2]))],
      ["different quantities, same total", payload(op, sid, [{ productId: pA.id, quantity: 1, unitPrice: 10, subtotal: 10 }])],
      ["a subset of the lines", payload(op, sid, items([pA, 1]))],
      ["an extra line", payload(op, sid, [...original, ...items([pLeg, 1])])],
      ["another payment method", payload(op, sid, original, "card")],
    ];
    for (const [label, p] of cases) {
      const r = await create(p);
      expect(code(r) === "OPERACION_DUPLICADA" && !LEAKS.test(r.err), `${label} -> OPERACION_DUPLICADA: ` + J(r));
    }
    // another register (a closed one) and another user
    const otherSession = await create(payload(op, sess, original));
    expect(code(otherSession) === "OPERACION_DUPLICADA", "another register -> rejected: " + J(otherSession));
    const final = await counts(r1.v.id);
    expect(final.sales === after1.sales && final.cash === 1 && final.inv === 2, "still one sale and no duplicated movements: " + J(final));
    expect((await stock(pA)) === a0 - 1 && (await stock(pB)) === b0 - 2, "stock decreased exactly once");
    // legacy: a checkout without operationId keeps working and is never treated as a replay
    const noOp = await create({ ...payload("x", sid, items([pB, 1])), operationId: undefined });
    expect(noOp.ok && noOp.v.replayed === false, "no operationId: " + J(noOp));
    op1 = { op, original, saleId: r1.v.id };
  });
  await test("SAF-07.another_user_cannot_replay_or_discover_a_sale_through_its_operation_id", "security", async () => {
    const { op, original, saleId } = op1;
    await loginAs(v1);
    const sid = await openId();
    const r = await create(payload(op, sid, original));
    expect(code(r) === "OPERACION_DUPLICADA" && !r.err.includes(String(saleId)) && !LEAKS.test(r.err), "another user -> rejected without revealing the sale: " + J(r));
    expect((await one("select count(*)::int n from sales where operation_id=$1", [op])).n === 1, "still one sale with that operation id");
    await loginAs(admin);
  });
  await test("SAF-08.concurrent_retries_create_one_sale_and_conflicting_carts_cannot_both_win", "integration", async () => {
    const sid = await openId();
    const n0 = (await one("select count(*)::int n from sales")).n;
    const opSame = "op-" + c.runId + "-idem0002";
    const cart = items([pA, 1], [pB, 2]);
    const same = await call(`Promise.all(Array.from({length: 6}, () => api.sales.create(${J(payload(opSame, sid, cart))}).then(r => ({ok:true,id:r.id}), e => ({ok:false,err:String(e.message)}))))`);
    expect(same.ok && same.v.every((x) => x.ok) && new Set(same.v.map((x) => x.id)).size === 1, "six identical concurrent checkouts: one sale: " + J(same.v));
    expect((await one("select count(*)::int n from sales")).n === n0 + 1, "exactly one sale row");
    const cnt = await counts(same.v[0].id);
    expect(cnt.cash === 1 && cnt.inv === 2, "and exactly one set of movements: " + J(cnt));
    // two DIFFERENT carts with the same total race for one operation id
    const opMix = "op-" + c.runId + "-idem0003";
    const X = items([pA, 2]); // 10.00
    const Y = items([pB, 4]); // 10.00
    const calls = [X, Y, X, Y, X, Y].map((cartX) => `api.sales.create(${J(payload(opMix, sid, cartX))}).then(r => ({ok:true,id:r.id,qty:${J(cartX.map((i) => i.productId))}}), e => ({ok:false,err:String(e.message)}))`);
    const mix = await call(`Promise.all([${calls.join(",")}])`);
    const wins = mix.v.filter((x) => x.ok);
    expect(wins.length >= 1 && new Set(wins.map((w) => w.id)).size === 1, "one sale wins: " + J(mix.v));
    expect(new Set(wins.map((w) => J(w.qty))).size === 1, "every success belongs to the SAME cart");
    expect(mix.v.filter((x) => !x.ok).every((x) => /\[OPERACION_DUPLICADA\]/.test(x.err)), "the losing cart is rejected with the stable code: " + J(mix.v));
    expect((await one("select count(*)::int n from sales where operation_id=$1", [opMix])).n === 1, "one sale for the contested operation id");
    const winner = await counts(wins[0].id);
    expect(winner.cash === 1, "one cash movement for the winner: " + J(winner));
  });

  // ================================================================== connection loss and recovery
  const appBackends = () => rows("select pid, wait_event_type from pg_stat_activity where application_name='e2e_app' and datname=current_database() and pid <> pg_backend_pid()");
  await test("SAF-09.losing_the_database_connections_does_not_crash_the_app_and_it_recovers", "integration", async () => {
    expect((await call("api.products.getAll()")).ok, "works before");
    const killed = await rows("select pg_terminate_backend(pid) t from pg_stat_activity where application_name='e2e_app' and datname=current_database() and pid <> pg_backend_pid()");
    expect(killed.length >= 1, "there were connections to terminate: " + killed.length);
    let recovered = false;
    for (let i = 0; i < 5 && !recovered; i++) {
      const r = await call("api.products.getAll()");
      recovered = r.ok;
      if (!recovered) {
        expect(/\[ERROR_INTERNO\]/.test(r.err) && !LEAKS.test(r.err), "a failure in that window is a clean internal error: " + J(r));
        await new Promise((res) => setTimeout(res, 300));
      }
    }
    expect(recovered, "the next calls succeed again (the pool reconnects)");
    expect(await app.evaluate(() => 1) === 1, "the main process is still alive");
    const sessionStill = await call("api.auth.me()");
    expect(sessionStill.ok && sessionStill.v && sessionStill.v.id === admin.id, "the user session survived (it lives in main, not in the connection)");
  });
  await test("SAF-10.a_checkout_killed_mid_flight_persists_nothing_and_its_retry_creates_exactly_one_sale", "integration", async () => {
    const sid = await openId();
    const op = "op-" + c.runId + "-idem0004";
    const cart = items([pB, 3]);
    const n0 = (await one("select count(*)::int n from sales")).n;
    const b0 = await stock(pB);
    const { Client } = (await import("pg")).default;
    const { urlFor } = await import("../lib/harness.mjs");
    const locker = new Client({ connectionString: urlFor(c.runDb, "e2e_locker") });
    await locker.connect();
    try {
      await locker.query("begin");
      await locker.query("select id from cash_sessions where id=$1 for update", [sid]); // the checkout will queue behind this lock
      const inflight = call(`api.sales.create(${J(payload(op, sid, cart))})`);
      let waiter = null;
      for (let i = 0; i < 60 && !waiter; i++) {
        waiter = (await appBackends()).find((b) => b.wait_event_type === "Lock");
        if (!waiter) await new Promise((r) => setTimeout(r, 100));
      }
      expect(waiter, "the checkout is waiting for the register lock");
      await db.query("select pg_terminate_backend($1)", [waiter.pid]); // the connection dies while the sale is in flight
      // a crash or a blocking dialog in main would leave this pending forever: fail instead of hanging the whole run
      const r = await Promise.race([inflight, new Promise((res) => setTimeout(() => res({ ok: false, err: "TIMEOUT: the interrupted checkout never answered (main process stuck or crashed)" }), 25000))]);
      expect(r.ok === false && /\[ERROR_INTERNO\]/.test(r.err) && !LEAKS.test(r.err), "the interrupted checkout fails cleanly: " + J(r));
    } finally {
      await locker.query("rollback").catch(() => {});
      await locker.end().catch(() => {});
    }
    expect((await one("select count(*)::int n from sales where operation_id=$1", [op])).n === 0 && (await one("select count(*)::int n from sales")).n === n0, "nothing was persisted by the interrupted attempt");
    expect((await stock(pB)) === b0, "stock untouched");
    let retry = null;
    for (let i = 0; i < 4 && !(retry && retry.ok); i++) retry = await create(payload(op, sid, cart));
    expect(retry.ok && retry.v.replayed === false, "the retry with the same operation id succeeds: " + J(retry));
    const again = await create(payload(op, sid, cart));
    expect(again.ok && again.v.id === retry.v.id && again.v.replayed === true, "and a further retry returns that same sale");
    const cnt = await counts(retry.v.id);
    expect(cnt.sales === n0 + 1 && cnt.cash === 1 && cnt.inv === 1, "exactly one sale and one set of movements: " + J(cnt));
    expect((await stock(pB)) === b0 - 3, "stock decreased once");
  });
  await test("SAF-11.the_register_closes_cleanly", "e2e", async () => {
    await ui.nav(page, "Caja");
    const expected = await ui.closeCash(page);
    const s = await one("select status, final_amount from cash_sessions order by id desc limit 1");
    expect(s.status === "closed" && num(s.final_amount) === num(expected), "closed: " + J(s));
  });
}
