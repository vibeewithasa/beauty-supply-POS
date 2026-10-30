// Setup suite (Sprint 06, blocks A2 + A3): the PostgreSQL connection is stored protected by Windows (safeStorage/DPAPI), a legacy
// plain-text config.json is upgraded without losing the connection, encryption failures are safe, and a fresh installation has a
// first-run setup window that verifies PostgreSQL, the role, the schema version and prepares the first administrator WITHOUT
// ever migrating anything. Every application here runs on a TEMPORARY user-data folder with a TEMPORARY config.json (the real
// one is never touched) against the run's throwaway databases. Credentials are read at runtime from the test server settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ui, ipc, expect, launchApp, createRunDb, prepareRunDb, dropRunDb, urlFor, sleep, containsSecret, waitFor } from "../lib/harness.mjs";
import { createRuntimeRole, dropRuntimeRole } from "../../scripts/lib/db-ops.mjs";

// the setup suite starts its own applications: configuration only through config.json, never through .env
export const env = { POS_USE_CONFIG_FILE: "1", POS_SETUP_NO_RELAUNCH: "1" };

const J = JSON.stringify;

export async function run(c) {
  const { db, data, test, artifacts } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const dirs = [];
  const extraDbs = [];
  const roles = [];
  const apps = [];
  const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "pos-setup-ud-")); dirs.push(d); return d; };
  const serverUrl = new URL(urlFor("postgres"));
  const SERVER = { host: serverUrl.hostname, port: serverUrl.port || "5432", user: decodeURIComponent(serverUrl.username), password: decodeURIComponent(serverUrl.password) };
  const secrets = [SERVER.password];

  /** an application started like an installed one: no DATABASE_URL, config.json in its own user-data folder */
  const start = async (userData, extraEnv = {}) => {
    const l = await launchApp(c.runDb, db, artifacts, { ...env, ...extraEnv }, { userData, noDatabaseUrl: true, raw: true });
    apps.push(l.app);
    return l;
  };
  const stop = async (l) => { await l.app.close().catch(() => {}); await sleep(500); };
  const cfgPath = (ud) => path.join(ud, "config.json");
  const text = async (page, sel) => (await page.locator(sel).innerText()).replace(/\s+/g, " ");
  const fillConnection = async (page, o) => {
    for (const [id, v] of Object.entries(o)) await page.locator("#" + id).fill(String(v));
  };
  const probe = async (page) => {
    await page.locator("#btn-test").click();
    await page.locator("#checks li:not(.warn) , #checks li.warn").first().waitFor();
    await waitFor(async () => !(await page.locator("#btn-test").isDisabled()), 15000);
    return text(page, "#checks");
  };
  const login = async (page, pin) => { await ui.login(page, pin); };

  const cleanup = async () => {
    for (const a of apps) await a.close().catch(() => {});
    for (const r of roles) await dropRuntimeRole(urlFor("postgres"), r).catch(() => {});
    for (const d of extraDbs) await dropRunDb(d).catch(() => {});
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  };

  // a least-privilege runtime role on the run's database, created through the project's own tool
  const roleName = "pos_e2e_" + crypto.randomBytes(4).toString("hex");
  const rolePassword = crypto.randomBytes(12).toString("base64url");
  secrets.push(rolePassword);
  try {
    await createRuntimeRole(urlFor(c.runDb), { role: roleName, password: rolePassword, database: c.runDb });
    roles.push(roleName);
    const admin = await data.user("SU_ADMIN", "admin", { modern: true });
    const good = { host: SERVER.host, port: SERVER.port, database: c.runDb, user: roleName, password: rolePassword };

    // ============================================================ A3: the setup window
    await test("SETUP-01.a_fresh_installation_opens_the_setup_window_not_the_application", "security", async () => {
      const ud = tmpDir();
      const l = await start(ud);
      try {
        await l.page.getByRole("heading", { name: "Falta la configuración de la base de datos" }).waitFor({ timeout: 15000 });
        const api = await l.page.evaluate(() => ({ app: typeof window.api, setup: Object.keys(window.setupApi || {}).sort() }));
        expect(api.app === "undefined", "the application's API is not in the setup window");
        expect(J(api.setup) === J(["createAdmin", "getState", "inspect", "save"]), "the bridge has exactly four calls: " + J(api.setup));
        const handlers = await l.app.evaluate(({ ipcMain }) => [...ipcMain._invokeHandlers.keys()].sort());
        const appChannels = handlers.filter((h) => /^(auth|products|cash|sales|returns|users|inventory|priceChanges|reports|dashboard|settings|receipts):/.test(h));
        expect(appChannels.length === 0 && handlers.filter((h) => h.startsWith("setup:")).length === 4, "no application channel is registered while configuring: " + J(handlers));
        expect(!fs.existsSync(cfgPath(ud)), "nothing is written before the operator saves");
        expect(!l.mainLog.some((x) => containsSecret(x)), "no secret in the log");
      } finally { await stop(l); }
    });

    await test("SETUP-02.connection_problems_are_explained_safely_and_block_saving", "security", async () => {
      const ud = tmpDir();
      const l = await start(ud);
      try {
        await l.page.locator("#btn-test").waitFor();
        await fillConnection(l.page, { ...good, password: "definitely-wrong-1" });
        expect((await probe(l.page)).includes("Usuario o contraseña incorrectos"), "wrong password");
        expect(await l.page.locator("#btn-save").isDisabled(), "cannot save a connection that does not work");
        await fillConnection(l.page, { ...good, port: "1" });
        expect((await probe(l.page)).includes("No hay un servidor PostgreSQL escuchando"), "nothing listening on that port");
        await fillConnection(l.page, { ...good, database: "no_such_database_xyz" });
        expect((await probe(l.page)).includes("no existe en ese servidor"), "missing database");
        await fillConnection(l.page, { ...good, host: "db.example.com" });
        await l.page.locator("#btn-test").click();
        await l.page.locator("#msg.err").waitFor();
        expect((await text(l.page, "#msg")).includes("debe ser local"), "a remote server is refused");
        const shown = await l.page.evaluate(() => document.body.innerText);
        expect(!secrets.some((s) => shown.includes(s)), "no message echoes a password");
        expect(!fs.existsSync(cfgPath(ud)), "nothing was saved");
      } finally { await stop(l); }
    });

    await test("SETUP-03.a_minimum_privilege_role_gets_a_clean_report_and_a_superuser_gets_a_warning", "integration", async () => {
      const ud = tmpDir();
      const l = await start(ud);
      try {
        await l.page.locator("#btn-test").waitFor();
        await fillConnection(l.page, good);
        const r = await probe(l.page);
        expect(r.includes("PostgreSQL disponible") && r.includes("privilegios mínimos") && /Esquema al día: \d+ de \d+ migraciones/.test(r) && r.includes("Ya existe un administrador"), "clean report for the runtime role: " + r);
        expect(!(await l.page.locator("#btn-save").isDisabled()), "saving is possible");
        await fillConnection(l.page, { ...good, user: SERVER.user, password: SERVER.password });
        const w = await probe(l.page);
        expect(/superusuario|dueño de \d+ tabla/.test(w), "an over-privileged user is warned about: " + w);
        expect(!(await l.page.locator("#btn-save").isDisabled()), "a warning does not block");
      } finally { await stop(l); }
    });

    await test("SETUP-04.saving_stores_the_password_protected_and_the_app_then_starts_from_it", "security", async () => {
      const ud = tmpDir();
      const l = await start(ud);
      await l.page.locator("#btn-test").waitFor();
      await fillConnection(l.page, good);
      await probe(l.page);
      const exited = new Promise((resolve) => l.app.process().once("exit", resolve));
      await l.page.locator("#btn-save").click();
      await Promise.race([exited, sleep(15000)]);
      expect(fs.existsSync(cfgPath(ud)), "config.json was written");
      const raw = fs.readFileSync(cfgPath(ud), "utf8");
      const cfg = JSON.parse(raw);
      expect(cfg.version === 2 && cfg.host === SERVER.host && cfg.database === c.runDb && cfg.user === roleName, "readable, non-secret connection data: " + J(Object.keys(cfg)));
      expect(typeof cfg.passwordEncrypted === "string" && cfg.passwordEncrypted.length > 40, "the password is a protected blob");
      expect(!secrets.some((s) => raw.includes(s)) && !/databaseUrl|postgres(ql)?:\/\//.test(raw), "no plain-text password and no connection string in the file");
      expect(!l.mainLog.some((x) => secrets.some((s) => x.includes(s))), "no secret in the log of the setup session");
      expect(fs.readdirSync(ud).filter((f) => f.endsWith(".tmp")).length === 0, "no temporary file left");
      // the next start: the application itself, from the protected file
      const l2 = await launchApp(c.runDb, db, artifacts, { ...env }, { userData: ud, noDatabaseUrl: true });
      apps.push(l2.app);
      try {
        await l2.page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
        await login(l2.page, admin.pin);
        await l2.page.waitForURL(/#\/dashboard$/, { timeout: 10000 });
        const who = await one("select usename from pg_stat_activity where application_name <> 'e2e_verifier' and usename=$1 limit 1", [roleName]);
        expect(who && who.usename === roleName, "the application connects as the runtime role, not as the server owner");
        expect(!l2.mainLog.some((x) => secrets.some((s) => x.includes(s))), "no secret in the application log");
      } finally { await stop(l2); }
    });

    await test("SETUP-05.without_protected_storage_nothing_is_saved_and_an_existing_file_is_untouched", "security", async () => {
      const ud = tmpDir();
      const l = await start(ud, { POS_TEST_CIPHER_UNAVAILABLE: "1" });
      try {
        await l.page.locator("#btn-test").waitFor();
        await fillConnection(l.page, good);
        await probe(l.page);
        await l.page.locator("#btn-save").click();
        await l.page.locator("#msg.err").waitFor();
        expect((await text(l.page, "#msg")).includes("no se guarda en texto plano"), "the operator is told why: " + (await text(l.page, "#msg")));
        expect(!fs.existsSync(cfgPath(ud)), "no file, in particular no plain-text fallback");
      } finally { await stop(l); }
      const prior = '{"version":2,"host":"localhost","port":5432,"database":"x_db","user":"keepme"}';
      fs.writeFileSync(cfgPath(ud), prior);
      const l2 = await start(ud, { POS_TEST_CIPHER_UNAVAILABLE: "1" });
      try {
        await l2.page.locator("#btn-test").waitFor();
        await fillConnection(l2.page, good);
        await probe(l2.page);
        await l2.page.locator("#btn-save").click();
        await l2.page.locator("#msg.err").waitFor();
        expect(fs.readFileSync(cfgPath(ud), "utf8") === prior, "the previous configuration was not replaced by a failed save");
      } finally { await stop(l2); }
    });

    await test("SETUP-06.a_legacy_plain_text_config_is_protected_in_place_and_keeps_the_same_connection", "security", async () => {
      const ud = tmpDir();
      const url = new URL(`postgresql://placeholder/${c.runDb}`);
      url.hostname = SERVER.host; url.port = SERVER.port; url.username = roleName; url.password = encodeURIComponent(rolePassword);
      fs.writeFileSync(cfgPath(ud), J({ databaseUrl: url.toString() }));
      const l = await launchApp(c.runDb, db, artifacts, { ...env }, { userData: ud, noDatabaseUrl: true });
      apps.push(l.app);
      try {
        await l.page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
        await login(l.page, admin.pin);
        await l.page.waitForURL(/#\/dashboard$/, { timeout: 10000 });
      } finally { await stop(l); }
      const raw = fs.readFileSync(cfgPath(ud), "utf8");
      const cfg = JSON.parse(raw);
      expect(cfg.version === 2 && cfg.user === roleName && cfg.database === c.runDb && cfg.passwordEncrypted, "now the protected format with the same connection: " + J(Object.keys(cfg)));
      expect(!raw.includes(rolePassword) && !raw.includes(encodeURIComponent(rolePassword)) && !/databaseUrl/.test(raw), "the clear-text password is gone from the file");
      expect(fs.readdirSync(ud).filter((f) => /config/.test(f)).join() === "config.json", "no backup copy of the plain text was created");
      const l2 = await launchApp(c.runDb, db, artifacts, { ...env }, { userData: ud, noDatabaseUrl: true });
      apps.push(l2.app);
      try {
        await l2.page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
        await login(l2.page, admin.pin);
        await l2.page.waitForURL(/#\/dashboard$/, { timeout: 10000 });
      } finally { await stop(l2); }
    });

    await test("SETUP-07.a_legacy_config_is_kept_working_but_not_rewritten_when_Windows_cannot_protect_it", "security", async () => {
      const ud = tmpDir();
      const url = new URL(`postgresql://placeholder/${c.runDb}`);
      url.hostname = SERVER.host; url.port = SERVER.port; url.username = roleName; url.password = encodeURIComponent(rolePassword);
      const legacy = J({ databaseUrl: url.toString() });
      fs.writeFileSync(cfgPath(ud), legacy);
      const l = await launchApp(c.runDb, db, artifacts, { ...env, POS_TEST_CIPHER_UNAVAILABLE: "1" }, { userData: ud, noDatabaseUrl: true });
      apps.push(l.app);
      try {
        await l.page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
        expect(fs.readFileSync(cfgPath(ud), "utf8") === legacy, "the configuration was not lost or half-written");
        expect(!l.mainLog.some((x) => secrets.some((s) => x.includes(s))), "no secret in the log");
      } finally { await stop(l); }
    });

    await test("SETUP-08.a_password_that_this_windows_account_cannot_decrypt_leads_to_setup_with_the_data_prefilled", "security", async () => {
      const ud = tmpDir();
      fs.writeFileSync(cfgPath(ud), J({ version: 2, host: SERVER.host, port: Number(SERVER.port), database: c.runDb, user: roleName, passwordEncrypted: Buffer.from("not a dpapi blob").toString("base64") }));
      const l = await start(ud);
      try {
        await l.page.getByText(/no se puede descifrar con esta cuenta de Windows/).waitFor({ timeout: 15000 });
        expect((await l.page.locator("#user").inputValue()) === roleName && (await l.page.locator("#database").inputValue()) === c.runDb, "host, database and user are prefilled");
        expect((await l.page.locator("#password").inputValue()) === "", "the password field is empty: it is never sent back");
        expect(!l.mainLog.some((x) => x.includes("not a dpapi") || secrets.some((s) => x.includes(s))), "nothing sensitive in the log");
      } finally { await stop(l); }
    });

    // ============================================================ the first administrator and the schema (never migrated here)
    await test("SETUP-09.the_first_administrator_is_prepared_on_an_empty_database_with_the_schema_ready", "integration", async () => {
      const fresh = await createRunDb();
      extraDbs.push(fresh);
      await prepareRunDb(fresh);
      const ud = tmpDir();
      const l = await start(ud);
      try {
        await l.page.locator("#btn-test").waitFor();
        await fillConnection(l.page, { ...SERVER, database: fresh });
        const r = await probe(l.page);
        expect(r.includes("No hay administradores"), "reports that there is no administrator: " + r);
        await l.page.locator("#admin-section").waitFor({ state: "visible" });
        await l.page.locator("#admin-name").fill("Dueña Prueba");
        await l.page.locator("#admin-pin").fill("246810");
        await l.page.locator("#admin-pin2").fill("246811");
        await l.page.locator("#btn-admin").click();
        expect((await text(l.page, "#msg")).includes("no coinciden"), "mismatching PINs are refused");
        await l.page.locator("#admin-pin").fill("1234");
        await l.page.locator("#admin-pin2").fill("1234");
        await l.page.locator("#btn-admin").click();
        await l.page.locator("#msg.err").waitFor();
        expect((await text(l.page, "#msg")).includes("El PIN debe tener de 6 a 8 dígitos"), "a short PIN is refused: " + (await text(l.page, "#msg")));
        const check = await import("pg").then(({ default: pg }) => new pg.Client({ connectionString: urlFor(fresh) }));
        await check.connect();
        try {
          expect((await check.query("select count(*)::int n from users")).rows[0].n === 0, "nothing was created by the refused attempts");
          await l.page.locator("#admin-pin").fill("739104");
          await l.page.locator("#admin-pin2").fill("739104");
          await l.page.locator("#btn-admin").click();
          await l.page.getByText("Administrador creado").waitFor({ timeout: 10000 });
          const u = (await check.query("select name, role, active, pin_hash from users")).rows;
          expect(u.length === 1 && u[0].role === "admin" && u[0].active && u[0].name === "Dueña Prueba" && /^scrypt\$/.test(u[0].pin_hash) && !u[0].pin_hash.includes("739104"), "one active administrator with a salted scrypt hash");
          expect((await check.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n === (await one("select count(*)::int n from drizzle.__drizzle_migrations")).n, "no migration was run by the setup");
        } finally { await check.end(); }
        // a second administrator cannot be created from here
        await l.page.locator("#btn-test").click();
        await waitFor(async () => (await l.page.locator("#checks").innerText()).includes("Ya existe un administrador"), 10000);
        expect(await l.page.locator("#admin-section").isHidden(), "the section disappears once an administrator exists");
        const dom = await l.page.evaluate(() => document.documentElement.outerHTML + document.body.innerText);
        expect(!dom.includes("739104") && !l.mainLog.some((x) => x.includes("739104")), "the PIN is neither left in the page nor logged");
      } finally { await stop(l); }
    });

    await test("SETUP-10.a_database_with_missing_migrations_is_reported_and_never_migrated_by_the_setup", "security", async () => {
      const bare = await createRunDb(); // created but NOT prepared: no tables at all
      extraDbs.push(bare);
      const ud = tmpDir();
      const l = await start(ud);
      try {
        await l.page.locator("#btn-test").waitFor();
        await fillConnection(l.page, { ...SERVER, database: bare });
        const r = await probe(l.page);
        expect(/Esquema|migraciones|inicializ/i.test(r) && !/Esquema al día/.test(r), "the missing schema is reported: " + r);
        expect(r.includes("npm run db:migrate") || (await text(l.page, "body")).includes("npm run db:migrate"), "and the explicit command is named");
        expect(await l.page.locator("#admin-section").isHidden(), "no administrator can be prepared without a schema");
        // even forcing the call, the service refuses
        const forced = await l.page.evaluate(async (conn) => { try { return { ok: true, v: await window.setupApi.createAdmin({ connection: conn, name: "X", pin: "246810" }) }; } catch (e) { return { ok: false, err: String(e.message) }; } }, { ...SERVER, database: bare });
        expect(forced.ok === false && /ESQUEMA_NO_LISTO/.test(forced.err), "createAdmin refuses: " + J(forced));
        const pg = (await import("pg")).default;
        const check = new pg.Client({ connectionString: urlFor(bare) });
        await check.connect();
        try { expect((await check.query("select count(*)::int n from pg_tables where schemaname in ('public','drizzle')")).rows[0].n === 0, "the database is still empty: nothing was migrated or created"); } finally { await check.end(); }
      } finally { await stop(l); }
    });

    await test("SETUP-12.reconfigure_opens_the_setup_with_the_data_prefilled_even_when_the_stored_connection_works", "integration", async () => {
      const ud = tmpDir();
      // a working protected configuration first (saved through the setup window itself)
      const l = await start(ud);
      await l.page.locator("#btn-test").waitFor();
      await fillConnection(l.page, good);
      await probe(l.page);
      const exited = new Promise((resolve) => l.app.process().once("exit", resolve));
      await l.page.locator("#btn-save").click();
      await Promise.race([exited, sleep(15000)]);
      const saved = fs.readFileSync(cfgPath(ud), "utf8");
      // normal start: the application, not the setup
      const l2 = await launchApp(c.runDb, db, artifacts, { ...env }, { userData: ud, noDatabaseUrl: true });
      apps.push(l2.app);
      await l2.page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
      await stop(l2);
      // --reconfigure: the setup window, prefilled, never with the password
      const l3 = await launchApp(c.runDb, db, artifacts, { ...env }, { userData: ud, noDatabaseUrl: true, raw: true, extraArgs: ["--reconfigure"] });
      apps.push(l3.app);
      try {
        await l3.page.getByRole("heading", { name: "Reconfigurar la conexión a la base de datos" }).waitFor({ timeout: 15000 });
        await waitFor(async () => (await l3.page.locator("#user").inputValue()) === roleName, 8000);
        expect((await l3.page.locator("#database").inputValue()) === c.runDb && (await l3.page.locator("#password").inputValue()) === "", "host, database and user prefilled; the password field empty");
        expect(fs.readFileSync(cfgPath(ud), "utf8") === saved, "opening it changes nothing");
        const handlers = await l3.app.evaluate(({ ipcMain }) => [...ipcMain._invokeHandlers.keys()]);
        expect(!handlers.some((h) => /^(auth|sales|cash):/.test(h)), "no application channel is registered in the reconfiguration window");
      } finally { await stop(l3); }
      // an operator-managed DATABASE_URL is never overridden by the flag
      const l4 = await launchApp(c.runDb, db, artifacts, { ...env }, { userData: tmpDir(), raw: false, extraArgs: ["--reconfigure"] });
      apps.push(l4.app);
      try { await l4.page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 }); } finally { await stop(l4); }
    });

    await test("SETUP-11.the_setup_channels_exist_only_in_the_setup_window", "security", async () => {
      // the normal application (started by the harness with DATABASE_URL) has no setup channel and its renderer no bridge
      const handlers = await c.app.evaluate(({ ipcMain }) => [...ipcMain._invokeHandlers.keys()]);
      expect(handlers.length > 40 && !handlers.some((h) => h.startsWith("setup:")), "no setup channel next to the application channels");
      const bridge = await ipc(c.page, "typeof window.setupApi");
      expect(bridge.ok && bridge.v === "undefined", "the application's renderer has no setup bridge");
    });
  } finally {
    await cleanup();
  }
}
