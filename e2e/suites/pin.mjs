// PIN suite: salted scrypt PINs, transparent upgrade of legacy SHA-256 accounts, logical PIN uniqueness across
// different salts (also under concurrency), inactive users, the global limiter with both formats, no PIN/hash in
// results or logs, the administrator seed script, and the users screen (visual).
// Fixtures: LEGACY users (4-digit PIN, unsalted SHA-256) prove compatibility; MODERN users (6-8 digits, scrypt).
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, APP_URL, ui, ipc, expect, sha256, hashModern, verifyModern, isModernHash, containsSecret, urlFor, sleep } from "../lib/harness.mjs";

export const env = { POS_LOGIN_MAX_ATTEMPTS: "3", POS_LOGIN_LOCK_MS: "4000", POS_LOGIN_MAX_LOCK_MS: "4000" };
const LOCK_MS = 4000;
const LEAKS = /Failed query|params:|\n\s+at |scrypt\$/i;

export async function run(c) {
  const { page, db, data, test, mainLog } = c;
  const J = JSON.stringify;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const call = (expr, p = page) => ipc(p, expr);
  const biz = (r, code) => r.ok === false && String(r.err).includes(`[${code}]`) && !LEAKS.test(String(r.err));
  const settled = (calls) => call(`Promise.allSettled([${calls.join(",")}]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', err: x.reason && x.reason.message })))`);
  const admin = await data.user("ADMIN", "admin", { modern: true });
  const login = (pin) => call(`api.auth.login(${J(pin)})`);
  const hashOf = async (id) => (await one("select pin_hash from users where id=$1", [id])).pin_hash;
  const createUser = (name, role, pin) => call(`api.users.create(${J({ name, role, pin })})`);
  const recover = async () => {
    for (let i = 0; i < 14; i++) {
      const r = await login(admin.pin);
      if (r.ok && r.v && r.v.id === admin.id) return;
      await sleep(600);
    }
    throw new Error("could not recover the login");
  };
  const resetToLogin = async () => {
    await call("api.auth.logout()");
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
  };
  const usedPins = [admin.pin];
  const mark = mainLog.length;

  await test("PIN-00.modern_admin_logs_in_through_the_real_screen", "e2e", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    expect(isModernHash(await hashOf(admin.id)), "the fixture really is scrypt-hashed");
  });

  // ================================================================== legacy compatibility and upgrade
  await test("PIN-01.legacy_4_digit_login_works_and_the_hash_is_upgraded", "security", async () => {
    const u = await data.user("LEGACY1", "vendor"); // 4 digits, SHA-256
    usedPins.push(u.pin);
    const before = await hashOf(u.id);
    expect(/^[0-9a-f]{64}$/.test(before) && before === sha256(u.pin), "precondition: unsalted SHA-256");
    const r = await login(u.pin);
    expect(r.ok && r.v && r.v.id === u.id && J(Object.keys(r.v).sort()) === J(["id", "name", "role"]), "legacy login succeeds, only public fields: " + J(r));
    const after = await hashOf(u.id);
    expect(isModernHash(after) && verifyModern(u.pin, after) && after !== before, "upgraded to a salted scrypt hash in place");
    expect(!after.includes(u.pin), "no PIN in the stored value");
    const again = await login(u.pin);
    expect(again.ok && again.v && again.v.id === u.id, "the next login uses the modern hash");
    expect((await hashOf(u.id)) === after, "a modern hash is not rewritten on every login");
    expect((await login(u.pin + "0")).v === null, "the legacy PIN with a digit added is wrong");
    await recover();
  });
  await test("PIN-02.legacy_account_upgrades_through_the_visual_login_too", "e2e", async () => {
    const u = await data.user("LEGACY2", "vendor");
    usedPins.push(u.pin);
    await resetToLogin();
    await ui.login(page, u.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    expect(isModernHash(await hashOf(u.id)), "upgraded after the real login");
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, u.pin); // and the upgraded account keeps working
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    await ui.logout(page);
  });
  await test("PIN-03.modern_pins_of_6_7_and_8_digits_log_in_and_wrong_ones_do_not", "security", async () => {
    await recover();
    const made = [];
    for (let i = 0; i < 6 && made.length < 3; i++) {
      const m = await data.user("MOD" + i, "vendor", { modern: true });
      if (!made.some((x) => x.pin.length === m.pin.length)) made.push(m); // one per length when possible
      usedPins.push(m.pin);
    }
    for (const m of made) {
      const r = await login(m.pin);
      expect(r.ok && r.v && r.v.id === m.id, `modern ${m.pin.length}-digit PIN logs in: ${J(r)}`);
      expect((await hashOf(m.id)).startsWith("scrypt$"), "stays scrypt");
    }
    await recover();
    const wrong = await login(String(Number(made[0].pin) + 1).padStart(made[0].pin.length, "0"));
    expect(wrong.ok && wrong.v === null, "wrong PIN: null " + J(wrong));
    await recover();
    expect((await login(made[0].pin.slice(0, 4))).v === null, "a prefix of a modern PIN is not the PIN");
    await recover();
  });
  await test("PIN-04.created_users_get_6_to_8_digit_pins_with_distinct_salts_and_can_log_in", "security", async () => {
    await recover();
    const pins = [await data.newPin(6), await data.newPin(7), await data.newPin(8)];
    usedPins.push(...pins);
    const ids = [];
    for (const [i, pin] of pins.entries()) { const r = await createUser("Nuevo " + i, "vendor", pin); expect(r.ok, J(r)); ids.push(r.v.id); }
    const hashes = await Promise.all(ids.map(hashOf));
    expect(hashes.every(isModernHash), "stored as scrypt");
    expect(new Set(hashes.map((h) => h.split("$")[4])).size === 3, "a different random salt per user");
    for (const [i, pin] of pins.entries()) { const r = await login(pin); expect(r.ok && r.v && r.v.id === ids[i], `created user ${i} logs in with the ${pin.length}-digit PIN`); }
    await recover(); // the logins above made a vendor the session user
    for (const bad of ["1234", "24681", "246810121", "abcdef"]) { const r = await createUser("Mal", "vendor", bad); expect(biz(r, "PIN_INVALIDO"), "new PIN " + bad + " -> " + J(r).slice(0, 200)); }
    await recover();
  });

  // ================================================================== logical uniqueness across salts
  await test("PIN-05.duplicate_pins_are_detected_although_salts_make_every_hash_different", "security", async () => {
    await recover();
    const a = await data.user("DUPA", "vendor", { modern: true });
    usedPins.push(a.pin);
    const dup = await createUser("Dup copia", "vendor", a.pin);
    expect(biz(dup, "PIN_EN_USO") && !dup.err.includes(a.name), "creation with a used PIN is refused without naming its owner: " + J(dup));
    const b = await createUser("Dup B", "vendor", await data.newPin(7));
    expect(b.ok, J(b));
    const hb = await hashOf(b.v.id);
    expect(biz(await call(`api.users.update(${b.v.id}, ${J({ name: "Dup B", role: "vendor", pin: a.pin })})`), "PIN_EN_USO"), "changing to a used PIN is refused");
    expect((await hashOf(b.v.id)) === hb, "B keeps its PIN");
    expect((await call(`api.users.update(${a.id}, ${J({ name: a.name, role: "vendor", pin: a.pin })})`)).ok, "re-saving your own PIN is fine");
    // the database alone could not do this: two different salts are accepted by the unique index
    const clone = await db.query("insert into users(name,pin_hash,role) values($1,$2,'vendor') returning id", ["E2E dup clone", hashModern(a.pin)]);
    expect(clone.rowCount === 1, "the unique pin_hash index does NOT stop a same-PIN row with a different salt (so it is not relied upon)");
    const ambiguous = await login(a.pin);
    expect(ambiguous.ok && ambiguous.v === null, "if such a duplicate ever existed, login refuses it instead of picking a user: " + J(ambiguous));
    await db.query("delete from users where id=$1", [clone.rows[0].id]);
    await recover();
  });
  await test("PIN-06.inactive_accounts_keep_their_pin_reserved_and_cannot_log_in", "security", async () => {
    await recover();
    const m = await data.user("INACTM", "vendor", { modern: true, active: false });
    const l = await data.user("INACTL", "vendor", { active: false });
    usedPins.push(m.pin, l.pin);
    expect(biz(await createUser("Reusa modern", "vendor", m.pin), "PIN_EN_USO"), "an inactive account's PIN stays reserved");
    expect((await login(m.pin)).v === null && (await login(l.pin)).v === null, "neither inactive account can log in (same generic null)");
    await recover();
  });
  await test("PIN-07.concurrent_creations_of_the_same_pin_produce_one_account", "security", async () => {
    await recover();
    const pin = await data.newPin(7);
    usedPins.push(pin);
    const r = await settled(Array.from({ length: 5 }, (_, i) => `api.users.create(${J({ name: "Carrera " + i, role: "vendor", pin })})`));
    expect(r.ok && r.v.filter((x) => x.ok).length === 1 && r.v.filter((x) => !x.ok).every((x) => x.err.includes("[PIN_EN_USO]")), "5 concurrent creations: " + J(r.v));
    const holders = (await rows("select pin_hash from users where name like 'Carrera %'")).filter((x) => verifyModern(pin, x.pin_hash));
    expect(holders.length === 1, "exactly one account holds the PIN");
    await recover();
  });

  // ================================================================== limiter with both formats
  await test("PIN-08.global_limiter_covers_legacy_and_modern_accounts_and_recovers", "security", async () => {
    await recover();
    const legacy = await data.user("LIML", "vendor");
    usedPins.push(legacy.pin);
    for (let i = 0; i < 3; i++) expect((await login(await data.newPin(i % 2 ? 4 : 7))).v === null, "failure " + (i + 1));
    for (const [label, pin] of [["modern", admin.pin], ["legacy", legacy.pin]]) {
      const r = await login(pin);
      expect(biz(r, "LOGIN_BLOQUEADO") && /Espera \d+ s/.test(r.err), `${label} PIN refused while locked: ${J(r)}`);
    }
    await sleep(LOCK_MS + 400);
    const ok = await login(legacy.pin);
    expect(ok.ok && ok.v && ok.v.id === legacy.id, "login recovers after the lock period: " + J(ok));
    await recover();
  });

  // ================================================================== nothing sensitive leaves the main process
  await test("PIN-09.no_pin_hash_or_salt_reaches_the_renderer_or_the_main_log", "security", async () => {
    await recover();
    const pin = await data.newPin(8);
    usedPins.push(pin);
    const created = await createUser("Sin fugas", "vendor", pin);
    const list = await call("api.users.getAll()");
    const upd = await call(`api.users.update(${created.v.id}, ${J({ name: "Sin fugas 2", role: "vendor", pin: await data.newPin(6) })})`);
    const lg = await login(pin);
    for (const [label, r] of [["create", created], ["getAll", list], ["update", upd], ["login", lg]]) {
      const text = J(r);
      expect(!/scrypt\$|pin_hash|pinHash|"salt"/.test(text), `${label} result carries no hash/salt: ${text.slice(0, 120)}`);
      expect(!text.includes(pin), `${label} result does not echo the PIN`);
    }
    // an UNEXPECTED failure while creating a user: its log entry must be redacted too
    await db.query(`create or replace function e2e_fail_user() returns trigger language plpgsql as $f$ begin if new.name = 'E2E boom' then raise exception 'e2e injected failure'; end if; return new; end $f$`);
    await db.query("create trigger e2e_fail_user_t before insert on users for each row execute function e2e_fail_user()");
    try {
      const boom = await createUser("E2E boom", "vendor", await data.newPin(8));
      expect(biz(boom, "ERROR_INTERNO"), J(boom));
    } finally {
      await db.query("drop trigger if exists e2e_fail_user_t on users");
      await db.query("drop function if exists e2e_fail_user()");
    }
    await sleep(500);
    const log = mainLog.slice(mark).join("\n");
    expect(/unexpected error in users:create/.test(log), "the failure was logged in main");
    expect(!/scrypt\$/i.test(log) && !containsSecret(log), "no hash/salt/credentials in the main log (column names are fine, values are not)");
    expect(/params: <redacted>/.test(log), "the query parameters (which held the hash) were redacted");
    for (const p of usedPins.filter((x) => x.length >= 6)) expect(!new RegExp(`(^|\\D)${p}(\\D|$)`).test(log.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "")), "a PIN used in this suite appears in the main log");
    await recover();
  });

  // ================================================================== seed script
  await test("PIN-10.seed_creates_a_modern_admin_without_a_default_or_a_printed_pin", "security", async () => {
    const pin = await data.newPin(7);
    usedPins.push(pin);
    const before = (await one("select count(*)::int n from users")).n;
    const run1 = (extra) => {
      const e = { ...process.env };
      delete e.ADMIN_PIN;
      delete e.ADMIN_NAME;
      Object.assign(e, { DATABASE_URL: urlFor(c.runDb, "e2e_seed") }, extra); // only ever the throwaway database
      return spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts/seed-admin.mjs")], { cwd: ROOT, encoding: "utf8", env: e });
    };
    expect(urlFor(c.runDb).includes(c.runDb), "the seed targets the throwaway database");
    // no PIN and no TTY: it must refuse (no random or default PIN is invented)
    const none = run1({});
    expect(none.status === 1 && /ADMIN_PIN|interactiva/.test(none.stderr), "no PIN source -> refuses: " + none.stderr.slice(0, 160));
    // invalid PINs (this is the regression for the broken /^d{4}$/ expression)
    for (const bad of ["1234", "24681", "246810121", "abcdef", "24681a", "24 6810", "2468101\n"]) {
      const r = run1({ ADMIN_PIN: bad });
      expect(r.status === 1 && /6 a 8 d/.test(r.stderr), `PIN ${J(bad)} refused: ${r.stderr.slice(0, 100)}`);
    }
    expect((await one("select count(*)::int n from users")).n === before, "nothing was inserted by the failures");
    const ok = run1({ ADMIN_PIN: pin, ADMIN_NAME: "Admin semilla" });
    expect(ok.status === 0 && /Usuario administrador creado \(id \d+\)/.test(ok.stdout), "created: " + ok.stdout + ok.stderr);
    expect(!ok.stdout.includes(pin) && !ok.stderr.includes(pin) && !/scrypt\$/.test(ok.stdout + ok.stderr), "the PIN and the hash are never printed");
    const row = await one("select id, role, active, pin_hash from users where name='Admin semilla'");
    expect(row.role === "admin" && row.active && isModernHash(row.pin_hash) && verifyModern(pin, row.pin_hash), "stored as a salted scrypt hash");
    const l = await login(pin);
    expect(l.ok && l.v && l.v.id === row.id && l.v.role === "admin", "the seeded admin can log in through the application: " + J(l));
    const dup = run1({ ADMIN_PIN: pin, ADMIN_NAME: "Otro" });
    expect(dup.status === 1 && /ya está en uso/.test(dup.stderr), "a PIN already in use is refused (logical uniqueness): " + dup.stderr);
    expect((await one("select count(*)::int n from users where name='Otro'")).n === 0, "no duplicate was created");
    await recover();
  });

  // ================================================================== the users screen (visual)
  const row = (name) => page.locator("tr", { hasText: name });
  await test("UI-USERS-01.create_edit_without_pin_edit_with_pin_and_deactivate", "e2e", async () => {
    await recover();
    await resetToLogin();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    await ui.nav(page, "Usuarios");
    await page.getByRole("heading", { name: "Gestión de Usuarios" }).waitFor();
    const name = "Pantalla " + c.runId, pin = await data.newPin(7), pin2 = await data.newPin(8);
    usedPins.push(pin, pin2);
    // create: the PIN is mandatory and has 6-8 digits
    await page.getByRole("button", { name: "Nuevo Usuario" }).click();
    let d = page.getByRole("dialog");
    await d.getByPlaceholder("Nombre completo...").fill(name);
    await d.getByRole("button", { name: "Crear Usuario" }).click();
    await page.getByText("El PIN es obligatorio al crear un usuario").waitFor();
    await d.getByLabel("PIN", { exact: true }).fill("1234");
    await d.getByRole("button", { name: "Crear Usuario" }).click();
    await page.getByText("El PIN debe tener de 6 a 8 dígitos").first().waitFor();
    await d.getByLabel("PIN", { exact: true }).fill(pin);
    await d.getByRole("button", { name: "Crear Usuario" }).click();
    await page.getByText("Usuario creado exitosamente").waitFor();
    await row(name).waitFor();
    const created = await one("select id, pin_hash, role, active from users where name=$1", [name]);
    expect(created.active && created.role === "vendor" && verifyModern(pin, created.pin_hash), "persisted with a scrypt hash");
    // a duplicate PIN is explained, not a generic error
    await page.getByRole("button", { name: "Nuevo Usuario" }).click();
    d = page.getByRole("dialog");
    await d.getByPlaceholder("Nombre completo...").fill(name + " copia");
    await d.getByLabel("PIN", { exact: true }).fill(pin);
    await d.getByRole("button", { name: "Crear Usuario" }).click();
    await page.getByText(/no está disponible/).first().waitFor();
    expect((await one("select count(*)::int n from users where name=$1", [name + " copia"])).n === 0, "the duplicate was not created");
    await page.keyboard.press("Escape");
    // edit WITHOUT touching the PIN
    await row(name).getByRole("button", { name: "Editar" }).click();
    d = page.getByRole("dialog");
    expect((await d.getByLabel("Nuevo PIN").inputValue()) === "", "the stored PIN is never shown");
    await d.getByPlaceholder("Nombre completo...").fill(name + " editado");
    await d.getByRole("button", { name: "Actualizar Usuario" }).click();
    await page.getByText("Usuario actualizado (PIN sin cambios)").waitFor();
    const afterEdit = await one("select pin_hash, name from users where id=$1", [created.id]);
    expect(afterEdit.name === name + " editado" && afterEdit.pin_hash === created.pin_hash, "name changed, hash untouched");
    // edit WITH a new PIN
    await row(name + " editado").getByRole("button", { name: "Editar" }).click();
    d = page.getByRole("dialog");
    await d.getByLabel("Nuevo PIN").fill(pin2);
    await d.getByRole("button", { name: "Actualizar Usuario" }).click();
    await page.getByText("Usuario actualizado y PIN cambiado").waitFor();
    const afterPin = await hashOf(created.id);
    expect(afterPin !== created.pin_hash && verifyModern(pin2, afterPin) && !verifyModern(pin, afterPin), "PIN replaced");
    // deactivate (this is a deactivation, never a physical delete)
    // the in-app confirmation (AlertDialog) replaced the native confirm()
    await row(name + " editado").getByRole("button", { name: "Desactivar" }).click();
    const confirmation = page.getByRole("alertdialog");
    await confirmation.getByText("¿Desactivar este usuario?").waitFor();
    expect(/Ya no podrá iniciar sesión/.test(await confirmation.innerText()) && /historial se conserva/.test(await confirmation.innerText()), "honest confirmation text: " + (await confirmation.innerText()));
    await confirmation.getByRole("button", { name: "Cancelar" }).click();
    await confirmation.waitFor({ state: "hidden" });
    expect((await one("select active from users where id=$1", [created.id])).active === true, "cancel keeps the user active");
    await row(name + " editado").getByRole("button", { name: "Desactivar" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Desactivar usuario" }).click();
    await page.getByText("Usuario desactivado").waitFor();
    await row(name + " editado").waitFor({ state: "detached" });
    const gone = await one("select active from users where id=$1", [created.id]);
    expect(gone && gone.active === false, "the row still exists, deactivated");
    expect(!(await page.getByText(/eliminado exitosamente/).count()), "no false 'deleted' message");
    expect(await row(admin.name).getByRole("button", { name: "Desactivar" }).isDisabled(), "you cannot deactivate yourself");
  });

  await ui.logout(page).catch(() => {});
}
