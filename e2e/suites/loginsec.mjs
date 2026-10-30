// Login security suite (Sprint 06, block A1): simulated brute force against the PIN login. One installation-wide attempt counter
// (shared with the administrator authorization) that a success never gives back, that parallel bursts and several windows cannot
// beat, that survives restarting the application, that can never lock permanently, and that reveals nothing about users.
// Runs with small real limits (3 failures lock for 12 s, failures forgotten after 20 quiet seconds: longer than an app restart). Direct IPC for the contract of
// the main process; everything is verified in PostgreSQL and in the persisted counter file.
import fs from "node:fs";
import path from "node:path";
import { ipc, expect, sleep, launchApp } from "../lib/harness.mjs";

export const env = { POS_LOGIN_MAX_ATTEMPTS: "3", POS_LOGIN_LOCK_MS: "12000", POS_LOGIN_MAX_LOCK_MS: "12000", POS_LOGIN_RESET_MS: "20000" };

const J = JSON.stringify;
const LOCK_MS = 12000;
const RESET_MS = 20000;
const FILE = "auth-limiter.json";

export async function run(c) {
  const { db, data, test, artifacts } = c;
  const cur = { app: c.app, page: c.page };
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const call = (expr) => ipc(cur.page, expr);
  const login = async (pin) => {
    const r = await call(`api.auth.login(${J(pin)})`);
    if (!(r.ok && r.v && r.v.id)) lastFail = Date.now();
    return r;
  };
  let lastFail = 0;
  const quiet = async () => {
    const wait = lastFail + RESET_MS + 500 - Date.now();
    if (wait > 0) await sleep(wait);
  };
  const isLock = (r) => r.ok === false && /\[LOGIN_BLOQUEADO\]/.test(r.err);
  const isFail = (r) => r.ok === true && r.v === null;
  const stateFile = () => path.join(c.userData, FILE);
  const WRONG = (i) => String(30000000 + i * 7919); // 8 digits, never a real PIN

  const admin = await data.user("LS_ADMIN", "admin", { modern: true });
  const vendor = await data.user("LS_VENDOR", "vendor"); // legacy 4-digit SHA-256
  const inactive = await data.user("LS_INACTIVE", "vendor", { active: false });
  const legacyAdmin = await data.user("LS_LEGACY_ADMIN", "admin");

  /** closes the application and starts it again on the SAME user data folder (the real restart) */
  const restart = async (beforeStart) => {
    await cur.app.close().catch(() => {});
    await sleep(700);
    if (beforeStart) beforeStart();
    lastFail = Date.now(); // whatever state the new process starts with counts as recent
    const launched = await launchApp(c.runDb, db, artifacts, env, { userData: c.userData });
    cur.app = launched.app;
    cur.page = launched.page;
  };

  await test("LSEC-01.signing_in_between_guesses_recovers_no_attempts_and_each_lock_allows_one_guess", "security", async () => {
    expect((await login(vendor.pin)).v?.id === vendor.id, "the attacker has one valid PIN of their own");
    await quiet();
    let evaluated = 0;
    const guess = async (i) => { const r = await login(WRONG(i)); if (isFail(r)) evaluated++; return r; };
    await guess(1); await guess(2);
    expect((await login(vendor.pin)).v?.id === vendor.id, "own login in between (a success)");
    await guess(3);
    const refused = await login(vendor.pin);
    expect(isLock(refused), "locked after the third failure, the own login did not buy more guesses: " + J(refused));
    expect(evaluated === 3, "exactly 3 guesses were evaluated: " + evaluated);
    // the attacker keeps alternating "guess, own login" for several lock periods: one evaluated guess per period at most
    const perPeriod = [];
    for (let period = 0; period < 3; period++) {
      await sleep(LOCK_MS + 250);
      let n = 0;
      for (let k = 0; k < 4; k++) {
        const r = await login(WRONG(100 + period * 10 + k));
        if (isFail(r)) n++;
        await login(vendor.pin); // the own login that used to reset everything
      }
      perPeriod.push(n);
    }
    expect(perPeriod.every((n) => n <= 1), "at most one evaluated guess per lock period: " + J(perPeriod));
  });

  await test("LSEC-02.a_burst_of_parallel_logins_cannot_exceed_the_budget_and_the_right_PIN_gets_no_priority", "security", async () => {
    await quiet();
    const pins = Array.from({ length: 16 }, (_, i) => (i === 9 ? admin.pin : WRONG(200 + i)));
    const res = await call(`Promise.all(${J(pins)}.map((pin) => api.auth.login(pin).then((v) => (v ? 'OK' : 'FAIL'), (e) => (/LOGIN_BLOQUEADO/.test(e.message) ? 'LOCKED' : 'ERR:' + e.message))))`);
    lastFail = Date.now();
    expect(res.ok, J(res));
    const count = (k) => res.v.filter((x) => x === k).length;
    expect(count("FAIL") + count("OK") === 3 && count("LOCKED") === 13 && res.v.filter((x) => String(x).startsWith("ERR:")).length === 0, "only 3 of 16 parallel attempts were evaluated, the rest met the lock: " + J(res.v));
    expect(res.v[9] === "LOCKED", "the correct PIN was queued behind the budget: " + res.v[9]);
  });

  await test("LSEC-03.nothing_about_users_can_be_learned_from_failures_or_from_the_lock", "security", async () => {
    await quiet();
    const a = await login(WRONG(300)), b = await login(inactive.pin), d = await login("12");
    expect(isFail(a) && isFail(b) && isFail(d) && J(a) === J(b) && J(b) === J(d), "unknown, deactivated-user and malformed PINs fail identically: " + J([a, b, d]));
    // the lock answers the same text whether the PIN is real or not, and never names anybody
    const lockedReal = await login(admin.pin), lockedFake = await login(WRONG(301));
    const norm = (r) => r.err.replace(/Error invoking remote method '[^']+': /, "").replace(/\d+ s/, "N s");
    expect(isLock(lockedReal) && isLock(lockedFake) && norm(lockedReal) === norm(lockedFake), "a real and an unknown PIN meet the same lock message: " + J([lockedReal.err, lockedFake.err]));
    expect(!/admin|usuario|vendedor|PIN/i.test(norm(lockedReal).replace("Demasiados intentos fallidos", "")), "the message names nobody: " + norm(lockedReal));
  });

  await test("LSEC-04.restarting_the_application_does_not_give_the_attempts_back", "security", async () => {
    await quiet();
    for (let i = 0; i < 3; i++) expect(isFail(await login(WRONG(400 + i))), "failure " + (i + 1));
    expect(isLock(await login(admin.pin)), "locked before the restart");
    expect(fs.existsSync(stateFile()), "the counter was persisted");
    const saved = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    expect(J(Object.keys(saved).sort()) === J(["failures", "lastFailureAt", "lockedUntil"]) && saved.failures === 3, "three numbers, no PIN or user: " + J(saved));
    const raw = fs.readFileSync(stateFile(), "utf8");
    expect(![admin.pin, vendor.pin, WRONG(400), WRONG(401), WRONG(402)].some((p) => raw.includes(p)), "no PIN in the file");
    await restart();
    const afterRestart = await login(admin.pin);
    expect(isLock(afterRestart), "after killing and restarting the app the lock is still there: " + J(afterRestart));
    const stored = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    await sleep(Math.max(0, stored.lockedUntil - Date.now()) + 400);
    const ok = await login(admin.pin);
    expect(ok.ok && ok.v?.id === admin.id, "the lock ended by itself (never permanent): " + J(ok));
    expect(isFail(await login(WRONG(410))), "one more wrong guess");
    expect(isLock(await login(admin.pin)), "the failures survived the restart AND the success: the next failure locked again");
    lastFail = Date.now();
  });

  await test("LSEC-05.a_tampered_or_corrupt_counter_file_can_never_lock_the_installation_for_long", "security", async () => {
    await restart(() => fs.writeFileSync(stateFile(), J({ failures: 999999, lastFailureAt: 4e15, lockedUntil: 4e15 })));
    const first = await login(admin.pin);
    expect(isLock(first), "a stored lock is honored: " + J(first));
    const secs = Number((first.err.match(/Espera (\d+) s/) || [])[1]);
    expect(secs >= 1 && secs <= LOCK_MS / 1000, "but never longer than the maximum lock (" + secs + " s)");
    await sleep(LOCK_MS + 400);
    const ok = await login(admin.pin);
    expect(ok.ok && ok.v?.id === admin.id, "the tampered lock ended by itself: " + J(ok));
    for (const junk of ["", "{", "null", "[1,2]", '{"failures":"many"}']) {
      await restart(() => fs.writeFileSync(stateFile(), junk));
      const r = await login(admin.pin);
      expect(r.ok && r.v?.id === admin.id, `a corrupt file (${J(junk)}) means "no state": ` + J(r));
    }
    await restart(() => fs.rmSync(stateFile(), { force: true }));
    expect((await login(admin.pin)).v?.id === admin.id, "a missing file means a fresh counter");
  });

  await test("LSEC-06.legacy_and_modern_PINs_keep_working_and_a_failed_attempt_leaves_hashes_alone", "security", async () => {
    await quiet();
    const before = (await one("select pin_hash from users where id=$1", [legacyAdmin.id])).pin_hash;
    expect(/^[0-9a-f]{64}$/.test(before), "the fixture administrator starts with a legacy SHA-256 hash");
    expect(isFail(await login(WRONG(500))), "a wrong guess");
    expect((await one("select pin_hash from users where id=$1", [legacyAdmin.id])).pin_hash === before, "a failed attempt changes no hash");
    const r = await login(legacyAdmin.pin);
    expect(r.ok && r.v?.id === legacyAdmin.id && r.v.role === "admin", "the legacy PIN logs in: " + J(r));
    expect(/^scrypt\$/.test((await one("select pin_hash from users where id=$1", [legacyAdmin.id])).pin_hash), "and is upgraded to scrypt after the success");
    const m = await login(admin.pin);
    expect(m.ok && m.v?.id === admin.id, "the scrypt PIN logs in: " + J(m));
    expect(!J([r, m]).includes("pin"), "no PIN or hash in any response");
  });

  await test("LSEC-07.the_refund_authorization_uses_the_same_budget_after_a_restart", "security", async () => {
    await quiet();
    const s = await one("insert into sales(user_id,total,payment_method) values($1,'10.00','card') returning id", [vendor.id]);
    const p = await data.product("LS1", "10.00", 50);
    const it = await one("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,1,'10.00','10.00',$3,$4) returning id", [s.id, p.id, p.name, p.sku]);
    expect((await login(vendor.pin)).v?.id === vendor.id, "a seller is signed in");
    const body = (op) => ({ saleId: s.id, reason: "e2e", items: [{ saleItemId: it.id, quantity: 1 }], payment: { method: "card", confirmed: true }, operationId: op });
    const pay = (pin, op) => call(`api.returns.createWithRefund(${J(body(op))}, ${J(pin)})`);
    const kind = (r) => (r.ok === false ? (String(r.err).match(/\[(\w+)\]/) || [])[1] : "OK");
    expect(kind(await pay(WRONG(600), "op-ls-000001")) === "AUTORIZACION_INVALIDA" && kind(await pay(WRONG(601), "op-ls-000002")) === "AUTORIZACION_INVALIDA", "two wrong administrator PINs");
    await restart();
    expect((await login(vendor.pin)).v?.id === vendor.id, "after a restart the seller signs in again (a success)");
    expect(isFail(await login(WRONG(602))), "one failed login: that is the third failure of the shared budget");
    expect(kind(await pay(admin.pin, "op-ls-000003")) === "AUTORIZACION_BLOQUEADA", "the right administrator PIN is refused: failures from the login and from the authorization add up, across the restart");
    await sleep(LOCK_MS + 400);
    const ok = await pay(admin.pin, "op-ls-000003");
    expect(ok.ok && ok.v.refundStatus === "paid", "after the lock the authorization works: " + J(ok));
    expect((await one("select authorized_by, processed_by from refund_settlements where operation_id='op-ls-000003'")).authorized_by === admin.id, "audited with the administrator id");
    const log = (c.mainLog ?? []).join("\n");
    expect(!log.includes(admin.pin) && !log.includes(vendor.pin), "no PIN in the main log");
    // leave the application as the harness expects it: the relaunched instance is closed here, the harness closes the first one
    await cur.app.close().catch(() => {});
  });
}
