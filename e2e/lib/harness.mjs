// Shared harness for the Electron test suites (unit tests live in e2e/unit).
//
// Isolation: every run creates its OWN throwaway database (beauty_pos_e2e_<id>)
// on the local server named by DATABASE_URL. Existing databases are never
// written to, overwritten or dropped; only the database created by this run can
// be dropped, and only after its name matches a strict pattern. The Electron
// app receives DATABASE_URL via its process environment (dotenv does not
// override it) and creates the schema through its own startup migrations.
//
// Secrets: the connection string is read from .env at runtime and is never
// printed. Test users get random PINs that live in memory only.
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";
import net from "node:net";
import { _electron } from "playwright-core";
export { createRecorder, expect, summarize, ExpectationError } from "./recorder.mjs";

const { Client } = pg;
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_URL = "http://localhost:5173";
const DB_PREFIX = "beauty_pos_e2e_";
const DB_PATTERN = /^beauty_pos_e2e_[a-z0-9]+$/;

dotenv.config({ path: path.join(ROOT, ".env") });
const baseConn = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL;
if (!baseConn) throw new Error("DATABASE_URL (or E2E_DATABASE_URL) is required to locate the local PostgreSQL server");
const base = new URL(baseConn);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname)) {
  throw new Error("Refusing to run: the E2E suites only operate against a local PostgreSQL server");
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Removes the connection string / password from anything that gets logged or written to disk. */
export function scrub(text) {
  let t = String(text);
  for (const secret of [baseConn, decodeURIComponent(base.password || ""), base.password || ""]) if (secret && secret.length > 2) t = t.split(secret).join("***");
  return t.replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
}
export const money = (v) => Number(Number(v).toFixed(2));
export function urlFor(db, appName) {
  const x = new URL(base);
  x.pathname = "/" + db;
  if (appName) x.searchParams.set("application_name", appName);
  return x.toString();
}
export async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { last = false; }
    await sleep(150);
  }
  return last;
}

// ---------------------------------------------------------------- run database
const created = new Set();
export async function createRunDb() {
  const name = DB_PREFIX + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
  if (!DB_PATTERN.test(name)) throw new Error("bad generated db name");
  const admin = new Client({ connectionString: urlFor("postgres", "e2e_admin") });
  await admin.connect();
  try {
    const addr = (await admin.query("select inet_server_addr()::text a")).rows[0].a;
    if (!addr || !/^(127\.0\.0\.1|::1)(\/\d+)?$/.test(addr)) throw new Error("refusing to create a database: server address is not loopback (" + addr + ")");
    const exists = await admin.query("select 1 from pg_database where datname=$1", [name]);
    if (exists.rowCount) throw new Error("database already exists: " + name);
    await admin.query(`CREATE DATABASE "${name}"`);
    created.add(name);
  } finally { await admin.end(); }
  return name;
}
export async function dropRunDb(name) {
  if (!created.has(name) || !DB_PATTERN.test(name)) throw new Error("refusing to drop a database this run did not create: " + name);
  const admin = new Client({ connectionString: urlFor("postgres", "e2e_admin") });
  await admin.connect();
  try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); created.delete(name); } finally { await admin.end(); }
}
/** Verification connection. Proves current_database() before anything is written. */
export async function connectRunDb(name) {
  const db = new Client({ connectionString: urlFor(name, "e2e_verifier") });
  await db.connect();
  const cur = (await db.query("select current_database() d")).rows[0].d;
  if (cur !== name || !DB_PATTERN.test(cur)) { await db.end(); throw new Error("isolation check failed: connected to " + cur); }
  return db;
}

// ---------------------------------------------------------------- dev servers
function killTree(child) {
  if (!child || child.killed || child.pid == null) return;
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}
const listening = (port, host) => new Promise((resolve) => {
  const sock = net.connect({ port, host });
  sock.setTimeout(700);
  sock.once("connect", () => { sock.destroy(); resolve(true); });
  sock.once("timeout", () => { sock.destroy(); resolve(false); });
  sock.once("error", () => resolve(false));
});
function listenerPid(port) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: "utf8" });
  return Number(String(r.stdout).trim()) || null;
}
/**
 * The Electron app hardcodes http://localhost:5173, so the suite needs that port. It starts its OWN Vite and
 * proves ownership (the listener PID is the spawned child). If anything already listens there it fails
 * explicitly: a foreign server is never reused and never killed.
 */
