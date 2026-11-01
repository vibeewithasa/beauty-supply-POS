// Usage: node e2e/installer-app.mjs   (npm run test:installer-app)   Build first: npm run package
// The self-contained installer, end to end, WITHOUT installing anything on this machine:
//   * the installer payload (NSIS = a 7z archive) is extracted into a temp folder: that is what an installed copy looks like;
//   * the extracted application runs with a bare Windows environment (no Node.js, no DATABASE_URL, no .env, no repository);
//   * its first-installation wizard is driven through the real UI: it creates the dedicated PostgreSQL (from the PostgreSQL package inside
//     the installer, in a folder of this run), the database, the roles and the users - no PostgreSQL is installed, no service is registered,
//     nothing outside the temp folder is written, the developer's own PostgreSQL is not used.
// The NSIS install/uninstall steps themselves (shortcuts, uninstaller, SmartScreen) cannot be rehearsed here: manual list in docs/DEMO_CHECKLIST.md.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { _electron } from "playwright-core";
import pg from "pg";
import { ROOT, createRecorder, summarize, scrub, sleep, waitFor, ui, ipc, expect, containsSecret, verifyModern } from "./lib/harness.mjs";
import { expectedTotals, productBySku } from "../scripts/lib/demo-data.mjs";
import { clusterRunning, connectionUrl, layoutFor, readBundleManifest, readManifest, stopCluster, verifyTree, isPortFree } from "../scripts/lib/managed-pg.mjs";
import { provisionManagedInstance } from "../scripts/lib/provision.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const pin = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "postgresql-pin.json"), "utf8"));
const INSTALLER = path.join(ROOT, "release", `Estética Leal POS Setup ${pkg.version}.exe`);
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
const artifacts = path.join(ROOT, "e2e-artifacts", "installer-app-" + runId);
fs.mkdirSync(artifacts, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pos-instapp-"));
const installDir = path.join(scratch, "Estetica Leal POS");
const neutralCwd = path.join(scratch, "cwd");
fs.mkdirSync(neutralCwd);
const exe = path.join(installDir, "Beauty POS.exe");
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? scrub(x) : x)));
const randomPin = () => String(crypto.randomInt(100000, 999999));
const ADMIN_PIN = randomPin();
let VENDOR_PIN = randomPin();
while (VENDOR_PIN === ADMIN_PIN) VENDOR_PIN = randomPin();
const CLEAN_PIN = randomPin();
const PS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function neutralEnv(extra = {}) {
  const keep = ["SystemRoot", "windir", "SystemDrive", "ComSpec", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PATHEXT", "USERNAME", "COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "HOMEDRIVE", "HOMEPATH", "USERDOMAIN", "LOGONSERVER"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const sys = process.env.SystemRoot || "C:\\Windows";
  env.PATH = [path.join(sys, "System32"), sys, path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";");
  return { ...env, ...extra };
}
const launched = [];
async function launchInstalled(userData, extraArgs = []) {
  const app = await _electron.launch({ executablePath: exe, args: ["--user-data-dir=" + userData, ...extraArgs], cwd: neutralCwd, env: neutralEnv(), timeout: 90000 });
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
const psRun = (cmd, dir) => spawnSync(PS, ["-NoProfile", "-Command", cmd], { env: neutralEnv({ POS_DIR: dir + path.sep }), encoding: "utf8" });
const stopProcessesFrom = (dir) => psRun("Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:POS_DIR, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }", dir);
const processesFrom = (dir, name = null) => Number(String(psRun(`(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:POS_DIR, [StringComparison]::OrdinalIgnoreCase)${name ? ` -and $_.Name -eq '${name}'` : ""} } | Measure-Object).Count`, dir).stdout).trim()) || 0;
const closeApp = async (l) => { try { await l.app.close(); } catch { /* already closed */ } };
const cents = (v) => Math.round(Number(v) * 100);
const T = expectedTotals();

const { results, rec, test } = createRecorder("installer-app", artifacts, () => page, { log });
const userData = path.join(scratch, "userdata");
const userData2 = path.join(scratch, "userdata-clean");
const userData3 = path.join(scratch, "userdata-external");
for (const d of [userData, userData2, userData3]) fs.mkdirSync(d);
let page, L, db, fatal, extRoot, extCleanup;

async function secretsFrom(l, dataDir) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  const adm = JSON.parse(fs.readFileSync(path.join(dataDir, "managed", "cluster-admin.json"), "utf8"));
  const dec = (blob) => l.app.evaluate(({ safeStorage }, b) => safeStorage.decryptString(Buffer.from(b, "base64")), blob);
  return { cfg, runtimePassword: await dec(cfg.passwordEncrypted), adminPassword: await dec(adm.passwordEncrypted) };
}
async function waitForWizardRelaunch(dataDir, l) {
  const exited = new Promise((resolve) => l.app.process().once("exit", resolve));
  await Promise.race([exited, sleep(30000)]);
  expect(await waitFor(async () => processesFrom(installDir, "Beauty POS.exe") > 0, 20000), "the application relaunched itself after the installation");
  const m = () => { try { return readManifest(layoutFor(path.join(dataDir, "managed"))); } catch { return null; } };
  expect(await waitFor(async () => { const mm = m(); return mm && mm.state === "ready" && !(await isPortFree(mm.postgres.port)); }, 40000), "the relaunched application started the dedicated PostgreSQL");
  stopProcessesFrom(installDir); // the relaunched app cannot be attached to: stop it (its PostgreSQL is stopped below by the test)
  await sleep(1500);
  const lay = layoutFor(path.join(dataDir, "managed"));
  const rt = path.join(lay.root, m().postgres.runtimeDir);
  try { stopCluster({ layout: lay, runtimeDir: rt, mode: "fast" }); } catch { /* not running */ }
  await sleep(500);
}

try {
  // ------------------------------------------------------------------------------------------------ the installer payload
  await test("APP-01.the_installer_carries_the_tested_package_and_the_pinned_postgresql_and_no_secret_or_user_data", "security", async () => {
    const x = spawnSync(SEVEN_ZIP, ["x", INSTALLER, "-o" + installDir, "-y"], { encoding: "utf8", maxBuffer: 1 << 26 });
    expect(fs.existsSync(exe), "Beauty POS.exe extracted (7za exit " + x.status + ")");
    expect(fs.readFileSync(path.join(installDir, "resources", "app.asar")).equals(fs.readFileSync(UNPACKED_ASAR)), "app.asar is byte-identical to the one the other suites test");
    const bundle = path.join(installDir, "resources", "postgresql");
    const bm = readBundleManifest(bundle);
    expect(bm.sourceSha256 === pin.sha256 && bm.version === pin.version, "the bundled PostgreSQL is the pinned one");
    const bad = verifyTree(bundle, bm);
    expect(bad.length === 0, "all " + bm.fileCount + " PostgreSQL files in the installer match their hashes: " + bad.slice(0, 2).join("; "));
    const all = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : all.push(f); } };
    walk(installDir);
    const names = all.map((f) => path.basename(f).toLowerCase());
    for (const forbidden of [".env", "config.json", "installation.json", "cluster-admin.json", "estetica-leal-managed.json", "pg_hba.conf", "postgresql.conf"]) expect(!names.includes(forbidden), forbidden + " is not in the installer");
    const textHits = all.filter((f) => !f.includes(path.sep + "postgresql" + path.sep) && /\.(json|txt|cmd|ps1|md|js|cjs|html)$/i.test(f) && fs.statSync(f).size < 4e6 && containsSecret(fs.readFileSync(f, "utf8")));
    expect(textHits.length === 0, "no connection string or database password in the plain-text files: " + textHits.map((f) => path.relative(installDir, f)).join(","));
    expect(!fs.readFileSync(path.join(installDir, "resources", "app.asar")).includes(Buffer.from(ADMIN_PIN)), "no PIN of this run in the package");
    return `${(fs.statSync(INSTALLER).size / 1048576).toFixed(0)} MB installer, PostgreSQL ${bm.version}`;
  });

  // ------------------------------------------------------------------------------------------------ first installation: demonstration
  await test("APP-02.first_start_shows_the_installation_wizard_with_the_checks_and_nothing_of_the_application", "integration", async () => {
    L = await launchInstalled(userData);
    page = L.page;
    await page.locator("#btn-install").waitFor({ timeout: 30000 });
    await page.locator("#checks li.ok").first().waitFor({ timeout: 20000 });
    const text = (await page.locator("#checks").innerText()).replace(/\s+/g, " ");
    expect(/Windows .* de 64 bits/.test(text) && /PostgreSQL .* incluido en el instalador/.test(text) && /Puerto \d+ libre/.test(text), "preflight shown: " + text);
    expect(await page.locator("#btn-install").isEnabled(), "install is enabled when the checks pass");
    expect(await page.evaluate(() => typeof window.api) === "undefined" && await page.evaluate(() => typeof window.setupApi) === "undefined", "the wizard has no application API");
    expect(/Estética Leal/.test(await page.title()), "identity: " + (await page.title()));
    expect(!fs.existsSync(path.join(userData, "config.json")) && !fs.existsSync(path.join(userData, "managed")), "nothing is created before the person decides");
  });
  await test("APP-03.mismatched_or_invalid_pins_are_refused_by_the_wizard_before_anything_is_created", "security", async () => {
    await page.locator("#admin-pin-d").fill(ADMIN_PIN);
    await page.locator("#admin-pin-d2").fill(ADMIN_PIN.slice(0, 5) + (ADMIN_PIN[5] === "1" ? "2" : "1"));
    await page.locator("#vendor-pin").fill(VENDOR_PIN);
    await page.locator("#vendor-pin2").fill(VENDOR_PIN);
    await page.locator("#btn-install").click();
    await page.getByText("Los PIN repetidos no coinciden.").waitFor({ timeout: 5000 });
    await page.locator("#admin-pin-d2").fill(ADMIN_PIN);
    await page.locator("#vendor-pin").fill(ADMIN_PIN);
    await page.locator("#vendor-pin2").fill(ADMIN_PIN);
    await page.locator("#btn-install").click();
    await page.locator("#msg.err").waitFor({ timeout: 20000 });
    expect(/distintos/.test(await page.locator("#msg").innerText()), "equal PINs refused: " + (await page.locator("#msg").innerText()));
    expect(!fs.existsSync(path.join(userData, "managed", "data")), "no cluster was created");
    await page.locator("#vendor-pin").fill(VENDOR_PIN);
    await page.locator("#vendor-pin2").fill(VENDOR_PIN);
  });
  await test("APP-04.the_wizard_installs_the_demonstration_with_visible_steps_and_the_application_restarts_itself", "e2e", async () => {
    for (const [id, v] of [["#admin-pin-d", ADMIN_PIN], ["#admin-pin-d2", ADMIN_PIN], ["#vendor-pin", VENDOR_PIN], ["#vendor-pin2", VENDOR_PIN]]) await page.locator(id).fill(v); // cleared after every attempt
    await page.locator("#btn-install").click();
    await page.getByText("Listo. Estética Leal POS se reiniciará para empezar.").waitFor({ timeout: 180000 });
    const steps = (await page.locator("#steps").innerText()).replace(/\s+/g, " ");
    for (const s of ["Comprobaciones previas", "Copiando y verificando PostgreSQL", "Creando la instancia de PostgreSQL", "Iniciando PostgreSQL", "Guardando la configuración protegida", "Verificando la instalación"]) expect(steps.includes("Listo: " + s), "step reported: " + s);
    expect(!L.mainLog.some((x) => x.includes(ADMIN_PIN) || x.includes(VENDOR_PIN) || containsSecret(x)), "no PIN or password in the application's log");
    await waitForWizardRelaunch(userData, L);
  });
  await test("APP-05.the_installation_left_protected_credentials_a_restricted_folder_and_no_secret_in_clear", "security", async () => {
    L = await launchInstalled(userData);
    page = L.page;
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 60000 });
    const managed = path.join(userData, "managed");
    const cfgRaw = fs.readFileSync(path.join(userData, "config.json"), "utf8");
    const admRaw = fs.readFileSync(path.join(managed, "cluster-admin.json"), "utf8");
    const s = await secretsFrom(L, userData);
    expect(s.cfg.version === 2 && typeof s.cfg.passwordEncrypted === "string" && s.cfg.host === "127.0.0.1" && s.cfg.database === "beauty_pos_demo" && s.cfg.user === "pos_demo_runtime", "config.json: protected v2 for the demo runtime role");
    expect(!cfgRaw.includes(s.runtimePassword) && !admRaw.includes(s.adminPassword), "neither password is in clear on disk");
    expect(s.runtimePassword !== s.adminPassword && s.runtimePassword.length >= 24 && s.adminPassword.length >= 24, "two different long random passwords");
    const man = fs.readFileSync(path.join(managed, "installation.json"), "utf8");
    expect(!man.includes(s.adminPassword) && !man.includes(s.runtimePassword) && !man.includes(ADMIN_PIN), "manifest holds no secret");
    const textFiles = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!/[\\/](runtime|data|backups)$/.test(f)) walk(f); } else if (/\.(log|json|txt)$/i.test(f)) textFiles.push(f); } };
    walk(managed);
    const leaked = textFiles.filter((f) => [s.adminPassword, s.runtimePassword, ADMIN_PIN, VENDOR_PIN].some((x) => fs.readFileSync(f, "utf8").includes(x)));
    expect(leaked.length === 0, "no secret in the logs: " + leaked.join(","));
    const acl = spawnSync(PS, ["-NoProfile", "-Command", "$a = Get-Acl -LiteralPath $env:D; ($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) -join ','"], { env: neutralEnv({ D: managed }), encoding: "utf8" }).stdout.trim().split(",");
    expect(acl.every((x) => ["S-1-5-18", "S-1-5-32-544", "S-1-3-4"].includes(x) || /^S-1-5-21-/.test(x)) && !acl.includes("S-1-1-0") && !acl.includes("S-1-5-32-545"), "only SYSTEM, Administrators and this account can open the folder: " + acl.length + " entries");
    const sec = new pg.Client({ connectionString: connectionUrl({ port: s.cfg.port, user: "pos_cluster_admin", password: s.adminPassword, database: "beauty_pos_demo" }) });
    await sec.connect();
    db = sec;
  });
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  await test("APP-06.demonstration_data_is_there_and_the_chosen_pins_are_the_only_ones_that_work", "integration", async () => {
    expect((await one("select count(*)::int n from products")).n === T.products && (await one("select count(*)::int n from sales")).n === T.sales && (await one("select count(*)::int n from returns")).n === T.returns, "dataset counts");
    const u = await q("select role, pin_hash from users order by role");
    expect(verifyModern(ADMIN_PIN, u[0].pin_hash) && verifyModern(VENDOR_PIN, u[1].pin_hash), "the PINs chosen in the wizard are the ones stored (hashed)");
    await page.getByRole("heading", { name: "Estética Leal" }).waitFor();
    await ui.login(page, ADMIN_PIN);
    await page.waitForURL(/#\/dashboard$/, { timeout: 15000 });
  });

  // ------------------------------------------------------------------------------------------------ the presentation on the dedicated instance
  await test("APP-07.history_reports_inventory_and_cash_history_work_on_the_dedicated_instance", "e2e", async () => {
    const today = new Date();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const from = new Date(today); from.setDate(from.getDate() - 3);
    const sum = await ipc(page, `api.reports.getSummary({from:'${iso(from)}',to:'${iso(today)}'})`);
    expect(sum.ok && sum.v.sales.count === T.sales && cents(sum.v.sales.total) === T.cashSalesCents + T.cardSalesCents, "report totals");
    await ui.nav(page, "Productos");
    await page.getByRole("row", { name: /DEMO-SH-500/ }).waitFor({ timeout: 10000 });
    await ui.nav(page, "Historial");
    await page.getByTestId("history-summary").waitFor({ timeout: 10000 });
    await ui.nav(page, "Caja");
    await page.getByRole("link", { name: "Historial de sesiones" }).click();
    await page.getByTestId("cash-history-summary").waitFor({ timeout: 10000 });
    await page.getByText("-$5.00", { exact: true }).waitFor({ timeout: 10000 });
  });
  let liveSale;
  await test("APP-08.sales_refunds_pending_refund_and_cash_close_reconcile_on_the_dedicated_instance", "e2e", async () => {
    const sh = productBySku("DEMO-SH-500"), ge = productBySku("DEMO-GE-250");
    const adminId = (await one("select id from users where role='admin'")).id;
    await ui.openCash(page, 50);
    await ui.sell(page, { query: sh.barcode, name: "Shampoo Hidratante", qty: 1, method: "card" });
    await ui.sell(page, { query: "Gel Fijador", name: "Gel Fijador", qty: 2, method: "cash" });
    liveSale = await one("select id, total::text t from sales order by id desc limit 1");
    expect(cents(liveSale.t) === ge.cents * 2, "cash sale total " + liveSale.t);
    await ui.nav(page, "Devoluciones");
    await page.getByLabel("Número de venta").fill(String(liveSale.id));
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByLabel("Cantidad a devolver de Gel Fijador 250 ml").fill("1");
    await page.getByLabel("Motivo", { exact: true }).fill("Prueba del instalador");
    await page.locator("#rf-method-cash").click();
    await page.locator("#rf-confirm").check();
    await page.getByRole("button", { name: "Confirmar devolución y reembolso" }).click();
    await page.getByRole("dialog").locator("#rf-admin-pin").fill(ADMIN_PIN);
    await page.getByRole("button", { name: "Autorizar y registrar" }).click();
    await page.getByTestId("return-result").getByText(/PAGADO EN EFECTIVO/).waitFor({ timeout: 10000 });
    const r1 = await one("select r.refund_status s, st.amount::text a, st.authorized_by ab from returns r join refund_settlements st on st.return_id=r.id where r.sale_id=$1", [liveSale.id]);
    expect(r1.s === "paid" && cents(r1.a) === ge.cents && r1.ab === adminId, "refund paid in cash, authorised by the administrator");
    const pend = await one("select id from returns where refund_status='pending' order by id limit 1");
    await page.getByTestId(`pay-pending-${pend.id}`).click();
    await page.getByRole("dialog").getByText(`Registrar pago de la devolución #${pend.id}`).waitFor();
    await page.locator("#rp-method-cash").click();
    await page.locator("#rp-confirm").check();
    await page.locator("#rf-admin-pin").fill(ADMIN_PIN);
    await page.getByRole("button", { name: "Autorizar y registrar pago", exact: true }).click();
    expect(await waitFor(async () => (await one("select refund_status s from returns where id=$1", [pend.id])).s === "paid", 10000), "the pending refund is paid");
    await ui.nav(page, "Caja");
    const expected = await ui.closeCash(page);
    expect(cents(expected) === 5000 + ge.cents * 2 - ge.cents - T.pendingCents, "the closing dialog expected " + expected + " (reconciles with sales, refund and pending refund)");
    expect(L.consoleErrors.filter((e) => !/favicon/i.test(e)).length === 0, "no console error: " + JSON.stringify(L.consoleErrors));
  });
  await test("APP-09.closing_the_application_stops_the_dedicated_postgresql_and_reopening_starts_it_with_the_data_intact", "e2e", async () => {
    const managed = path.join(userData, "managed");
    const lay = layoutFor(managed);
    const rt = path.join(managed, readManifest(lay).postgres.runtimeDir);
    expect(clusterRunning(lay, rt), "running while the application is open");
    await db.end().catch(() => {});
    await closeApp(L);
    expect(await waitFor(async () => !clusterRunning(lay, rt) && processesFrom(managed, "postgres.exe") === 0, 30000), "no postgres.exe left after closing the application");
    L = await launchInstalled(userData);
    page = L.page;
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 60000 });
    expect(clusterRunning(lay, rt), "started again by the application");
    const s = await secretsFrom(L, userData);
    db = new pg.Client({ connectionString: connectionUrl({ port: s.cfg.port, user: "pos_cluster_admin", password: s.adminPassword, database: "beauty_pos_demo" }) });
    await db.connect();
    expect((await one("select count(*)::int n from sales")).n === T.sales + 2, "all sales, including this session's, persisted");
    await ui.login(page, VENDOR_PIN);
    await page.waitForURL(/#\/sales$/, { timeout: 15000 });
    expect(await page.locator("nav").getByRole("link", { name: "Reportes" }).count() === 0, "the vendor still sees only the selling screens");
  });
  await test("APP-10.the_application_and_the_database_only_talk_over_loopback_no_internet_traffic", "security", async () => {
    const out = spawnSync(PS, ["-NoProfile", "-Command", "$ids = (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:D, [StringComparison]::OrdinalIgnoreCase) }).ProcessId; Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.State -ne 'Listen' -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') } | ForEach-Object { $_.RemoteAddress + ':' + $_.RemotePort }"], { env: neutralEnv({ D: scratch + path.sep }), encoding: "utf8" }).stdout.trim();
    expect(out === "", "no connection to anything outside this computer: " + out);
  });

  // ------------------------------------------------------------------------------------------------ a failing installation and its retry (UI)
  await test("APP-11.a_tampered_postgresql_package_makes_the_wizard_fail_safely_name_the_step_and_a_retry_works", "security", async () => {
    await db.end().catch(() => {});
    await closeApp(L);
    const target = path.join(installDir, "resources", "postgresql", "bin", "pg_ctl.exe");
    const original = fs.readFileSync(target);
    fs.appendFileSync(target, "x");
    try {
      L = await launchInstalled(userData2);
      page = L.page;
      await page.locator("#btn-install").waitFor({ timeout: 30000 });
      await page.locator("#mode-clean").check();
      await page.locator("#admin-name").fill("Persona Administradora");
      await page.locator("#admin-pin-c").fill(CLEAN_PIN);
      await page.locator("#admin-pin-c2").fill(CLEAN_PIN);
      await page.locator("#btn-install").click();
      await page.locator("#msg.err").waitFor({ timeout: 60000 });
      const msg = await page.locator("#msg").innerText();
      expect(/paso "Comprobaciones previas|Copiando y verificando/.test(msg) && /no coincide|alterad|huella/i.test(msg), "the failing step and reason are shown: " + msg);
      await page.locator("#btn-retry").waitFor();
      expect(!fs.existsSync(path.join(userData2, "managed", "data")) && !fs.existsSync(path.join(userData2, "managed", "runtime", pin.version)) && !fs.existsSync(path.join(userData2, "config.json")), "nothing usable was left behind");
      expect(processesFrom(path.join(userData2, "managed"), "postgres.exe") === 0, "no postgres process left");
      expect(!msg.includes(CLEAN_PIN) && !L.mainLog.some((x) => x.includes(CLEAN_PIN)), "the PIN appears nowhere");
    } finally {
      fs.writeFileSync(target, original);
    }
    expect(verifyTree(path.join(installDir, "resources", "postgresql"), readBundleManifest(path.join(installDir, "resources", "postgresql")), { only: ["bin/pg_ctl.exe"] }).length === 0, "the package is restored");
  });
  await test("APP-12.clean_installation_through_the_wizard_has_one_administrator_and_no_demonstration_data", "e2e", async () => {
    await page.locator("#btn-retry").click();
    await page.locator("#admin-pin-c").fill(CLEAN_PIN); // the wizard clears PINs after every attempt
    await page.locator("#admin-pin-c2").fill(CLEAN_PIN);
    await page.locator("#btn-install").click();
    await page.getByText("Listo. Estética Leal POS se reiniciará para empezar.").waitFor({ timeout: 180000 });
    await waitForWizardRelaunch(userData2, L);
    L = await launchInstalled(userData2);
    page = L.page;
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 60000 });
    const s = await secretsFrom(L, userData2);
    expect(s.cfg.database === "estetica_leal_pos" && s.cfg.user === "pos_leal_runtime", "clean database and role");
    const c = new pg.Client({ connectionString: connectionUrl({ port: s.cfg.port, user: "pos_cluster_admin", password: s.adminPassword, database: "estetica_leal_pos" }) });
    await c.connect();
    const n = (await c.query("select (select count(*) from users)::int u, (select count(*) from products)::int p, (select count(*) from sales)::int s, (select count(*) from cash_sessions)::int cs")).rows[0];
    await c.end();
    expect(n.u === 1 && n.p === 0 && n.s === 0 && n.cs === 0, "only the administrator: " + JSON.stringify(n));
    await ui.login(page, CLEAN_PIN);
    await page.waitForURL(/#\/dashboard$/, { timeout: 15000 });
    await ui.nav(page, "Productos");
    await page.locator("h1,h2").first().waitFor();
    expect(await page.getByRole("row", { name: /DEMO-/ }).count() === 0, "no fictional product on screen");
    const wrong = await ipc(page, "api.users.getAll()");
    expect(wrong.ok === true && wrong.v.length === 1 && wrong.v[0].name === "Persona Administradora", "the administrator is the only user");
    await closeApp(L);
    expect(await waitFor(async () => processesFrom(path.join(userData2, "managed"), "postgres.exe") === 0, 30000), "PostgreSQL stopped with the application");
  });

  // ------------------------------------------------------------------------------------------------ 0.7.0-style and external connections
  await test("APP-13.an_existing_config_json_or_an_explicit_external_connection_never_triggers_the_wizard_nor_creates_a_managed_instance", "integration", async () => {
    // an external PostgreSQL = a cluster provisioned by the test itself, outside the application
    extRoot = path.join(scratch, "external");
    let conn;
    const ext = await provisionManagedInstance({
      root: extRoot, bundleDir: path.join(ROOT, "vendor", "pg-bundle"), migrationsDir: path.join(ROOT, "drizzle"), mode: "clean", input: { adminName: "Externo", adminPin: randomPin() },
      persist: async ({ connection }) => { conn = connection; }, portFirst: 56400, portLast: 56420,
    });
    extCleanup = () => { try { stopCluster({ layout: ext.layout, runtimeDir: path.join(extRoot, ext.manifest.postgres.runtimeDir), mode: "immediate" }); } catch { /* ignore */ } };
    L = await launchInstalled(userData3);
    page = L.page;
    await page.locator("#btn-advanced").waitFor({ timeout: 30000 });
    const setupOpened = L.app.waitForEvent("window", { timeout: 20000 });
    await page.locator("#btn-advanced").click();
    const setup = await setupOpened;
    await setup.locator("#btn-test").waitFor({ timeout: 20000 });
    await setup.locator("#host").fill(conn.host);
    await setup.locator("#port").fill(String(conn.port));
    await setup.locator("#database").fill(conn.database);
    await setup.locator("#user").fill(conn.user);
    await setup.locator("#password").fill(conn.password);
    await setup.locator("#btn-test").click();
    await setup.getByText(/Esquema al día: \d+ de \d+ migraciones/).waitFor({ timeout: 20000 });
    await setup.locator("#btn-save").click();
    expect(await waitFor(async () => fs.existsSync(path.join(userData3, "config.json")), 15000), "config.json written by the advanced path");
    await Promise.race([new Promise((r) => L.app.process().once("exit", r)), sleep(20000)]);
    expect(await waitFor(async () => processesFrom(installDir, "Beauty POS.exe") > 0, 20000), "relaunched");
    stopProcessesFrom(installDir);
    await sleep(1500);
    // the next start: a configuration exists and there is no managed instance -> the regular path, no wizard
    L = await launchInstalled(userData3);
    page = L.page;
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 40000 });
    expect(await page.locator("#btn-install").count() === 0, "no wizard when a configuration exists");
    expect(!fs.existsSync(path.join(userData3, "managed")), "no managed instance was created next to an external connection");
    await closeApp(L);
  });
} catch (e) {
  fatal = e;
  rec("suite.unexpected_error", "FAIL", scrub(String(e.stack || e)).split("\n").slice(0, 3).join(" | ").slice(0, 400), { kind: "integration" });
} finally {
  for (const app of launched) { try { await app.close(); } catch { /* already closed */ } }
  try { await db?.end(); } catch { /* ignore */ }
  extCleanup?.();
  for (const d of [userData, userData2, userData3]) {
    try {
      const lay = layoutFor(path.join(d, "managed"));
      const m = readManifest(lay);
      if (m) stopCluster({ layout: lay, runtimeDir: path.join(lay.root, m.postgres.runtimeDir), mode: "immediate" });
    } catch { /* ignore */ }
  }
  stopProcessesFrom(scratch);
  await sleep(1000);
  stopProcessesFrom(scratch);
  await sleep(500);
  fs.rmSync(scratch, { recursive: true, force: true });
}
const { summary, exitCode } = summarize(results, fatal, { runId, suites: ["installer-app"] });
fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({ summary, results }, null, 1));
log("SUMMARY", JSON.stringify(summary));
log(`artifacts: ${artifacts}`);
process.exit(exitCode);
