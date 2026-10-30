// Hardening suite: sanitized IPC errors, user administration (validation, unique PIN, logical delete, last
// administrator, serialized admin operations) and the login brute-force limiter. Runs the app with SMALL
// login limits (see `env`); the production defaults are covered by unit tests (login-limiter).
import path from "node:path";
import { ROOT, APP_URL, ui, ipc, expect, verifyModern, isModernHash, containsSecret, connectRunDb, waitFor, sleep } from "../lib/harness.mjs";

export const env = { POS_LOGIN_MAX_ATTEMPTS: "3", POS_LOGIN_LOCK_MS: "5000", POS_LOGIN_MAX_LOCK_MS: "5000" };
const LOCK_MS = 5000;
// Keep in sync with USER_ADMIN_LOCK_KEY in src/backend/users-service.ts (if they drift, the race test fails loudly)
const USER_ADMIN_LOCK_KEY = 7481201;
const LEAKS_SQL = /Failed query|params:|(select|insert into|update|delete from) .*(from|set|values) |\n\s+at /i;

async function openSecondWindow(app) {
  const preload = path.join(ROOT, "dist/preload/preload.cjs");
  const [pop] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(({ BrowserWindow }, a) => {
      const w = new BrowserWindow({ width: 900, height: 700, webPreferences: { preload: a.preload, contextIsolation: true, nodeIntegration: false } });
      w.loadURL(a.url);
    }, { preload, url: APP_URL + "/#/sales" }),
  ]);
  await pop.waitForLoadState("domcontentloaded");
  await waitFor(async () => pop.evaluate(() => !!window.api), 8000);
  return pop;
}

