// Demonstration-laptop rehearsal (Sprint 07). Proves, WITHOUT installing anything on this machine, that the Windows installer
// carries a working application and that the whole laptop procedure works the way the owner will run it:
//
//   1. the installer payload is extracted into a temporary folder with 7-Zip (the NSIS installer is a 7z archive); that folder
//      is what an installed copy looks like (Beauty POS.exe, resources\app.asar, resources\tools). The NSIS install/uninstall
//      steps themselves (shortcuts, uninstaller) cannot be rehearsed here and stay on the manual laptop checklist.
//   2. nothing of the development environment is used: neutral working folder, a PATH with no Node.js, no DATABASE_URL, no .env,
//      no Vite. The package must run on its own.
//   3. the PowerShell wrapper shipped in resources\tools creates a NEW database with the fictional dataset, the minimum-privilege
//      application role and two demonstration users whose PINs are chosen at run time (they are random here and never exist in
//      the installer).
//   4. the extracted application is configured through its own first-run window, restarted, and the presentation is driven through
//      the real UI: history, receipt, cash history, inventory, a cash sale, a card sale, a refund authorised with the administrator
//      PIN, a pending refund paid later, cash closing, restart persistence and the vendor's restricted view.
//
// Build first:  npm run package   (creates release/Beauty POS Setup <version>.exe and release/win-unpacked)
// It never touches an existing database: it creates (and finally drops) its own beauty_pos_e2e_demo* database and pos_e2e_demo_* role.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import pg from "pg";
import {
  ROOT, urlFor, createRecorder, summarize, scrub, sleep, waitFor, ui, ipc, expect, containsSecret, verifyModern, isModernHash,
} from "./lib/harness.mjs";
import { dropRuntimeRole } from "../scripts/lib/db-ops.mjs";
import { USERS, expectedTotals, productBySku } from "../scripts/lib/demo-data.mjs";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const INSTALLER = path.join(ROOT, "release", `Beauty POS Setup ${pkg.version}.exe`);
const UNPACKED_ASAR = path.join(ROOT, "release", "win-unpacked", "resources", "app.asar");
const SEVEN_ZIP = (() => {
  const base = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "7zip@1.0.0");
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, "bin", "7za.exe");
    if (fs.existsSync(p)) return p;
  }
  return null;
})();
if (!fs.existsSync(INSTALLER) || !fs.existsSync(UNPACKED_ASAR) || !SEVEN_ZIP) {
  console.error("Missing the installer, the unpacked package or 7za.exe. Run: npm run package");
  process.exit(2);
}

const runId = Date.now().toString(36) + crypto.randomBytes(1).toString("hex");
const artifacts = path.join(ROOT, "e2e-artifacts", "demo-" + runId);
fs.mkdirSync(artifacts, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pos-demo-"));
const installDir = path.join(scratch, "Estetica Leal POS"); // "installed" copy
const neutralCwd = path.join(scratch, "cwd");
fs.mkdirSync(neutralCwd);
const exe = path.join(installDir, "Beauty POS.exe");
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? scrub(x) : x)));

const adminUrl = new URL(urlFor("postgres"));
const PG = { host: adminUrl.hostname, port: adminUrl.port || "5432", user: decodeURIComponent(adminUrl.username), password: decodeURIComponent(adminUrl.password) };
const DB_NAME = "beauty_pos_e2e_demo" + runId.replace(/[^a-z0-9]/g, "");
const ROLE = "pos_e2e_demo_" + crypto.randomBytes(3).toString("hex");
if (!/^beauty_pos_e2e_demo[a-z0-9]+$/.test(DB_NAME) || !/^pos_e2e_demo_[a-z0-9]+$/.test(ROLE)) throw new Error("bad generated names");
const randomPin = () => String(crypto.randomInt(100000, 999999));
const ADMIN_PIN = randomPin();
let VENDOR_PIN = randomPin();
while (VENDOR_PIN === ADMIN_PIN) VENDOR_PIN = randomPin();