export async function ensureVite() {
  for (const host of ["127.0.0.1", "::1"]) {
    if (await listening(5173, host)) throw new Error(`port 5173 is already in use on ${host}; stop that server first (the suite never reuses or kills foreign processes)`);
  }
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", "5173", "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  const stop = () => killTree(child);
  try {
    const up = async () => fetch(APP_URL).then((r) => r.status === 200 ? r.text() : false).catch(() => false);
    const html = await waitFor(up, 30000);
    if (!html) throw new Error("Vite did not start on 5173");
    const pid = listenerPid(5173);
    if (!pid || pid !== child.pid) throw new Error(`ownership check failed: listener pid ${pid} is not the spawned Vite (${child.pid})`);
    if (!html.includes("/src/renderer/main.tsx")) throw new Error("served page is not this project's renderer");
  } catch (e) { stop(); throw e; }
  return { stop };
}
/** Records which databases the app's connections (application_name=e2e_app) actually reach. */
export async function startConnMonitor() {
  const c = new Client({ connectionString: urlFor("postgres", "e2e_monitor") });
  await c.connect();
  const seen = new Map();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const r = await c.query("select datname, count(*)::int n from pg_stat_activity where backend_type='client backend' and application_name='e2e_app' group by 1");
      for (const x of r.rows) seen.set(x.datname, (seen.get(x.datname) || 0) + 1);
    } catch {} finally { busy = false; }
  }, 100);
  return { seen, async stop() { clearInterval(timer); await sleep(150); await c.end().catch(() => {}); } };
}
export function buildMain() {
  const tsup = path.join(ROOT, "node_modules/tsup/dist/cli-default.js");
  for (const [entry, out] of [["src/main/main.ts", "dist/main"], ["src/preload/preload.ts", "dist/preload"]]) {
    const r = spawnSync(process.execPath, [tsup, entry, "--format", "cjs", "--out-dir", out, "--target", "node18", "--external", "electron,electron-updater"], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) throw new Error("tsup failed for " + entry + "\n" + (r.stdout || "") + (r.stderr || ""));
  }
}

// ---------------------------------------------------------------- Electron
export async function launchApp(runDb, db, artifacts) {
  const env = { ...process.env, DATABASE_URL: urlFor(runDb, "e2e_app") };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await _electron.launch({
    executablePath: path.join(ROOT, "node_modules/electron/dist/electron.exe"),
    args: ["."], cwd: ROOT, env, timeout: 60000,
  });
  const mainLog = [];
  const proc = app.process();
  for (const s of [proc.stdout, proc.stderr]) s && s.on("data", (b) => mainLog.push(...String(b).split(/\r?\n/).filter(Boolean)));
  try {
  const page = await waitFor(async () => app.windows().find((w) => w.url().startsWith(APP_URL)), 30000);
  if (!page) throw new Error("main window did not appear");
  const consoleErrors = [];
  const watch = (p) => {
    p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 240)); });
    p.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message.slice(0, 240)));
  };
  watch(page);
  const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")).entries.length;
  const migrated = await waitFor(async () => (await db.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n >= journal, 20000);
  if (!migrated) throw new Error("startup migrations did not complete in the run database");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  fs.mkdirSync(artifacts, { recursive: true });
  return { app, page, mainLog, consoleErrors, watch };
  } catch (e) { try { await app.close(); } catch {} throw e; }
}

