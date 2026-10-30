// Refund authorization suite (Sprint 05 block A, updated in Sprint 06): the administrator PIN is protected against brute force by
// the SAME installation-wide counter as the login. Runs with a small real attempt limit (3 failures lock for 4 s; failures are
// forgotten after 8 quiet seconds) so lock and recovery can be observed. Direct IPC for the contract of the main process; the
// sign-ins go through the real screen. Everything is verified in PostgreSQL.
import { APP_URL, ui, ipc, expect, closeStrayCash, sleep } from "../lib/harness.mjs";
import crypto from "node:crypto";

export const env = { POS_LOGIN_MAX_ATTEMPTS: "3", POS_LOGIN_LOCK_MS: "4000", POS_LOGIN_MAX_LOCK_MS: "4000", POS_LOGIN_RESET_MS: "8000" };

const J = JSON.stringify;
const LOCK_MS = 4000;
const RESET_MS = 8000;

export async function run(c) {
  const { page, db, data, test } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const call = (expr) => ipc(page, expr);
  const code = (r) => (r.ok === false ? (String(r.err).match(/\[(\w+)\]/) || [])[1] ?? String(r.err).slice(0, 80) : "OK");
  const newOp = () => "op-" + crypto.randomBytes(8).toString("hex");

  const admin = await data.user("AU_ADMIN", "admin", { modern: true });
  const vendor = await data.user("AU_VENDOR", "vendor");
  const vendor2 = await data.user("AU_VENDOR2", "vendor");
  await closeStrayCash(db, admin.id);
  const prod = await data.product("AU1", "10.00", 500);

  let lastFail = 0; // the counter is forgotten only after a quiet period: track the last failed or refused attempt
  const loginAs = async (u) => {
    await ipc(page, "api.auth.logout()");
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, u.pin);
    await page.waitForURL(u.role === "admin" ? /#\/dashboard$/ : /#\/sales$/, { timeout: 8000 });
  };
  const mkSale = async () => {
    const s = await one("insert into sales(user_id,total,payment_method) values($1,'10.00','card') returning id", [vendor.id]);
    const it = await one("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,1,'10.00','10.00',$3,$4) returning id", [s.id, prod.id, prod.name, prod.sku]);
    return { id: s.id, itemId: it.id };
  };
  const payload = (sale) => ({ saleId: sale.id, reason: "e2e", items: [{ saleItemId: sale.itemId, quantity: 1 }], payment: { method: "card", confirmed: true }, operationId: newOp() });
  const pay = async (sale, pin) => {
    const r = await call(`api.returns.createWithRefund(${J(payload(sale))}, ${J(pin)})`);
    if (code(r) === "AUTORIZACION_INVALIDA" || code(r) === "AUTORIZACION_BLOQUEADA") lastFail = Date.now();
    return r;
  };
  const login = async (pin) => {
    const r = await call(`api.auth.login(${J(pin)})`);
    if (!(r.ok && r.v && r.v.id)) lastFail = Date.now();
    return r;
  };
  const settlements = async () => (await one("select count(*)::int n from refund_settlements")).n;
  /** waits until the lock is over (a correct PIN gets through again), returning that successful result */
  const recover = async (sale) => {
    for (let i = 0; i < 30; i++) {
      const r = await pay(sale, admin.pin);
      if (code(r) !== "AUTORIZACION_BLOQUEADA") return r;
      await sleep(400);
    }
    throw new Error("the lock never ended");
  };
  /** waits for the quiet period that forgets failures */
  const quiet = async () => {
    const wait = lastFail + RESET_MS + 500 - Date.now();
    if (wait > 0) await sleep(wait);
  };

  await test("AUT-00.setup_a_vendor_operates", "e2e", async () => {
    await loginAs(vendor);
    const me = await call("api.auth.me()");
    expect(me.ok && me.v.id === vendor.id, J(me));
  });

  await test("AUT-01.three_failures_lock_the_authorization_and_even_the_right_PIN_is_refused", "security", async () => {
    const sale = await mkSale();
    const n0 = await settlements();
    for (let i = 0; i < 3; i++) expect(code(await pay(sale, "73910462")) === "AUTORIZACION_INVALIDA", "wrong PIN #" + (i + 1));
    const locked = await pay(sale, admin.pin);
    expect(code(locked) === "AUTORIZACION_BLOQUEADA" && /Espera \d+ s/.test(locked.err), "the correct PIN is refused while locked: " + J(locked));
    expect(!/admin|usuario|vendedor/i.test(locked.err.replace("Error invoking remote method", "")), "the lock message names nobody: " + locked.err);
    expect((await settlements()) === n0, "nothing was written");
    c.lockedSale = sale;
  });

  await test("AUT-02.the_lock_ends_by_itself_but_the_success_does_not_give_the_attempts_back", "security", async () => {
    const sale = c.lockedSale;
    const started = Date.now();
    const ok = await recover(sale);
    expect(ok.ok && ok.v.refundStatus === "paid", "recovered: " + J(ok));
    expect(Date.now() - started < LOCK_MS * 3, "the lock is temporary");
    // the failures are still counted: one more locks again at once, although a success happened in between
    const s2 = await mkSale();
    expect(code(await pay(s2, "73910462")) === "AUTORIZACION_INVALIDA", "one more wrong guess");
    expect(code(await pay(s2, admin.pin)) === "AUTORIZACION_BLOQUEADA", "locked again: the success gave nothing back");
    // only a quiet period forgets them
    await quiet();
    for (let i = 0; i < 2; i++) expect(code(await pay(s2, "73910462")) === "AUTORIZACION_INVALIDA", "failure #" + (i + 1) + " after the quiet period is not a lock");
    const good = await pay(s2, admin.pin);
    expect(good.ok, "and the right PIN works: " + J(good));
  });

  await test("AUT-03.a_burst_of_parallel_guesses_cannot_get_more_than_the_allowed_attempts", "security", async () => {
    await quiet();
    const sale = await mkSale();
    const guesses = Array.from({ length: 12 }, (_, i) => String(10000000 + i * 7919));
    const res = await call(`Promise.all(${J(guesses)}.map((pin) => api.returns.createWithRefund(${J(payload(sale))}, pin).then(() => 'OK', (e) => (String(e.message).match(/\\[(\\w+)\\]/) || [])[1])))`);
    lastFail = Date.now();
    expect(res.ok, J(res));
    const invalid = res.v.filter((x) => x === "AUTORIZACION_INVALIDA").length, locked = res.v.filter((x) => x === "AUTORIZACION_BLOQUEADA").length;
    expect(invalid === 3 && locked === 9, `only 3 of 12 parallel guesses were evaluated: ${J(res.v)}`);
    c.burstSale = sale;
  });

  await test("AUT-04.a_successful_login_does_not_reset_the_budget_for_guessing_the_administrator_PIN", "security", async () => {
    await quiet();
    const sale = await mkSale();
    expect(code(await pay(sale, "73910462")) === "AUTORIZACION_INVALIDA", "guess 1");
    expect(code(await pay(sale, "73910463")) === "AUTORIZACION_INVALIDA", "guess 2");
    // the seller signs in with their own PIN (a success) between guesses
    const login1 = await login(vendor.pin);
    expect(login1.ok && login1.v && login1.v.id === vendor.id, "own login works: " + J(login1));
    expect(code(await pay(sale, "73910464")) === "AUTORIZACION_INVALIDA", "guess 3");
    const locked = await pay(sale, admin.pin);
    expect(code(locked) === "AUTORIZACION_BLOQUEADA", "the login in between did not give the guesses back: " + J(locked));
    c.alternateSale = sale;
  });

  await test("AUT-05.the_budget_is_shared_with_the_login_and_belongs_to_the_installation", "security", async () => {
    // still locked from AUT-04: signing in is refused too (one budget for every PIN check), with the same generic message
    const refused = await login(vendor2.pin);
    expect(refused.ok === false && /\[LOGIN_BLOQUEADO\]/.test(refused.err) && /Espera \d+ s/.test(refused.err), "the login meets the same lock: " + J(refused));
    expect(!/admin|usuario|vendedor/i.test(refused.err.replace("Error invoking remote method", "")), "and says nothing about users");
    // failed LOGIN attempts count against the authorization too
    await quiet();
    expect((await login("73910462")).v === null && (await login("73910463")).v === null && (await login("73910464")).v === null, "three failed logins");
    const locked = await pay(c.alternateSale, admin.pin);
    expect(code(locked) === "AUTORIZACION_BLOQUEADA", "the administrator authorization is locked by failed logins: " + J(locked));
    await sleep(LOCK_MS + 300);
    await loginAs(vendor2); // the lock ended by itself: a different seller signs in through the real screen
    const ok = await recover(c.alternateSale);
    expect(ok.ok, "and the authorization works for the new session: " + J(ok));
    expect((await one("select processed_by from refund_settlements order by id desc limit 1")).processed_by === vendor2.id, "the operator on record is the one signed in");
  });

  await test("AUT-06.invalid_pin_attempts_are_audited_without_the_pin_in_the_main_log", "security", async () => {
    const log = c.mainLog.join("\n");
    expect(/administrator authorization rejected \(operator=\d+\)/.test(log), "rejections are logged with the operator id");
    expect(!log.includes("73910462") && !log.includes(admin.pin), "but never with a PIN");
  });
}
