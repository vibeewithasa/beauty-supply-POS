// Packaged-app smoke test: launches the REAL packaged executable (release/win-unpacked) against a throwaway
// database and drives the window through the UI. Build first:  npm run package:dir
//
// It never touches existing databases (same isolation rules as the other suites), uses a temporary --user-data-dir
// (never the user's profile), and never reads .env for the application: the app receives its configuration the way
// an installed one does (process environment or config.json).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import {
  ROOT, createRunDb, dropRunDb, connectRunDb, urlFor, makeData, createRecorder, summarize, scrub, sleep, waitFor, ui, ipc, expect, containsSecret,
} from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const EXE = path.join(ROOT, "release", "win-unpacked", "Beauty POS.exe");
if (!fs.existsSync(EXE)) {
  console.error("Packaged app not found. Run: npm run package:dir");
  process.exit(2);
}

const runId = Date.now().toString(36) + crypto.randomBytes(1).toString("hex");
const artifacts = path.join(ROOT, "e2e-artifacts", "packaged-" + runId);
fs.mkdirSync(artifacts, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pos-packaged-"));
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? scrub(x) : x)));

let runDb, db, page;
const launched = [];

function appEnv(extra = {}, withDb = true) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DATABASE_URL; // never inherit the project's own .env connection
  Object.assign(env, extra);
  if (withDb) env.DATABASE_URL = urlFor(runDb, "e2e_packaged");
  return env;
}
async function launch(env, { userDataDir = userData, wait = "app" } = {}) {
  const app = await _electron.launch({ executablePath: EXE, args: ["--user-data-dir=" + userDataDir], cwd: ROOT, env, timeout: 60000 });
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
// The credential part of the connection string ("scheme://user:password@"), never printed. The bare password is not
// searched on its own: a short local password appears by chance inside dependency docs and would be a false positive.
const exactSecret = (text) => {
  const u = new URL(urlFor("x"));
  return text.includes(`${u.protocol}//${u.username}:${u.password}@`) || text.includes(`${u.protocol}//${u.username}:${decodeURIComponent(u.password)}@`);
};
const close = async (l) => { try { await l.app.close(); } catch { /* already closed */ } };

const { results, rec, test } = createRecorder("packaged", artifacts, () => page, { log });
let fatal;
try {
  runDb = await createRunDb();
  db = await connectRunDb(runDb);
  log(`E2E packaged run ${runId} :: isolated database created: ${runDb}`);
  const data = makeData(db, runId + "p");
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];

  let L = await launch(appEnv());
  page = L.page;
  const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")).entries.length;
  const migrated = await waitFor(async () => (await db.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n >= journal, 25000);
  if (!migrated) throw new Error("the packaged app did not run its startup migrations");
  const admin = await data.user("PK_ADMIN", "admin", { modern: true });
  const vendor = await data.user("PK_VEND", "vendor");
  const product = await data.product("PK", 10, 20);

  await test("PK-00.window_loads_from_the_package_with_assets_preload_and_csp", "e2e", async () => {
    expect(/^file:\/\/\/.*app\.asar\/dist\/renderer\/index\.html/i.test(page.url().replace(/\\/g, "/")), "loaded from the asar: " + page.url());
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
    expect(await page.evaluate(() => typeof window.api?.auth?.login) === "function", "preload exposed window.api");
    expect(await page.evaluate(() => typeof require + typeof process) === "undefinedundefined", "no node globals in the renderer");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor !== ""), "stylesheet applied");
    const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || "");
    expect(/default-src 'self'/.test(csp) && !/unsafe-eval/.test(csp), "CSP present: " + csp);
    // Playwright evaluates with the CSP eval check bypassed, so prove the CSP with an injected inline script instead
    const inline = await page.evaluate(() => new Promise((resolve) => {
      let violated = false;
      document.addEventListener("securitypolicyviolation", () => { violated = true; }, { once: true });
      const s = document.createElement("script");
      s.textContent = "window.__inlineRan = true";
      document.head.appendChild(s);
      setTimeout(() => resolve({ ran: window.__inlineRan === true, violated }), 300);
    }));
    expect(inline.ran === false && inline.violated === true, "an injected inline script is blocked by the CSP: " + JSON.stringify(inline));
  });
  await test("PK-01.login_navigation_and_every_module_renders", "e2e", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 10000 });
    const modules = [["Vender", /#\/sales$/], ["Caja", /#\/cash$/], ["Productos", /#\/inventory$/], ["Recepción", /#\/receive$/], ["Devoluciones", /#\/returns$/], ["Ver Stock", /#\/stock$/], ["Reportes", /#\/reports$/], ["Usuarios", /#\/users$/], ["Dashboard", /#\/dashboard$/]];
    for (const [label, re] of modules) {
      await ui.nav(page, label);
      await page.waitForURL(re, { timeout: 6000 });
      await page.locator("h1,h2").first().waitFor({ timeout: 6000 });
    }
  });
  await test("PK-02.products_cash_sale_return_and_report_work_in_the_package", "e2e", async () => {
    await ui.nav(page, "Productos");
    await page.getByRole("button", { name: "Nuevo Producto" }).click();
    const d = page.getByRole("dialog");
    const sku = `PKG-${runId}`;
    await d.getByLabel("SKU", { exact: true }).fill(sku);
    await d.getByLabel("Nombre", { exact: true }).fill("Producto empaquetado");
    await d.getByLabel("Precio inicial").fill("8.00");
    await d.getByLabel("Stock inicial").fill("4");
    await d.getByRole("button", { name: "Crear producto" }).click();
    await page.getByRole("row", { name: new RegExp(sku) }).waitFor();
    expect((await one("select stock from products where sku=$1", [sku])).stock === 4, "product persisted in PostgreSQL");

    await ui.openCash(page, 50);
    await ui.sell(page, { query: product.sku, name: product.name, qty: 2, method: "cash" });
    const sale = await one("select id, total from sales order by id desc limit 1");
    expect(Number(sale.total) === 20, "sale persisted: " + sale.total);

    await ui.nav(page, "Devoluciones");
    await page.getByLabel("Número de venta").fill(String(sale.id));
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByLabel(`Cantidad a devolver de ${product.name}`).fill("1");
    await page.getByLabel("Motivo", { exact: true }).fill("Prueba empaquetada");
    await page.getByRole("button", { name: "Revisar devolución" }).click();
    await page.getByRole("button", { name: "Confirmar devolución" }).click();
    await page.getByTestId("return-result").getByText(/PENDIENTE DE REEMBOLSO/).waitFor();
    expect((await one("select refund_status from returns where sale_id=$1", [sale.id])).refund_status === "pending", "pending refund persisted");

    await ui.nav(page, "Reportes");
    await page.getByTestId("rp-count").waitFor();
    expect(Number((await page.getByTestId("rp-count").innerText())) >= 1, "report shows the sale");
    await ui.nav(page, "Caja");
    await ui.closeCash(page);
  });
  await test("PK-11.history_receipt_preview_and_settings_work_under_the_packaged_csp", "e2e", async () => {
    await page.evaluate(() => { window.__cspViolations = []; document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(e.violatedDirective + " " + e.blockedURI)); });
    const sale = await one("select id from sales order by id desc limit 1");
    await ui.nav(page, "Historial");
    await page.locator("#hs-q").fill(String(sale.id));
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByRole("button", { name: `Ver venta ${sale.id}` }).click();
    await page.getByRole("dialog").getByText(`Venta #${sale.id}`).first().waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Ver recibo" }).click();
    const frame = page.frameLocator('iframe[title="Vista previa del recibo"]');
    await frame.getByText("ESTÉTICA LEAL").waitFor({ timeout: 10000 });
    await frame.getByText("No es una factura fiscal").waitFor();
    await frame.getByText(`#${sale.id}`).first().waitFor();
    const viol = await page.evaluate(() => window.__cspViolations);
    expect(viol.length === 0, "no CSP violation while previewing the ticket: " + JSON.stringify(viol));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await ui.nav(page, "Configuración");
    await page.waitForFunction(() => document.querySelector("#bs-name")?.value === "Estética Leal", null, { timeout: 10000 });
    expect((await page.evaluate(() => window.__cspViolations)).length === 0, "no CSP violation on the settings screen");
  });
  // right after the flows: pooled connections are closed when idle for 10 s
  await test("PK-06.app_connects_only_to_the_throwaway_database", "integration", async () => {
    const apps = (await db.query("select distinct datname from pg_stat_activity where application_name='e2e_packaged'")).rows.map((r) => r.datname);
    expect(apps.length >= 1 && apps.every((n) => n === runDb), "packaged connections: " + apps.join(","));
  });
  await test("PK-03.shell_hardening_window_open_navigation_devtools_menu_permissions", "security", async () => {
    const before = L.app.windows().length;
    const opened = await page.evaluate(() => { const w = window.open("https://example.com"); return w === null ? "null" : "window"; });
    await sleep(500);
    expect(opened === "null" && L.app.windows().length === before, `window.open denied: ${opened}, windows ${before}->${L.app.windows().length}`);
    const url0 = page.url();
    await page.evaluate(() => { location.href = "https://example.com/"; }).catch(() => {});
    await sleep(800);
    expect(page.url() === url0, "external navigation blocked: " + page.url());
    // the blocked attempt must leave a working window (Playwright otherwise keeps waiting for the cancelled navigation)
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("button", { name: "Salir" }).waitFor({ timeout: 10000 });
    const shell = await L.app.evaluate(async ({ BrowserWindow, Menu }) => {
      const w = BrowserWindow.getAllWindows()[0];
      try { w.webContents.openDevTools(); } catch { /* disabled */ }
      return { dev: w.webContents.isDevToolsOpened(), menu: Menu.getApplicationMenu() === null };
    });
    expect(shell.dev === false, "DevTools cannot be opened in the package");
    expect(shell.menu === true, "application menu removed");
    const perm = await page.evaluate(async () => (await Notification.requestPermission()));
    expect(perm !== "granted", "permissions denied: " + perm);
  });
  await test("PK-04.vendor_isolation_and_ipc_authorization_hold_in_the_package", "security", async () => {
    await ui.logout(page).catch((e) => { throw new Error(String(e.message).replace(/\s+/g, " ").slice(0, 700)); });
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    const denied = await ipc(page, "api.products.listAdmin()");
    expect(denied.ok === false && /Sesi[oó]n no v[aá]lida/.test(denied.err), "no session -> rejected: " + JSON.stringify(denied));
    await ui.login(page, vendor.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 10000 });
    const r = await ipc(page, "api.reports.getSummary({from:'2026-01-01',to:'2026-01-02'})");
    expect(r.ok === false && /No autorizado/.test(r.err), "vendor rejected for admin channel: " + JSON.stringify(r));
    expect(await page.locator("nav").getByRole("link", { name: "Reportes" }).count() === 0, "vendor has no Reportes link");
  });
  await test("PK-05.package_contains_no_credentials_or_env_files", "security", async () => {
    const asar = path.join(ROOT, "release", "win-unpacked", "resources", "app.asar");
    const files = require("@electron/asar").listPackage(asar);
    expect(!files.some((f) => /(^|[\\/])\.env($|\.)/.test(f) && !/example/.test(f)), ".env must not be packaged");
    expect(files.some((f) => /dist[\\/]renderer[\\/]index\.html$/.test(f)) && files.some((f) => /drizzle[\\/]0006/.test(f)), "renderer and migrations are packaged");
    // exact secrets are looked for everywhere in the asar (dependencies' docs contain generic example URLs, so the
    // credential-URL pattern is only applied to the application's own bundles)
    const bytes = fs.readFileSync(asar).toString("latin1");
    expect(!exactSecret(bytes), "the asar does not contain the connection credentials");
    const asarApi = require("@electron/asar");
    const own = files
      .filter((f) => /dist[\\/]/.test(f) && /\.(cjs|js|html|css)$/.test(f))
      .map((f) => asarApi.extractFile(asar, f.replace(/^[\\/]/, "")).toString("utf8"))
      .join("\n");
    expect(own.length > 1000 && !exactSecret(own) && !/postgres(?:ql)?:\/\/[^\s"'`:@/]+:[^\s"'`@]+@/.test(own), "the app's own bundles contain no credential-bearing URL");
    expect(!/localhost\/updates/.test(own), "the placeholder update feed is gone");
  });

  // close and reopen: data persists, the session does not
  await close(L);
  await sleep(500);
  L = await launch(appEnv());
  page = L.page;
  await test("PK-07.close_and_reopen_keeps_data_and_requires_a_new_login", "e2e", async () => {
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 10000 });
    await ui.nav(page, "Productos");
    await page.getByRole("row", { name: new RegExp(`PKG-${runId}`) }).waitFor({ timeout: 8000 });
    await ui.logout(page);
  });
  await close(L);

  // configuration sources
  await test("PK-08.config_json_in_user_data_supplies_the_connection_without_environment", "integration", async () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "pos-packaged-cfg-"));
    fs.writeFileSync(path.join(ud, "config.json"), JSON.stringify({ databaseUrl: urlFor(runDb, "e2e_packaged") }));
    const l = await launch(appEnv({}, false), { userDataDir: ud });
    try {
      await l.page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
      expect(!l.mainLog.some((x) => containsSecret(x)), "no secret in the main log");
    } finally { await close(l); fs.rmSync(ud, { recursive: true, force: true }); }
  });
  await test("PK-09.without_configuration_the_app_refuses_to_start_and_never_reads_dot_env", "security", async () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "pos-packaged-nocfg-"));
    // cwd is the project root, which has a real .env: a packaged app must ignore it
    const l = await launch(appEnv({}, false), { userDataDir: ud });
    try {
      await l.page.getByRole("heading", { name: "Falta la configuración de la base de datos" }).waitFor({ timeout: 15000 });
      expect(await l.page.evaluate(() => typeof window.api) === "undefined", "the failure window has no preload/IPC");
      expect(!l.mainLog.some((x) => containsSecret(x)), "no secret in the main log");
    } finally { await close(l); fs.rmSync(ud, { recursive: true, force: true }); }
  });
  await test("PK-10.non_local_database_host_is_refused", "security", async () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "pos-packaged-remote-"));
    const remote = urlFor(runDb, "e2e_packaged").replace(/@[^/]+\//, "@192.0.2.10:5432/");
    const l = await launch(appEnv({ DATABASE_URL: remote }, false), { userDataDir: ud });
    try {
      await l.page.getByRole("heading", { name: "Falta la configuración de la base de datos" }).waitFor({ timeout: 15000 });
      await l.page.getByText(/no es local/).waitFor({ timeout: 3000 });
    } finally { await close(l); fs.rmSync(ud, { recursive: true, force: true }); }
  });
} catch (e) {
  fatal = e;
  rec("suite.unexpected_error", "FAIL", scrub(String(e.stack || e)).split("\n").slice(0, 3).join(" | ").slice(0, 400), { kind: "integration" });
} finally {
  for (const app of launched) { try { await app.close(); } catch { /* already closed */ } }
  try { await db?.end(); } catch { /* ignore */ }
  if (runDb) { try { await dropRunDb(runDb); log(`isolated database dropped: ${runDb}`); } catch (e) { log("could not drop " + runDb + ": " + e.message); } }
  fs.rmSync(userData, { recursive: true, force: true });
}
const { summary, exitCode } = summarize(results, fatal, { runId, suites: ["packaged"] });
fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({ summary, results }, null, 1));
log("SUMMARY", JSON.stringify(summary));
log(`artifacts: ${artifacts}`);
process.exit(exitCode);