// A bare-bones Windows environment: no Node.js, no npm, no project variables.
function neutralEnv(extra = {}) {
  const keep = ["SystemRoot", "windir", "SystemDrive", "ComSpec", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PATHEXT", "USERNAME", "COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "HOMEDRIVE", "HOMEPATH", "USERDOMAIN", "LOGONSERVER"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const sys = process.env.SystemRoot || "C:\\Windows";
  env.PATH = [path.join(sys, "System32"), sys, path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";");
  return { ...env, ...extra };
}
const closeApp = async (l) => { try { await l.app.close(); } catch { /* already closed */ } };
const launched = [];
async function launchInstalled(userData, extraArgs = []) {
  const app = await _electron.launch({ executablePath: exe, args: ["--user-data-dir=" + userData, ...extraArgs], cwd: neutralCwd, env: neutralEnv(), timeout: 60000 });
  launched.push(app);
  const mainLog = [];
  const proc = app.process();
  for (const s of [proc.stdout, proc.stderr]) s && s.on("data", (b) => mainLog.push(...String(b).split(/\r?\n/).filter(Boolean)));
  const w = await app.firstWindow();
  await w.waitForLoadState("domcontentloaded");
  const consoleErrors = [];
  w.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 240)); });
  w.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message.slice(0, 240)));
  return { app, page: w, mainLog, consoleErrors };
}
// the folder is this run's own temp copy: stopping what runs from it can never touch anything else
function stopProcessesFrom(dir) {
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:POS_KILL_DIR, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { env: { ...neutralEnv(), POS_KILL_DIR: dir + path.sep }, encoding: "utf8" });
}
function processesFrom(dir) {
  const ps = "(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:POS_KILL_DIR, [StringComparison]::OrdinalIgnoreCase) } | Measure-Object).Count";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { env: { ...neutralEnv(), POS_KILL_DIR: dir + path.sep }, encoding: "utf8" });
  return Number(String(r.stdout).trim()) || 0;
}
function runPs1(extraEnv, args = []) {
  const ps1 = path.join(installDir, "resources", "tools", "Preparar-Base-Demo.ps1");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args], {
    cwd: neutralCwd, encoding: "utf8", timeout: 120000, windowsHide: true,
    env: neutralEnv({ POS_DEMO_NONINTERACTIVE: "1", POS_PG_HOST: PG.host, POS_PG_PORT: String(PG.port), POS_PG_ADMIN_USER: PG.user, ...extraEnv }),
  });
  return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}
const leaks = (text, extra = []) => [PG.password, ADMIN_PIN, VENDOR_PIN, ...extra].filter((s) => s && s.length > 2 && String(text).includes(s));

const { results, rec, test } = createRecorder("demo", artifacts, () => page, { log });
const userData = path.join(scratch, "userdata");
fs.mkdirSync(userData);
let page, db, dbRuntimePassword, L;
let fatal;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const T = expectedTotals();
const cents = (v) => Math.round(Number(v) * 100);
const fmtMoney = (c) => (c / 100).toFixed(2);