// ---------------------------------------------------------------- synthetic data
export function makeData(db, runId) {
  const usedPins = new Set();
  const newPin = async () => {
    const existing = new Set((await db.query("select pin_hash from users")).rows.map((r) => r.pin_hash));
    for (;;) {
      const p = String(crypto.randomInt(0, 10000)).padStart(4, "0");
      if (!existing.has(sha256(p)) && !usedPins.has(p)) { usedPins.add(p); return p; }
    }
  };
  return {
    newPin,
    async user(label, role, { active = true } = {}) {
      const pin = await newPin();
      const name = `E2E_${runId}_${label}`;
      const r = await db.query("insert into users(name,pin_hash,role,active) values($1,$2,$3,$4) returning id", [name, sha256(pin), role, active]);
      return { id: r.rows[0].id, name, pin, role };
    },
    async product(label, price, stock) {
      const sku = `E2E-${runId}-${label}`;
      const name = `E2E ${runId} ${label}`;
      const r = await db.query("insert into products(sku,name,price,stock,category) values($1,$2,$3,$4,'E2E') returning id", [sku, name, String(price), stock]);
      return { id: r.rows[0].id, sku, name, price: Number(price) };
    },
  };
}

// ---------------------------------------------------------------- UI helpers
export const ui = {
  async login(page, pin) {
    for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
    await page.getByRole("button", { name: "Iniciar Sesión" }).click();
  },
  nav: (page, label) => page.getByRole("link", { name: label, exact: true }).click(),
  logout: (page) => page.getByRole("button", { name: "Salir" }).click(),
  statVal: (page, label) => page.evaluate((l) => {
    const el = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === l);
    return el && el.nextElementSibling ? el.nextElementSibling.textContent.trim() : null;
  }, label),
  /** Real UI sale. `query` is typed in the search box and the product row is clicked. */
  async sell(page, { query, name, qty = 1, method }) {
    await ui.nav(page, "Vender");
    await page.getByPlaceholder("Código, SKU o nombre...").fill(query);
    await page.getByRole("button", { name: new RegExp(name) }).first().click();
    if (qty > 1) await page.locator('input[type="number"]').first().fill(String(qty));
    await page.getByRole("button", { name: "Pagar" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("tab", { name: method === "cash" ? "Efectivo" : "Tarjeta" }).click();
    await dlg.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByRole("dialog").getByText("Venta Completada").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Nueva Venta" }).click();
  },
  async openCash(page, amount) {
    await ui.nav(page, "Caja");
    await page.getByText("No hay sesión de caja abierta").waitFor();
    await page.getByRole("button", { name: "Abrir Caja" }).click();
    const d = page.getByRole("dialog");
    await d.getByPlaceholder("Monto inicial").fill(String(amount));
    await d.getByRole("button", { name: "Abrir Caja" }).click();
    await page.getByText("Abierta", { exact: true }).waitFor();
  },
  async cashMovement(page, tab, amount, reason) {
    await page.getByRole("button", { name: "Registrar Movimiento" }).click();
    const d = page.getByRole("dialog");
    await d.getByRole("tab", { name: tab }).click();
    await d.getByPlaceholder("Monto").fill(String(amount));
    await d.getByPlaceholder("Razón del movimiento").fill(reason);
    await d.getByRole("button", { name: "Registrar" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  },
  /** Closes the cash session counting exactly what the dialog says is expected. */
  async closeCash(page) {
    await page.getByRole("button", { name: "Cerrar Caja" }).click();
    const d = page.getByRole("dialog");
    const expected = (await d.innerText()).match(/Total esperado: \$(-?\d+\.\d{2})/)?.[1];
    await d.getByPlaceholder("Monto real contado").fill(String(expected));
    await d.getByRole("button", { name: "Cerrar Caja" }).click();
    await page.getByText("No hay sesión de caja abierta").waitFor({ timeout: 6000 });
    return expected;
  },
};

/** Calls window.api.* from the renderer. Never used to fake a login. */
export async function ipc(page, expr) {
  return page.evaluate(async (e) => {
    try {
      const f = new Function("api", "return (async()=>" + e + ")()");
      return { ok: true, v: await f(window.api) };
    } catch (err) { return { ok: false, err: String((err && err.message) || err).slice(0, 300) }; }
  }, expr);
}
// Two distinct rejections: no/revoked session vs. authenticated but not allowed (role, untrusted origin).
export const unauthenticated = (r) => r.ok === false && /Sesi[oó]n no v[aá]lida/.test(r.err);
export const forbidden = (r) => r.ok === false && /No autorizado/.test(r.err);
export const denied = (r) => unauthenticated(r) || forbidden(r);