export async function run(c) {
  const { page, app, db, data, test, mainLog } = c;
  const J = JSON.stringify;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const call = (expr, p = page) => ipc(p, expr);
  const biz = (r, code) => r.ok === false && String(r.err).includes(`[${code}]`) && !LEAKS_SQL.test(String(r.err));
  const settled = (calls) => call(`Promise.allSettled([${calls.join(",")}]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))`);
  const admin = await data.user("ADMIN", "admin");
  const login = (pin, p = page) => call(`api.auth.login(${J(pin)})`, p);
  const closeAll = async () => { for (const r of await rows("select id from cash_sessions where closed_at is null")) await call(`api.cash.closeSession(${r.id},0)`); };
  /** waits out any lock and logs the admin in through the API (a success resets the limiter) */
  const recover = async () => {
    for (let i = 0; i < 12; i++) {
      const r = await login(admin.pin);
      if (r.ok && r.v && r.v.id === admin.id) return;
      await sleep(600);
    }
    throw new Error("could not recover the login");
  };
  const resetToLogin = async (p = page) => {
    await call("api.auth.logout()", p);
    await p.evaluate(() => sessionStorage.clear());
    await p.goto(APP_URL);
    await p.getByText("Ingresa tu PIN para comenzar").waitFor();
  };
  const hashOf = async (id) => (await one("select pin_hash from users where id=$1", [id])).pin_hash;
  const createUser = (name, role, pin) => call(`api.users.create(${J({ name, role, pin })})`);
  const updateUser = (id, body) => call(`api.users.update(${J(id)}, ${J(body)})`);
  const withTrigger = async (table, timing, fn, body, runIt) => {
    await db.query(`create or replace function ${fn}() returns trigger language plpgsql as $f$ begin ${body} end $f$`);
    await db.query(`create trigger ${fn}_t ${timing} on ${table} for each row execute function ${fn}()`);
    try { return await runIt(); } finally {
      await db.query(`drop trigger if exists ${fn}_t on ${table}`);
      await db.query(`drop function if exists ${fn}()`);
    }
  };

  await test("HARD-00.admin_visual_login", "e2e", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
  });

  // ================================================================== IPC error boundary
  await test("ERR-01.unexpected_failure_is_generic_for_the_renderer_and_redacted_in_the_main_log", "integration", async () => {
    await closeAll();
    const sid = (await call("api.cash.openSession(100)")).v.id;
    await withTrigger("cash_movements", "before insert", "e2e_err_cash", `if new.reason = 'e2e-err' then raise exception 'e2e injected failure pin_hash=abc123'; end if; return new;`, async () => {
      const before = (await one("select current_amount from cash_sessions where id=$1", [sid])).current_amount;
      const mark = mainLog.length;
      const r = await call(`api.cash.addMovement({sessionId:${sid},type:'OUT',amount:30,reason:'e2e-err'})`);
      expect(biz(r, "ERROR_INTERNO"), "public error is the stable generic one: " + J(r).slice(0, 220));
      expect(!/cash_movements|insert|injected|abc123|postgres/i.test(r.err), "no internals in the renderer error: " + r.err);
      expect((await one("select current_amount from cash_sessions where id=$1", [sid])).current_amount === before, "the failed operation rolled back");
      await sleep(500);
      const log = mainLog.slice(mark).join("\n");
      expect(/unexpected error in cash:addMovement/.test(log), "main logged the diagnostic: " + log.slice(0, 200));
      expect(/cash_movements/.test(log), "the diagnostic keeps the useful SQL object name");
      expect(!containsSecret(log) && !/abc123/.test(log) && !/params:\s*\S*\d/.test(log.replace(/params: <redacted>/g, "")), "the log is redacted (no credentials, no parameters, no secret-looking values)");
    });
    await closeAll();
  });
  await test("ERR-02.business_and_auth_errors_keep_their_codes_and_texts", "integration", async () => {
    const biz1 = await call("api.cash.addMovement({sessionId:987654321,type:'IN',amount:1,reason:'x'})");
    expect(biz(biz1, "CAJA_NO_ENCONTRADA"), J(biz1));
    await call("api.auth.logout()");
    const unauth = await call("api.products.getAll()");
    expect(unauth.ok === false && /Sesión no válida/.test(unauth.err) && !/\[ERROR_INTERNO\]/.test(unauth.err), "no session keeps 'Sesión no válida': " + J(unauth));
    await recover();
  });
  await test("ERR-03.public_auth_handlers_are_sanitized_too", "integration", async () => {
    await recover();
    await db.query("alter table users rename to users_e2e_tmp");
    try {
      const l = await login("4321");
      const m = await call("api.auth.me()");
      const p = await call("api.products.getAll()");
      for (const [label, r] of [["login", l], ["me", m], ["protected", p]]) {
        expect(biz(r, "ERROR_INTERNO") && !/users|select|relation|does not exist|no existe/i.test(r.err), `${label}: ${J(r).slice(0, 200)}`);
      }
    } finally { await db.query("alter table users_e2e_tmp rename to users"); }
    await recover();
  });

  // ================================================================== user administration
  await test("USR-01.valid_create_returns_only_public_fields_and_stores_a_hash", "integration", async () => {
    const pin = await data.newPin(6), pin2 = await data.newPin(8);
    const r = await createUser("  Ana Vendedora  ", "vendor", pin);
    expect(r.ok && J(Object.keys(r.v).sort()) === J(["id", "name", "role"]) && r.v.name === "Ana Vendedora" && r.v.role === "vendor", J(r));
    const row = await one("select * from users where id=$1", [r.v.id]);
    expect(row.active === true && isModernHash(row.pin_hash) && verifyModern(pin, row.pin_hash) && !row.pin_hash.includes(pin), "stored as a salted scrypt hash, active");
    const a2 = await createUser("Admin Dos", "admin", pin2);
    expect(a2.ok && a2.v.role === "admin", J(a2));
    const list = await call("api.users.getAll()");
    expect(list.ok && list.v.some((u) => u.id === r.v.id) && list.v.every((u) => !("pinHash" in u) && !("pin_hash" in u)), "listed without hashes");
  });
  await test("USR-02.invalid_input_is_rejected_without_trace", "integration", async () => {
    const before = (await one("select count(*)::int n from users")).n;
    const pin = await data.newPin(6);
    const cases = [
      ["PIN_INVALIDO", { name: "ok", role: "vendor", pin: "1234" }], ["PIN_INVALIDO", { name: "ok", role: "vendor", pin: "246810121" }],
      ["NOMBRE_INVALIDO", { name: "", role: "vendor", pin }], ["NOMBRE_INVALIDO", { name: "   ", role: "vendor", pin }], ["NOMBRE_INVALIDO", { name: "x".repeat(121), role: "vendor", pin }],
      ["NOMBRE_INVALIDO", { name: "a\u0000b", role: "vendor", pin }], ["NOMBRE_INVALIDO", { name: 5, role: "vendor", pin }],
      ["ROL_INVALIDO", { name: "ok", role: "superuser", pin }], ["ROL_INVALIDO", { name: "ok", role: null, pin }], ["ROL_INVALIDO", { name: "ok", role: "ADMIN", pin }],
      ["PIN_INVALIDO", { name: "ok", role: "vendor", pin: "123" }], ["PIN_INVALIDO", { name: "ok", role: "vendor", pin: "99999" }], ["PIN_INVALIDO", { name: "ok", role: "vendor", pin: "abcd" }],
      ["PIN_INVALIDO", { name: "ok", role: "vendor", pin: "12 4" }], ["PIN_INVALIDO", { name: "ok", role: "vendor", pin: 1234 }], ["PIN_INVALIDO", { name: "ok", role: "vendor", pin: null }], ["PIN_INVALIDO", { name: "ok", role: "vendor" }],
      ["CAMPO_NO_PERMITIDO", { name: "ok", role: "vendor", pin, active: false }], ["CAMPO_NO_PERMITIDO", { name: "ok", role: "vendor", pin, id: 1 }],
      ["CAMPO_NO_PERMITIDO", { name: "ok", role: "vendor", pin, pinHash: "x" }], ["CAMPO_NO_PERMITIDO", { name: "ok", role: "vendor", pin, isAdmin: true }],
    ];
    for (const [code, body] of cases) { const r = await call(`api.users.create(${J(body)})`); expect(biz(r, code), `${J(body).slice(0, 70)} -> ${J(r).slice(0, 150)}`); }
    expect(biz(await call("api.users.create(null)"), "USUARIO_INVALIDO"), "null payload");
    expect(biz(await call("api.users.create([1])"), "USUARIO_INVALIDO"), "array payload");
    expect((await one("select count(*)::int n from users")).n === before, "nothing was created");
  });
  await test("USR-03.pin_duplicates_are_rejected_also_under_concurrency", "integration", async () => {
    const p = await data.newPin(6), q = await data.newPin(7);
    const a = await createUser("Dup A", "vendor", p), b = await createUser("Dup B", "vendor", q);
    expect(a.ok && b.ok, "setup");
    const dup = await createUser("Dup C", "vendor", p);
    expect(biz(dup, "PIN_EN_USO") && !/Dup A|\bid\b/.test(dup.err), "creating with a used PIN: " + J(dup));
    const hb = await hashOf(b.v.id);
    expect(biz(await updateUser(b.v.id, { name: "Dup B", role: "vendor", pin: p }), "PIN_EN_USO"), "updating to a used PIN");
    expect((await hashOf(b.v.id)) === hb, "B keeps its PIN");
    expect((await updateUser(a.v.id, { name: "Dup A", role: "vendor", pin: p })).ok, "keeping your own PIN is fine");
    expect((await call(`api.users.delete(${a.v.id})`)).ok, "deactivate A");
    expect(biz(await createUser("Dup D", "vendor", p), "PIN_EN_USO"), "a deactivated user's PIN stays reserved (reactivation can never create a duplicate)");
    const fresh = await data.newPin(8);
    const r = await settled(Array.from({ length: 4 }, (_, i) => `api.users.create(${J({ name: "Race " + i, role: "vendor", pin: fresh })})`));
    expect(r.ok && r.v.filter((x) => x.ok).length === 1 && r.v.filter((x) => !x.ok).every((x) => x.err.includes("[PIN_EN_USO]")), "4 concurrent creations, one PIN: " + J(r.v));
    expect(r.v.filter((x) => x.ok).length === 1, "exactly one account was created for the PIN (salted hashes: the unique index alone could not tell)");
  });
  await test("USR-04.update_changes_only_allowed_fields_and_keeps_the_pin_when_omitted", "integration", async () => {
    const pin = await data.newPin(6);
    const u = await createUser("Upd", "vendor", pin);
    const h0 = await hashOf(u.v.id);
    const r1 = await updateUser(u.v.id, { name: "Upd Renamed", role: "admin" });
    expect(r1.ok && r1.v.name === "Upd Renamed" && r1.v.role === "admin" && (await hashOf(u.v.id)) === h0, "no pin sent: hash unchanged " + J(r1));
    const np = await data.newPin(7);
    expect((await updateUser(u.v.id, { name: "Upd Renamed", role: "vendor", pin: np })).ok && verifyModern(np, await hashOf(u.v.id)), "new PIN stored as a salted hash");
    expect(biz(await updateUser(u.v.id, { name: "x", role: "vendor", active: false }), "CAMPO_NO_PERMITIDO"), "active cannot be set through update");
    expect(biz(await updateUser(u.v.id, { role: "vendor" }), "NOMBRE_INVALIDO"), "name required");
    expect(biz(await updateUser(u.v.id, { name: "x" }), "ROL_INVALIDO"), "role required");
    expect(biz(await updateUser(u.v.id, { name: "x", role: "vendor", pin: "99" }), "PIN_INVALIDO"), "pin format");
    expect(biz(await updateUser(987654321, { name: "x", role: "vendor" }), "USUARIO_NO_ENCONTRADO"), "nonexistent");
    expect(biz(await updateUser("5", { name: "x", role: "vendor" }), "USUARIO_INVALIDO"), "id type");
    expect((await one("select active from users where id=$1", [u.v.id])).active === true, "still active");
  });
  await test("USR-05.delete_is_a_logical_deactivation_that_preserves_history", "integration", async () => {
    const u = await data.user("DEL", "vendor");
    const p = await data.product("USRDEL", "5.00", 3);
    await db.query("insert into inventory_movements(product_id,user_id,type,amount,reason) values($1,$2,'IN',1,'history of the user')", [p.id, u.id]);
    const r = await call(`api.users.delete(${u.id})`);
    expect(r.ok && r.v === true, J(r));
    const row = await one("select name, active from users where id=$1", [u.id]);
    expect(row && row.active === false && row.name === u.name, "the row is kept, deactivated: " + J(row));
    expect((await one("select count(*)::int n from inventory_movements where user_id=$1", [u.id])).n === 1, "history intact and still attributable");
    const list = await call("api.users.getAll()");
    expect(list.ok && !list.v.some((x) => x.id === u.id), "no longer listed");
    const l = await login(u.pin);
    expect(l.ok && l.v === null, "a deactivated user cannot log in");
    await recover();
    expect(biz(await call(`api.users.delete(${u.id})`), "USUARIO_YA_INACTIVO"), "second delete");
    expect(biz(await call("api.users.delete(987654321)"), "USUARIO_NO_ENCONTRADO"), "nonexistent");
    expect(biz(await call(`api.users.delete(${admin.id})`), "AUTOELIMINACION"), "cannot delete yourself");
    for (const id of ["'5'", "0", "1.5", "null"]) expect(biz(await call(`api.users.delete(${id})`), "USUARIO_INVALIDO"), "id " + id);
    expect((await one("select active from users where id=$1", [admin.id])).active === true, "admin untouched");
  });

  // ================================================================== login limiter
  await test("LOG-01.login_screen_has_no_pin_hint", "e2e", async () => {
    await resetToLogin();
    const t = await page.evaluate(() => document.body.innerText);
    expect(!/0000|seed:admin|PIN Administrador|PIN por defecto/i.test(t), "no default PIN or seeding hint on the login screen: " + t.replace(/\s+/g, " ").slice(0, 160));
  });
  await test("LOG-02.failures_are_generic_for_every_cause", "security", async () => {
    await recover();
    const inactive = await data.user("INACT", "vendor", { active: false });
    const unknown = await data.newPin();
    const a = await login(unknown), b = await login(inactive.pin);
    expect(a.ok && a.v === null && b.ok && b.v === null && J(a) === J(b), "unknown PIN and a deactivated user's PIN look exactly the same: " + J([a, b]));
    await recover();
    const c1 = await call("api.auth.login(1234)"), c2 = await call("api.auth.login(null)");
    expect(c1.ok && c1.v === null && c2.ok && c2.v === null, "non-string input is just a failure");
    await recover();
    await resetToLogin();
    await ui.login(page, unknown);
    await page.getByText("PIN incorrecto").waitFor({ timeout: 5000 });
    await recover();
  });
  await test("LOG-03.lock_after_repeated_failures_refuses_even_the_right_pin", "security", async () => {
    await recover();
    for (let i = 0; i < 3; i++) expect((await login(await data.newPin())).v === null, "failure " + (i + 1));
    const r = await login(admin.pin);
    expect(biz(r, "LOGIN_BLOQUEADO") && /Espera \d+ s/.test(r.err), "locked, even for the correct PIN: " + J(r));
    expect((await call("api.auth.me()")).v !== undefined, "me() is not affected by the lock");
    const again = await login(await data.newPin());
    expect(biz(again, "LOGIN_BLOQUEADO"), "still locked: " + J(again));
    // the screen explains it without revealing anything about users
    await resetToLogin();
    await ui.login(page, admin.pin);
    await page.getByText(/Demasiados intentos/).first().waitFor({ timeout: 4000 });
    expect(!(await page.evaluate(() => sessionStorage.getItem("user"))), "no session was created while locked");
  });
  await test("LOG-04.the_lock_cannot_be_dodged_with_another_window", "security", async () => {
    await sleep(LOCK_MS + 300);
    await recover();
    const w2 = await openSecondWindow(app);
    try {
      expect((await login(await data.newPin())).v === null && (await login(await data.newPin())).v === null, "two failures in window 1");
      expect((await login(await data.newPin(), w2)).v === null, "the third failure comes from window 2 and counts for everyone");
      expect(biz(await login(admin.pin, w2), "LOGIN_BLOQUEADO"), "window 2 is locked");
      expect(biz(await login(admin.pin), "LOGIN_BLOQUEADO"), "window 1 is locked too");
    } finally { await w2.close().catch(() => {}); }
  });
  await test("LOG-05.login_recovers_after_the_lock_and_a_success_resets_the_counter", "security", async () => {
    await sleep(LOCK_MS + 300);
    const ok = await login(admin.pin);
    expect(ok.ok && ok.v && ok.v.id === admin.id, "the correct PIN works again after the lock period: " + J(ok));
    expect((await login(await data.newPin())).v === null && (await login(await data.newPin())).v === null, "two failures");
    expect((await login(admin.pin)).v?.id === admin.id, "a success resets the counter");
    expect((await login(await data.newPin())).v === null && (await login(await data.newPin())).v === null, "two more failures are not a lock");
    expect((await login(admin.pin)).v?.id === admin.id, "and the PIN still works");
  });

  // ================================================================== last administrator (changes the session user: keep last)
  await test("USR-06.the_last_active_administrator_cannot_be_removed", "integration", async () => {
    await recover();
    await db.query("update users set active=false where role='admin' and id <> $1", [admin.id]);
    const b = await data.user("ADMIN_B", "admin");
    // two admins: B can be demoted, then A is the last one
    expect((await updateUser(b.id, { name: b.name, role: "vendor" })).ok, "demoting B while A remains is fine");
    const self = await updateUser(admin.id, { name: admin.name, role: "vendor" });
    expect(biz(self, "ULTIMO_ADMIN"), "A is the last administrator: " + J(self));
    expect((await one("select role from users where id=$1", [admin.id])).role === "admin", "A is still admin");
    await db.query("update users set role='admin' where id=$1", [b.id]);
    expect((await call(`api.users.delete(${b.id})`)).ok, "deactivating B while A remains is fine");
    expect((await one("select count(*)::int n from users where role='admin' and active")).n === 1, "exactly one active admin left");
    expect(biz(await call(`api.users.delete(${admin.id})`), "AUTOELIMINACION"), "and A cannot delete itself");
  });
  await test("USR-07.admin_operations_are_serialized_so_a_race_cannot_remove_every_admin", "integration", async () => {
    await recover();
    await db.query("update users set active=false where role='admin' and id <> $1", [admin.id]);
    const b = await data.user("ADMIN_C", "admin");
    const holder = await connectRunDb(c.runDb);
    try {
      await holder.query("select pg_advisory_lock($1)", [USER_ADMIN_LOCK_KEY]);
      const demoteA = `api.users.update(${admin.id}, ${J({ name: admin.name, role: "vendor" })})`;
      const demoteB = `api.users.update(${b.id}, ${J({ name: b.name, role: "vendor" })})`;
      const pending = [call(demoteA), call(demoteB)];
      const queued = await waitFor(async () => (await one("select count(*)::int n from pg_stat_activity where application_name='e2e_app' and wait_event_type='Lock'")).n >= 2, 8000);
      await holder.query("select pg_advisory_unlock($1)", [USER_ADMIN_LOCK_KEY]);
      const res = (await Promise.all(pending)).map((x) => ({ ok: x.ok, err: x.err }));
      expect(queued, "both operations queued on the admin lock (a real race)");
      expect(res.filter((x) => x.ok).length === 1 && res.find((x) => !x.ok).err.includes("[ULTIMO_ADMIN]"), "exactly one demotion wins, the other is refused: " + J(res));
      expect((await one("select count(*)::int n from users where role='admin' and active")).n === 1, "one active administrator remains");
    } finally { await holder.end().catch(() => {}); }
    await db.query("update users set role='admin' where id=$1", [admin.id]);
  });

  await ui.logout(page).catch(() => {});
}