try {
  // ------------------------------------------------------------------------------------------------ the "installed" copy
  await test("DEMO-01.the_installer_payload_is_the_tested_package_with_the_tools_the_laptop_needs", "integration", async () => {
    const x = spawnSync(SEVEN_ZIP, ["x", INSTALLER, "-o" + installDir, "-y"], { encoding: "utf8", maxBuffer: 1 << 26 });
    // the NSIS stub trails the 7z payload: 7-Zip reports a warning (exit 2 "data after the end"), the files are complete
    expect(fs.existsSync(exe), "Beauty POS.exe extracted (7za exit " + x.status + ")");
    const asar = path.join(installDir, "resources", "app.asar");
    expect(fs.existsSync(asar), "app.asar extracted");
    const h = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    expect(h(asar) === h(UNPACKED_ASAR), "the installer's app.asar is byte-identical to the unpacked package the other suites test");
    for (const f of ["Preparar-Base-Demo.cmd", "Preparar-Base-Demo.ps1", "LEEME.txt"]) expect(fs.existsSync(path.join(installDir, "resources", "tools", f)), "resources\\tools\\" + f);
    const files = require("@electron/asar").listPackage(asar);
    expect(files.some((f) => /dist[\\/]tools[\\/]demo-setup\.cjs$/.test(f)), "the provisioning tool is inside the app");
    expect(!files.some((f) => /(^|[\\/])\.env($|\.)/.test(f) && !/example/.test(f)), "no .env in the package");
    const st = fs.statSync(INSTALLER).size;
    expect(st > 50e6 && st < 300e6, "installer size is plausible: " + st);
  });
  await test("DEMO-02.nothing_secret_or_prefabricated_travels_in_the_installer", "security", async () => {
    const asarApi = require("@electron/asar");
    const asar = path.join(installDir, "resources", "app.asar");
    const own = asarApi.listPackage(asar)
      .filter((f) => /dist[\\/]/.test(f) && /\.(cjs|js|html|css)$/.test(f))
      .map((f) => asarApi.extractFile(asar, f.replace(/^[\\/]/, "")).toString("utf8"))
      .join("\n");
    const toolsText = fs.readdirSync(path.join(installDir, "resources", "tools")).map((f) => fs.readFileSync(path.join(installDir, "resources", "tools", f), "utf8")).join("\n");
    for (const [name, text] of [["application bundles", own], ["tools folder", toolsText]]) {
      expect(!/scrypt\$\d+\$\d+\$\d+\$[\w-]{16,}\$[\w-]{32,}/.test(text), name + ": no precomputed PIN hash");
      expect(!/postgres(?:ql)?:\/\/[^\s"'`:@/]+:[^\s"'`@]+@/.test(text) && !text.includes(`${adminUrl.protocol}//${adminUrl.username}:${adminUrl.password}@`), name + ": no credential-bearing URL or database credentials");
    }
    // the demonstration users and their hashes only exist once the laptop's operator creates them
    expect(!/inserts+intos+users|pin_hash/i.test(toolsText), "the wrappers carry no user data");
  });

  // ------------------------------------------------------------------------------------------------ database preparation
  await test("DEMO-03.the_wrapper_refuses_bad_input_without_creating_anything", "security", async () => {
    const admin = new pg.Client({ connectionString: urlFor("postgres", "e2e_demo_probe") });
    await admin.connect();
    const exists = async (n) => (await admin.query("select 1 from pg_database where datname=$1", [n])).rowCount === 1;
    try {
      const noPw = runPs1({ POS_PG_ADMIN_PASSWORD: "", POS_DEMO_DATABASE: DB_NAME, POS_DEMO_ROLE: ROLE, POS_DEMO_ADMIN_PIN: ADMIN_PIN, POS_DEMO_VENDOR_PIN: VENDOR_PIN });
      expect(noPw.code === 1 && /contraseña|contrasena/i.test(noPw.out) && !(await exists(DB_NAME)), "no administrator password -> exit 1, nothing created: " + noPw.out.slice(-200));
      const shortPin = runPs1({ POS_PG_ADMIN_PASSWORD: PG.password, POS_DEMO_DATABASE: DB_NAME, POS_DEMO_ROLE: ROLE, POS_DEMO_ADMIN_PIN: "48271", POS_DEMO_VENDOR_PIN: VENDOR_PIN });
      expect(shortPin.code === 1 && !(await exists(DB_NAME)), "a 5-digit PIN is rejected before anything is created");
      expect(leaks(shortPin.out).length === 0 && leaks(noPw.out).length === 0, "the messages do not echo secrets");
      // an existing database is never modified: pointing at the development database must be refused outright
      const protectedName = runPs1({ POS_PG_ADMIN_PASSWORD: PG.password, POS_DEMO_DATABASE: "beauty_pos", POS_DEMO_ROLE: ROLE, POS_DEMO_ADMIN_PIN: ADMIN_PIN, POS_DEMO_VENDOR_PIN: VENDOR_PIN });
      expect(protectedName.code === 1 && !(await admin.query("select 1 from pg_roles where rolname=$1", [ROLE])).rowCount, "a protected/existing name is refused and no role is left behind: " + protectedName.out.slice(-200));
    } finally { await admin.end(); }
  });

  await test("DEMO-04.the_packaged_tool_creates_the_demo_database_role_and_users_from_the_installed_copy", "integration", async () => {
    const r = runPs1({ POS_PG_ADMIN_PASSWORD: PG.password, POS_DEMO_DATABASE: DB_NAME, POS_DEMO_ROLE: ROLE, POS_DEMO_ADMIN_PIN: ADMIN_PIN, POS_DEMO_VENDOR_PIN: VENDOR_PIN });

    expect(r.code === 0, "provisioning exit code " + r.code + ": " + scrub(r.out).slice(-500));
    expect(/Datos ficticios cargados/.test(r.out) && /LISTO/.test(r.out), "the tool reports the data was loaded");
    const m = r.out.match(/Contrase.a: (\S+)/);
    expect(m && m[1].length >= 16, "a generated runtime password is shown once");
    dbRuntimePassword = m[1];
    expect(leaks(r.out).length === 0, "neither the PostgreSQL password nor the PINs are printed");
    expect(!new RegExp(ADMIN_PIN).test(r.out) && !new RegExp(VENDOR_PIN).test(r.out), "PINs not on screen");
    db = new pg.Client({ connectionString: urlFor(DB_NAME, "e2e_demo_verifier") });
    await db.connect();
    expect((await one("select current_database() d")).d === DB_NAME, "verifier connected to the demo database");
  });
  await test("DEMO-05.the_seeded_data_matches_the_definition_to_the_cent", "integration", async () => {
    const c = await one("select (select count(*) from users)::int users,(select count(*) from products)::int products,(select count(*) from sales)::int sales,(select count(*) from cash_sessions)::int sessions,(select count(*) from returns)::int returns,(select count(*) from refund_settlements)::int settlements,(select count(*) from cash_sessions where closed_at is null)::int open_sessions,(select count(*) from drizzle.__drizzle_migrations)::int migrations");
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")).entries.length;
    expect(c.users === 2 && c.products === T.products && c.sales === T.sales && c.sessions === 3 && c.returns === T.returns && c.settlements === 1 && c.open_sessions === 0 && c.migrations === journal, "counts: " + JSON.stringify(c));
    const pay = Object.fromEntries((await q("select payment_method m, sum(total)::text t from sales group by 1")).map((r) => [r.m, cents(r.t)]));
    expect(pay.cash === T.cashSalesCents && pay.card === T.cardSalesCents, `sales by method: ${JSON.stringify(pay)} vs ${T.cashSalesCents}/${T.cardSalesCents}`);
    const stock = Object.fromEntries((await q("select sku, stock from products")).map((r) => [r.sku, Number(r.stock)]));
    expect(JSON.stringify(Object.entries(stock).sort()) === JSON.stringify(Object.entries(T.stock).sort()), "stock per product equals sold/returned arithmetic");
    const rs = await q("select refund_status s, sum(total_refund)::text t from returns group by 1");
    const by = Object.fromEntries(rs.map((r) => [r.s, cents(r.t)]));
    expect(by.paid === T.paidCashCents && by.pending === T.pendingCents, "returns paid/pending: " + JSON.stringify(by));
    const sessions = await q("select current_amount::text c, final_amount::text f, initial_amount::text i from cash_sessions order by opened_at");
    expect(sessions.length === 3 && sessions.every((s) => s.f !== null), "three closed registers");
    const finals = sessions.map((s) => cents(s.f)).sort((x, y) => x - y);
    const wants = [T.sessionBalances[3], T.sessionBalances[2] - 500, T.sessionBalances[1]].sort((x, y) => x - y);
    expect(JSON.stringify(finals) === JSON.stringify(wants), "register closings (one with a 5.00 shortage): " + JSON.stringify(finals) + " vs " + JSON.stringify(wants));
    const u = await q("select name, role, pin_hash from users order by role");
    expect(u.map((x) => x.name + ":" + x.role).join() === `${USERS.admin}:admin,${USERS.vendor}:vendor`, "the two demonstration users: " + u.map((x) => x.name).join());
    expect(u.every((x) => isModernHash(x.pin_hash)), "PINs stored as scrypt hashes");
    const a = u.find((x) => x.role === "admin"), v = u.find((x) => x.role === "vendor");
    expect(verifyModern(ADMIN_PIN, a.pin_hash) && verifyModern(VENDOR_PIN, v.pin_hash) && !verifyModern(VENDOR_PIN, a.pin_hash), "each hash matches the PIN chosen at provisioning");
    const biz = await one("select name, address, phone, tax_info from business_settings");
    expect(biz && !biz.address && !biz.phone && !biz.tax_info, "no commercial data invented in the business settings: " + JSON.stringify(biz));
    expect((await q("select 1 from products where sku not like 'DEMO-%'")).length === 0, "every product carries the DEMO- marker");
  });
  await test("DEMO-06.the_runtime_role_has_minimum_privileges_and_the_tool_refuses_to_reuse_the_database", "security", async () => {
    const rt = new pg.Client({ host: PG.host, port: Number(PG.port), user: ROLE, password: dbRuntimePassword, database: DB_NAME });
    await rt.connect();
    try {
      expect((await rt.query("select count(*)::int n from products")).rows[0].n === T.products, "the role can read and use the data");
      for (const sql of ["create table intruder(id int)", "drop table products", "truncate users", "create role intruder_role"]) {
        let denied = false;
        try { await rt.query(sql); } catch { denied = true; }
        expect(denied, "denied: " + sql);
      }
    } finally { await rt.end(); }
    const again = runPs1({ POS_PG_ADMIN_PASSWORD: PG.password, POS_DEMO_DATABASE: DB_NAME, POS_DEMO_ROLE: ROLE + "_b", POS_DEMO_ADMIN_PIN: ADMIN_PIN, POS_DEMO_VENDOR_PIN: VENDOR_PIN });
    expect(again.code === 1 && /ya existe/i.test(again.out), "second run on the same database refused: " + again.out.slice(-200));
    expect((await one("select count(*)::int n from users")).n === 2 && (await one("select count(*)::int n from sales")).n === T.sales, "the existing demo database is untouched");
    expect((await q("select 1 from pg_roles where rolname=$1", [ROLE + "_b"])).length === 0, "no stray role from the refused run");
  });

  // ------------------------------------------------------------------------------------------------ first run
  await test("DEMO-07.first_start_shows_the_setup_window_without_the_repository_or_dev_tools", "integration", async () => {
    L = await launchInstalled(userData);
    page = L.page;
    await page.locator("#btn-test").waitFor({ timeout: 20000 });
    expect(/Estética Leal/.test(await page.title()) || /Estética Leal/.test(await page.evaluate(() => document.body.innerText)), "the setup window carries the Estética Leal identity");
    expect(await page.evaluate(() => typeof window.api) === "undefined", "no application API before the connection is configured");
    const where = await L.app.evaluate(({ app }) => ({ packaged: app.isPackaged, exe: app.getPath("exe"), cwd: process.cwd() }));
    expect(where.packaged === true && where.exe.toLowerCase() === exe.toLowerCase(), "running the extracted package: " + where.exe);
  });
  await test("DEMO-08.the_setup_window_verifies_the_demo_database_and_saves_only_protected_credentials", "security", async () => {
    await page.locator("#host").fill(String(PG.host));
    await page.locator("#port").fill(String(PG.port));
    await page.locator("#database").fill(DB_NAME);
    await page.locator("#user").fill(ROLE);
    await page.locator("#password").fill(dbRuntimePassword);
    await page.locator("#btn-test").click();
    await page.getByText(/Esquema al día: \d+ de \d+ migraciones/).waitFor({ timeout: 20000 });
    const t = (await page.locator("#checks").innerText()).replace(/\s+/g, " ");
    expect(/privilegios mínimos/.test(t) && /Ya existe un administrador/.test(t), "report: " + t);
    expect(!fs.existsSync(path.join(userData, "config.json")), "nothing saved before the operator saves");
    const exited = new Promise((resolve) => L.app.process().once("exit", resolve));
    await page.locator("#btn-save").click();
    await Promise.race([exited, sleep(15000)]);
    const cfgPath = path.join(userData, "config.json");
    expect(await waitFor(async () => fs.existsSync(cfgPath), 10000), "config.json written");
    const raw = fs.readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    expect(cfg.version === 2 && typeof cfg.passwordEncrypted === "string", "protected format: " + Object.keys(cfg).join());
    expect(!raw.includes(dbRuntimePassword) && !/postgres(ql)?:\/\//.test(raw), "the password is not in clear text on disk");
    expect(!L.mainLog.some((x) => leaks(x, [dbRuntimePassword]).length > 0 || containsSecret(x)), "no secret in the log");
    // the packaged application relaunches itself after saving (nobody can attach to that one): confirm it did, then stop it
    const relaunched = await waitFor(async () => processesFrom(installDir) > 0, 15000);
    stopProcessesFrom(installDir);
    await sleep(1500);
    expect(relaunched, "the application relaunched itself after saving");
  });

  // ------------------------------------------------------------------------------------------------ the presentation
  let adminId;
  L = await launchInstalled(userData);
  page = L.page;
  await test("DEMO-09.after_the_restart_the_login_shows_estetica_leal_and_the_admin_enters", "e2e", async () => {
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 20000 });
    await page.getByRole("heading", { name: "Estética Leal" }).waitFor();
    expect(await page.locator('img[src*="estetica-leal-icon"]').evaluate((i) => i.complete && i.naturalWidth > 0), "the brand mark loads under the packaged CSP");
    expect(/Estética Leal/.test(await page.title()), "window title: " + (await page.title()));
    adminId = (await one("select id from users where role='admin'")).id;

    await ui.login(page, ADMIN_PIN);
    await page.waitForURL(/#\/dashboard$/, { timeout: 15000 });
    await page.getByRole("heading", { name: "Estética Leal" }).first().waitFor();
  });
  await test("DEMO-10.history_reports_inventory_and_cash_history_show_the_fictional_days", "e2e", async () => {
    const today = new Date();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const from = new Date(today); from.setDate(from.getDate() - 3);
    const sum = await ipc(page, `api.reports.getSummary({from:'${iso(from)}',to:'${iso(today)}'})`);
    expect(sum.ok && sum.v.sales.count === T.sales && cents(sum.v.sales.total) === T.cashSalesCents + T.cardSalesCents, "report totals: " + JSON.stringify(sum.ok ? sum.v.sales : sum));
    expect(cents(sum.v.refundsOwed.total) === T.pendingCents && cents(sum.v.refundsPaid.cash.total) === T.paidCashCents, "report refunds: owed " + sum.v.refundsOwed.total + ", paid cash " + sum.v.refundsPaid.cash.total);
    await ui.nav(page, "Reportes");
    await page.getByLabel("Desde").fill(iso(from));
    await page.getByRole("button", { name: "Generar reporte" }).click();
    await page.getByTestId("rp-count").waitFor({ timeout: 10000 }).catch((e) => { throw new Error(String(e.message).split("\n")[0] + " | url " + page.url() + " | console " + JSON.stringify(L.consoleErrors) + " | log " + JSON.stringify(L.mainLog.slice(-6))); });
    expect(Number(await page.getByTestId("rp-count").innerText()) === T.sales, "the report screen counts the twelve demonstration sales");
    await ui.nav(page, "Productos");
    await page.getByRole("row", { name: /DEMO-SH-500/ }).waitFor({ timeout: 10000 });
    await page.getByRole("row", { name: /DEMO-DE-500/ }).waitFor();
    await ui.nav(page, "Ver Stock");
    await page.locator("h1,h2").first().waitFor();
    await ui.nav(page, "Historial");
    await page.getByTestId("history-summary").waitFor({ timeout: 10000 });
    await ui.nav(page, "Caja");
    await page.getByRole("link", { name: "Historial de sesiones" }).click();
    await page.getByTestId("cash-history-summary").waitFor({ timeout: 10000 });
    await page.getByText("-$5.00", { exact: true }).waitFor({ timeout: 10000 }); // the register closed with a 5.00 shortage
    const text = await page.getByTestId("cash-history-summary").innerText();
    expect(/3 sesiones/.test(text), "cash history lists the three closed registers: " + text);
  });
  await test("DEMO-11.a_past_sale_opens_with_its_products_and_a_ticket_preview_with_the_store_name", "e2e", async () => {
    const sale = await one("select id from sales order by id limit 1");
    await ui.nav(page, "Historial");
    await page.locator("#hs-q").fill(String(sale.id));
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByRole("button", { name: `Ver venta ${sale.id}` }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByText(`Venta #${sale.id}`).first().waitFor();
    await dlg.getByText(/Shampoo Hidratante/).first().waitFor();
    await page.evaluate(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.violatedDirective)); });
    await dlg.getByRole("button", { name: "Ver recibo" }).click();
    const frame = page.frameLocator('iframe[title="Vista previa del recibo"]');
    await frame.getByText("ESTÉTICA LEAL").waitFor({ timeout: 10000 });
    await frame.getByText("No es una factura fiscal").waitFor();
    expect((await page.evaluate(() => window.__v)).length === 0, "no CSP violation in the preview");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  });
  let liveSale;
  await test("DEMO-12.open_cash_sell_by_barcode_and_by_name_refund_with_admin_pin_and_pay_the_pending_refund", "e2e", async () => {
    const sh = productBySku("DEMO-SH-500"), ge = productBySku("DEMO-GE-250");
    const stock0 = Number((await one("select stock from products where sku='DEMO-GE-250'")).stock);
    await ui.openCash(page, 50);
    // card sale found by its barcode (what the scanner types)
    await ui.sell(page, { query: sh.barcode, name: "Shampoo Hidratante", qty: 1, method: "card" });
    // cash sale found by name
    await ui.sell(page, { query: "Gel Fijador", name: "Gel Fijador", qty: 2, method: "cash" });
    liveSale = await one("select id, total::text t from sales order by id desc limit 1");
    expect(cents(liveSale.t) === ge.cents * 2, "cash sale total " + liveSale.t);
    expect(Number((await one("select stock from products where sku='DEMO-GE-250'")).stock) === stock0 - 2, "stock decreased");
    expect((await one("select count(*)::int n from sales")).n === T.sales + 2, "two new sales next to the twelve of the demo");

    await ui.nav(page, "Devoluciones");
    await page.getByLabel("Número de venta").fill(String(liveSale.id));
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByLabel("Cantidad a devolver de Gel Fijador 250 ml").fill("1");
    await page.getByLabel("Motivo", { exact: true }).fill("Demostración en vivo");
    await page.locator("#rf-method-cash").click();
    await page.locator("#rf-confirm").check();
    await page.getByRole("button", { name: "Confirmar devolución y reembolso" }).click();
    await page.getByRole("dialog").locator("#rf-admin-pin").fill(ADMIN_PIN);
    await page.getByRole("button", { name: "Autorizar y registrar" }).click();
    await page.getByTestId("return-result").getByText(/PAGADO EN EFECTIVO/).waitFor({ timeout: 10000 });
    const r1 = await one("select r.refund_status s, st.amount::text a, st.authorized_by ab from returns r join refund_settlements st on st.return_id=r.id where r.sale_id=$1", [liveSale.id]);
    expect(r1.s === "paid" && cents(r1.a) === ge.cents && r1.ab === adminId, "refund paid in cash and authorised by the administrator: " + JSON.stringify(r1));

    // the return the seed left pending is paid live
    const pend = await one("select id from returns where refund_status='pending' order by id limit 1");
    await page.getByTestId(`pay-pending-${pend.id}`).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByText(`Registrar pago de la devolución #${pend.id}`).waitFor();
    await page.locator("#rp-method-cash").click();
    await page.locator("#rp-confirm").check();
    await page.locator("#rf-admin-pin").fill(ADMIN_PIN);
    await page.getByRole("button", { name: "Autorizar y registrar pago", exact: true }).click();
    expect(await waitFor(async () => (await one("select refund_status s from returns where id=$1", [pend.id])).s === "paid", 10000), "the pending refund is now paid");
    await page.getByTestId(`return-state-${pend.id}`).getByText("PAGADO EN EFECTIVO").waitFor({ timeout: 10000 });
    expect(cents((await one("select sum(amount)::text a from refund_settlements")).a) === T.paidCashCents + ge.cents + T.pendingCents, "settlements add up");
    const cashNow = cents((await one("select current_amount::text c from cash_sessions where closed_at is null")).c);
    expect(cashNow === 5000 + ge.cents * 2 - ge.cents - T.pendingCents, "register: 50.00 + sale - refund - pending refund = " + fmtMoney(cashNow));
  });
  await test("DEMO-13.cash_closes_with_the_counted_amount_and_the_dashboard_still_loads", "e2e", async () => {
    await ui.nav(page, "Caja");
    const expected = await ui.closeCash(page);
    const ge = productBySku("DEMO-GE-250");
    expect(cents(expected) === 5000 + ge.cents * 2 - ge.cents - T.pendingCents, "the closing dialog expected " + expected);
    const s = await one("select difference::text d, status from cash_sessions order by id desc limit 1").catch(() => null);
    expect(s === null || s.status === "closed", "the new register is closed");
    await ui.nav(page, "Dashboard");
    await page.locator("h1,h2").first().waitFor();
    expect(L.consoleErrors.filter((e) => !/favicon/i.test(e)).length === 0, "no console error: " + JSON.stringify(L.consoleErrors));
  });
  await test("DEMO-14.close_and_reopen_keeps_everything_and_the_vendor_sees_only_the_selling_screens", "security", async () => {
    await closeApp(L);
    await sleep(800);
    L = await launchInstalled(userData);
    page = L.page;
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 20000 });
    await ui.login(page, VENDOR_PIN);
    await page.waitForURL(/#\/sales$/, { timeout: 15000 });
    expect(await page.locator("nav").getByRole("link", { name: "Reportes" }).count() === 0, "no Reportes for the vendor");
    expect(await page.locator("nav").getByRole("link", { name: "Usuarios" }).count() === 0, "no Usuarios for the vendor");
    const denied = await ipc(page, "api.users.getAll()");
    expect(denied.ok === false, "an administrator channel is closed to the vendor: " + JSON.stringify(denied));
    expect((await one("select count(*)::int n from sales")).n === T.sales + 2 && (await one("select count(*)::int n from users")).n === 2, "data persisted across the restart");
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, "000000"); // a wrong PIN is refused
    await page.getByText(/PIN incorrecto|inválid|Intentos/i).first().waitFor({ timeout: 8000 });
    expect(!L.mainLog.some((x) => leaks(x, [dbRuntimePassword]).length > 0 || containsSecret(x)), "no PIN or password in the application's log");
  });
} catch (e) {
  fatal = e;
  rec("suite.unexpected_error", "FAIL", scrub(String(e.stack || e)).split("\n").slice(0, 3).join(" | ").slice(0, 400), { kind: "integration" });
} finally {
  for (const app of launched) { try { await app.close(); } catch { /* already closed */ } }
  stopProcessesFrom(installDir);
  try { await db?.end(); } catch { /* ignore */ }
  const adm = new pg.Client({ connectionString: urlFor("postgres", "e2e_demo_cleanup") });
  try {
    await adm.connect();
    // only what this run created, by exact generated name
    if ((await adm.query("select 1 from pg_database where datname=$1", [DB_NAME])).rowCount) await adm.query(`DROP DATABASE "${DB_NAME}" WITH (FORCE)`);
    log("isolated database dropped: " + DB_NAME);
  } catch (e) { log("could not drop " + DB_NAME + ": " + e.message); } finally { await adm.end().catch(() => {}); }
  try { await dropRuntimeRole(urlFor("x"), ROLE); } catch (e) { log("could not drop role " + ROLE + ": " + e.message); }
  await sleep(500);
  fs.rmSync(scratch, { recursive: true, force: true });
}
const { summary, exitCode } = summarize(results, fatal, { runId, suites: ["demo"] });
fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({ summary, results }, null, 1));
log("SUMMARY", JSON.stringify(summary));
log(`artifacts: ${artifacts}`);
process.exit(exitCode);
