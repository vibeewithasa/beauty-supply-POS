// A PostgreSQL instance that belongs to Estetica Leal POS alone (docs/SELF_CONTAINED_INSTALLER.md).
//
// This module is plain Node (no Electron) so the very same code runs in the application, in the tools and in the tests against a REAL
// PostgreSQL. It never touches a PostgreSQL it did not create: every destructive helper first proves ownership (see verifyOwnership).
//
//   layout        where everything lives under the managed root
//   preflight     what the machine looks like before anything is created
//   runtime       a verified copy of the bundled binaries, the folder PostgreSQL actually runs from
//   cluster       initdb / start / stop / status of the dedicated cluster (loopback only, SCRAM, no trust)
//   manifest      installation.json: the record of what this installer created
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const MANIFEST_SCHEMA = 1;
export const PORT_FIRST = 55432;
export const PORT_LAST = 55450;
export const SUPERUSER = "pos_cluster_admin";
export const MARKER_FILE = "estetica-leal-managed.json";
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 ** 3;
export const MIN_WINDOWS_BUILD = 17763; // Windows 10 1809
export const MANAGED_COMMENT_PREFIX = "estetica-leal-pos:managed:";

export class ManagedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ManagedError";
    this.code = code;
  }
}

const SYS32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const sys32 = (name) => path.join(SYS32, name);

// ------------------------------------------------------------------------------------------------ layout
export function layoutFor(root) {
  const r = path.resolve(root);
  return {
    root: r,
    manifest: path.join(r, "installation.json"),
    adminSecret: path.join(r, "cluster-admin.json"),
    runtimeBase: path.join(r, "runtime"),
    data: path.join(r, "data"),
    logs: path.join(r, "logs"),
    backups: path.join(r, "backups"),
    tmp: path.join(r, "tmp"),
  };
}
export const runtimeDirFor = (layout, version) => path.join(layout.runtimeBase, version);
const exe = (name) => name + ".exe";
export const toolPath = (runtimeDir, name) => path.join(runtimeDir, "bin", exe(name));
const posix = (p) => p.split(path.sep).join("/");

export function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** Replaces every known secret in a text (used on anything that is logged or shown). */
export function scrubSecrets(text, secrets) {
  let t = String(text ?? "");
  for (const s of secrets) if (s && String(s).length > 2) t = t.split(String(s)).join("***").split(encodeURIComponent(String(s))).join("***");
  return t.replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
}

// ------------------------------------------------------------------------------------------------ running tools
/** Environment for the PostgreSQL tools: English messages (we parse some), no inherited connection variables. */
function toolEnv(extra = {}) {
  const env = { ...process.env, LC_MESSAGES: "C", LANG: "C" };
  for (const k of ["DATABASE_URL", "PGPASSWORD", "PGUSER", "PGHOST", "PGPORT", "PGDATABASE", "PGSERVICE", "PGPASSFILE", "PGOPTIONS", "PGSSLMODE"]) delete env[k];
  return { ...env, ...extra };
}
function runTool(runtimeDir, name, args, { env = {}, timeout = 120000 } = {}) {
  const r = spawnSync(toolPath(runtimeDir, name), args, { env: toolEnv(env), encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), error: r.error };
}

// ------------------------------------------------------------------------------------------------ manifest
export function readManifest(layout) {
  let text;
  try {
    text = fs.readFileSync(layout.manifest, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new ManagedError("MANIFIESTO_ILEGIBLE", "No se pudo leer installation.json");
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new ManagedError("MANIFIESTO_INVALIDO", "installation.json está dañado");
  }
  const bad = !m || m.schema !== MANIFEST_SCHEMA || typeof m.installId !== "string" || !/^[0-9a-f-]{36}$/.test(m.installId) || !["provisioning", "ready", "failed"].includes(m.state) || typeof m.postgres?.port !== "number";
  if (bad) throw new ManagedError("MANIFIESTO_INVALIDO", "installation.json no tiene el formato esperado");
  return m;
}
/** Atomic write: a crash never leaves half a manifest. */
export function writeManifest(layout, manifest) {
  fs.mkdirSync(layout.root, { recursive: true });
  const tmp = layout.manifest + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, layout.manifest);
}
export function readMarker(layout) {
  try {
    return JSON.parse(fs.readFileSync(path.join(layout.data, MARKER_FILE), "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ Windows identity and permissions
let cachedSid = null;
export function currentUserSid() {
  if (cachedSid) return cachedSid;
  const r = spawnSync(sys32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const m = /"(S-1-[0-9-]+)"/.exec(String(r.stdout));
  if (r.status !== 0 || !m) throw new ManagedError("USUARIO_DESCONOCIDO", "No se pudo identificar la cuenta de Windows actual");
  cachedSid = m[1];
  return cachedSid;
}
const SID_SYSTEM = "S-1-5-18";
const SID_ADMINS = "S-1-5-32-544";

/** Removes inheritance and leaves full control to this user, SYSTEM and Administrators only. */
export function secureDirectory(dir) {
  const r = spawnSync(sys32("icacls.exe"), [dir, "/inheritance:r", "/grant:r", `*${currentUserSid()}:(OI)(CI)F`, `*${SID_SYSTEM}:(OI)(CI)F`, `*${SID_ADMINS}:(OI)(CI)F`], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new ManagedError("PERMISOS", "No se pudieron restringir los permisos de la carpeta de datos");
}
/** Language-independent audit (SIDs): who can access `target`? Returns { sids, protectedInheritance, extra } where extra is anyone not allowed. */
export function auditAcl(target) {
  const ps = "$a = Get-Acl -LiteralPath $env:POS_ACL_PATH; [pscustomobject]@{ protectedInheritance = $a.AreAccessRulesProtected; sids = @($a.Access | ForEach-Object { try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { [string]$_.IdentityReference } }) } | ConvertTo-Json -Compress";
  const r = spawnSync(sys32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, env: { ...process.env, POS_ACL_PATH: target } });
  if (r.status !== 0) throw new ManagedError("AUDITORIA_ACL", "No se pudieron leer los permisos de " + path.basename(target));
  const j = JSON.parse(r.stdout);
  const sids = [...new Set([].concat(j.sids))];
  const allowed = new Set([currentUserSid(), SID_SYSTEM, SID_ADMINS, "S-1-3-4"]);
  return { protectedInheritance: !!j.protectedInheritance, sids, extra: sids.filter((s) => !allowed.has(s)) };
}

// ------------------------------------------------------------------------------------------------ ports
/** A port is free only if it can be bound on loopback AND nothing accepts a connection there. */
export async function isPortFree(port, host = "127.0.0.1") {
  const bindable = await new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
  if (!bindable) return false;
  const answers = await new Promise((resolve) => {
    const c = net.connect({ port, host });
    const done = (v) => { c.destroy(); resolve(v); };
    c.setTimeout(700, () => done(false));
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
  });
  return !answers;
}
export async function choosePort({ first = PORT_FIRST, last = PORT_LAST, avoid = [] } = {}) {
  for (let p = first; p <= last; p++) {
    if (avoid.includes(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new ManagedError("SIN_PUERTO", `No hay ningún puerto libre entre ${first} y ${last} en este equipo`);
}

// ------------------------------------------------------------------------------------------------ preflight
export function freeBytes(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const s = fs.statfsSync(d);
  return Number(s.bavail) * Number(s.bsize);
}
export function windowsInfo() {
  const parts = os.release().split(".").map(Number);
  return { platform: process.platform, arch: process.arch, release: os.release(), build: parts[2] ?? 0 };
}
/** PostgreSQL services and listeners that belong to somebody else. Read-only: nothing is started, stopped or authenticated. */
export async function detectForeignPostgres() {
  const ps = "Get-CimInstance Win32_Service -Filter \"Name like '%postgres%' or DisplayName like '%postgres%'\" | ForEach-Object { [pscustomobject]@{ name = $_.Name; state = $_.State } } | ConvertTo-Json -Compress";
  const r = spawnSync(sys32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  let services = [];
  try {
    const t = String(r.stdout).trim();
    if (t) services = [].concat(JSON.parse(t));
  } catch { /* none readable: treat as none */ }
  return { services, port5432InUse: !(await isPortFree(5432)) };
}

/**
 * Everything the installer needs to know. `checks` is for the person; the booleans decide. Never throws for a normal "no": it reports.
 * { layout, bundleDir, minFreeBytes, portFirst, portLast }
 */
export async function preflight({ layout, bundleDir, minFreeBytes = DEFAULT_MIN_FREE_BYTES, portFirst = PORT_FIRST, portLast = PORT_LAST }) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  const win = windowsInfo();
  if (win.platform !== "win32") add("windows", "fail", "Estética Leal POS se instala en Windows.");
  else if (win.arch !== "x64") add("arch", "fail", `Este equipo es ${win.arch}: el instalador es para Windows de 64 bits (x64).`);
  else if (win.build < MIN_WINDOWS_BUILD) add("windows", "fail", `Windows ${win.release} es demasiado antiguo: se necesita Windows 10 (1809) o superior.`);
  else add("windows", "ok", `Windows ${win.release} de 64 bits.`);

  let free = null;
  try {
    free = freeBytes(layout.root);
    if (free < minFreeBytes) add("disk", "fail", `Espacio insuficiente: hay ${(free / 1024 ** 3).toFixed(1)} GB libres y se necesitan al menos ${(minFreeBytes / 1024 ** 3).toFixed(1)} GB.`);
    else add("disk", "ok", `${(free / 1024 ** 3).toFixed(1)} GB libres.`);
  } catch {
    add("disk", "warn", "No se pudo medir el espacio libre.");
  }

  let bundle = null;
  try {
    bundle = JSON.parse(fs.readFileSync(path.join(bundleDir, "postgresql-bundle.json"), "utf8"));
    add("bundle", "ok", `PostgreSQL ${bundle.version} incluido en el instalador.`);
  } catch {
    add("bundle", "fail", "Este instalador no trae el paquete de PostgreSQL (no se puede preparar la base de datos).");
  }

  let manifest = null;
  let existing = "none";
  try {
    manifest = readManifest(layout);
    if (manifest) existing = manifest.state;
  } catch (e) {
    existing = "damaged";
    add("existing", "fail", e.message + ". No se modifica nada automáticamente.");
  }
  if (existing === "ready") add("existing", "ok", `Ya hay una instalación de Estética Leal POS (${manifest.database?.mode === "demo" ? "demostración" : "limpia"}): se conservará.`);
  else if (existing === "provisioning" || existing === "failed") add("existing", "warn", "Quedó una instalación a medias de un intento anterior: se limpiará solo lo que ese intento creó.");
  else if (existing === "none" && fs.existsSync(layout.data) && fs.readdirSync(layout.data).length) {
    existing = "foreign-data";
    add("existing", "fail", "La carpeta de datos ya existe y no pertenece a este instalador. No se toca.");
  }

  const foreign = await detectForeignPostgres();
  if (foreign.services.length || foreign.port5432InUse) {
    add("foreign", "ok", "Hay otro PostgreSQL en este equipo" + (foreign.services.length ? ` (${foreign.services.map((s) => s.name).join(", ")})` : "") + ": no se usa ni se modifica; Estética Leal usa el suyo, aparte.");
  } else add("foreign", "ok", "No hay otro PostgreSQL instalado: se prepara el propio.");

  let port = manifest?.postgres?.port ?? null;
  try {
    if (existing !== "ready") {
      port = await choosePort({ first: portFirst, last: portLast });
      add("port", "ok", port === portFirst ? `Puerto ${port} libre.` : `El puerto ${portFirst} estaba ocupado: se usará el ${port}.`);
    } else add("port", "ok", `Puerto registrado: ${port}.`);
  } catch (e) {
    add("port", "fail", e.message);
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks, port, existing, manifest, bundle, foreign, freeBytes: free, windows: win };
}

// ------------------------------------------------------------------------------------------------ the verified runtime copy
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(posix(path.relative(dir, full)));
    }
  };
  walk(dir);
  return out.sort();
}
/** Verifies a folder against the bundle manifest (size, SHA-256 of every file, no extra files). Returns the list of problems. */
export function verifyTree(dir, bundleManifest, { deep = true, only = null } = {}) {
  const problems = [];
  const want = new Map(bundleManifest.files.map((f) => [f.path, f]));
  for (const f of bundleManifest.files) {
    if (only && !only.includes(f.path)) continue;
    const p = path.join(dir, ...f.path.split("/"));
    let st;
    try { st = fs.statSync(p); } catch { problems.push("falta " + f.path); continue; }
    if (st.size !== f.size) { problems.push("tamaño distinto: " + f.path); continue; }
    if (deep && sha256File(p) !== f.sha256) problems.push("hash distinto: " + f.path);
  }
  if (!only && deep) for (const f of listFiles(dir)) if (!want.has(f) && f !== "postgresql-bundle.json") problems.push("archivo extra: " + f);
  return problems;
}
export function readBundleManifest(bundleDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(bundleDir, "postgresql-bundle.json"), "utf8"));
  } catch {
    throw new ManagedError("SIN_PAQUETE", "No se encontró el paquete de PostgreSQL del instalador");
  }
}
export const KEY_FILES = ["bin/postgres.exe", "bin/pg_ctl.exe", "bin/initdb.exe", "bin/pg_controldata.exe", "bin/libpq.dll"];

/** Copies the bundle to <runtime>/<version> after verifying it, and verifies the copy. Returns { runtimeDir, created }. */
export function installRuntime(bundleDir, layout) {
  const bm = readBundleManifest(bundleDir);
  const bad = verifyTree(bundleDir, bm);
  if (bad.length) throw new ManagedError("PAQUETE_ALTERADO", "El paquete de PostgreSQL del instalador no coincide con su huella: " + bad.slice(0, 3).join("; "));
  const runtimeDir = runtimeDirFor(layout, bm.version);
  if (fs.existsSync(runtimeDir)) {
    if (!verifyTree(runtimeDir, bm).length) return { runtimeDir, created: false };
    if (clusterRunning(layout, runtimeDir)) throw new ManagedError("RUNTIME_EN_USO", "La copia de PostgreSQL está en uso y no coincide con el paquete: detén la instancia antes de reparar");
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
  fs.mkdirSync(layout.runtimeBase, { recursive: true });
  const partial = runtimeDir + ".partial";
  fs.rmSync(partial, { recursive: true, force: true });
  fs.cpSync(bundleDir, partial, { recursive: true });
  const copyBad = verifyTree(partial, bm);
  if (copyBad.length) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw new ManagedError("COPIA_INVALIDA", "La copia de PostgreSQL no se verificó: " + copyBad.slice(0, 3).join("; "));
  }
  fs.renameSync(partial, runtimeDir);
  return { runtimeDir, created: true, version: bm.version };
}
/** Cheap check done on every start: the executables that matter still are what was installed. */
export function verifyRuntimeQuick(runtimeDir) {
  const bm = readBundleManifest(runtimeDir);
  const bad = verifyTree(runtimeDir, bm, { deep: true, only: KEY_FILES });
  if (bad.length) throw new ManagedError("RUNTIME_ALTERADO", "Los archivos de PostgreSQL de esta instalación no son los originales: " + bad.slice(0, 2).join("; "));
  return bm;
}

// ------------------------------------------------------------------------------------------------ cluster configuration
const CONF_BEGIN = "# >>> Estetica Leal POS (managed block: do not edit) >>>";
const CONF_END = "# <<< Estetica Leal POS <<<";
export const HBA_TEXT = [
  "# Estetica Leal POS: loopback only, passwords checked with SCRAM-SHA-256. There is deliberately no 'trust' line.",
  "host    all             all             127.0.0.1/32            scram-sha-256",
  "",
].join("\n");

export function ianaTimezone(runtimeDir) {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && fs.existsSync(path.join(runtimeDir, "share", "timezone", ...tz.split("/")))) return tz;
  } catch { /* fall through */ }
  return null;
}
export function managedConf({ port, logsDir, timezone }) {
  const lines = [
    CONF_BEGIN,
    "listen_addresses = '127.0.0.1'",
    `port = ${port}`,
    "password_encryption = 'scram-sha-256'",
    "max_connections = 40",
    "shared_buffers = 128MB",
    "ssl = off",
    "logging_collector = on",
    `log_directory = '${posix(logsDir)}'`,
    "log_filename = 'postgresql-%u.log'",
    "log_truncate_on_rotation = on",
    "log_rotation_age = 1d",
    "log_connections = off",
    // a failed statement must never copy a password into the log
    "log_min_error_statement = panic",
    "log_statement = 'none'",
    "log_min_duration_statement = -1",
  ];
  if (timezone) lines.push(`timezone = '${timezone}'`, `log_timezone = '${timezone}'`);
  lines.push(CONF_END, "");
  return lines.join("\n");
}
export function writeManagedConf(layout, { port, runtimeDir }) {
  const file = path.join(layout.data, "postgresql.conf");
  let text = fs.readFileSync(file, "utf8");
  const re = new RegExp(`${CONF_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${CONF_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`);
  text = text.replace(re, "");
  if (!text.endsWith("\n")) text += "\n";
  fs.writeFileSync(file, text + managedConf({ port, logsDir: path.join(layout.logs, "postgres"), timezone: ianaTimezone(runtimeDir) }));
}
export function readConfiguredPort(layout) {
  const text = fs.readFileSync(path.join(layout.data, "postgresql.conf"), "utf8");
  const block = text.slice(text.indexOf(CONF_BEGIN));
  const m = /^port\s*=\s*(\d+)/m.exec(block);
  return m ? Number(m[1]) : null;
}
/** The security properties of the cluster, read back from disk. Returns the list of violations. */
export function auditClusterConfig(layout) {
  const problems = [];
  const hba = fs.readFileSync(path.join(layout.data, "pg_hba.conf"), "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!hba.length) problems.push("pg_hba.conf sin reglas");
  for (const l of hba) {
    const f = l.trim().split(/\s+/);
    if (f[0] !== "host" || f[3] !== "127.0.0.1/32" || f[4] !== "scram-sha-256") problems.push("regla de pg_hba no permitida: " + l.trim());
  }
  const conf = fs.readFileSync(path.join(layout.data, "postgresql.conf"), "utf8");
  const block = conf.slice(conf.indexOf(CONF_BEGIN));
  if (!/^listen_addresses\s*=\s*'127\.0\.0\.1'/m.test(block)) problems.push("listen_addresses no es solo 127.0.0.1");
  return problems;
}

// ------------------------------------------------------------------------------------------------ cluster operations
export function systemIdentifier(runtimeDir, dataDir) {
  const r = runTool(runtimeDir, "pg_controldata", ["-D", dataDir]);
  const m = /Database system identifier:\s+(\d+)/.exec(r.stdout);
  if (r.status !== 0 || !m) throw new ManagedError("SIN_IDENTIFICADOR", "No se pudo leer el identificador del clúster");
  return m[1];
}

/**
 * initdb with a random superuser password handed over through a temporary file inside the protected root (never on a command line).
 * The file is deleted and the deletion verified, whatever happens.
 */
export function initCluster({ layout, runtimeDir, port, superPassword, installId }) {
  if (fs.existsSync(layout.data)) throw new ManagedError("DATOS_EXISTEN", "La carpeta de datos ya existe: initdb no la toca");
  fs.mkdirSync(layout.tmp, { recursive: true });
  const pwfile = path.join(layout.tmp, "pw-" + crypto.randomBytes(6).toString("hex"));
  fs.writeFileSync(pwfile, superPassword + "\n", { mode: 0o600 });
  let initFailure = null; // thrown only after the password file is gone
  try {
    const r = runTool(runtimeDir, "initdb", ["-D", layout.data, "-U", SUPERUSER, `--pwfile=${pwfile}`, "-A", "scram-sha-256", "-E", "UTF8", "--locale-provider=builtin", "--builtin-locale=C.UTF-8", "--locale=C", "--data-checksums"], { timeout: 300000 });
    if (r.status !== 0) initFailure = new ManagedError("INITDB", "initdb falló: " + scrubSecrets((r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" | "), [superPassword]));
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
  if (fs.existsSync(pwfile)) throw new ManagedError("SECRETO_NO_BORRADO", "No se pudo borrar el archivo temporal de la contraseña");
  try { fs.rmdirSync(layout.tmp); } catch { /* not empty or gone */ }
  if (initFailure) throw initFailure;
  fs.writeFileSync(path.join(layout.data, "pg_hba.conf"), HBA_TEXT);
  writeManagedConf(layout, { port, runtimeDir });
  const sid = systemIdentifier(runtimeDir, layout.data);
  fs.writeFileSync(path.join(layout.data, MARKER_FILE), JSON.stringify({ installId, systemIdentifier: sid, createdAt: new Date().toISOString() }));
  const bad = auditClusterConfig(layout);
  if (bad.length) throw new ManagedError("CONFIG_INSEGURA", "La configuración del clúster no cumple la política: " + bad.join("; "));
  return { systemIdentifier: sid };
}

export function clusterRunning(layout, runtimeDir) {
  if (!fs.existsSync(path.join(layout.data, "postmaster.pid"))) return false;
  const r = runTool(runtimeDir, "pg_ctl", ["status", "-D", layout.data]);
  return r.status === 0;
}
/** Starts the cluster and waits until it accepts connections. The server log keeps the details; pg_ctl's own output goes to the logs folder. */
export async function startCluster({ layout, runtimeDir, timeoutSec = 60 }) {
  fs.mkdirSync(path.join(layout.logs, "postgres"), { recursive: true });
  const out = path.join(layout.logs, "pg_ctl.log");
  const fd = fs.openSync(out, "a");
  try {
    const code = await new Promise((resolve, reject) => {
      const p = spawn(toolPath(runtimeDir, "pg_ctl"), ["start", "-D", layout.data, "-w", "-t", String(timeoutSec), "-l", path.join(layout.logs, "postgres", "startup.log")], { env: toolEnv(), stdio: ["ignore", fd, fd], windowsHide: true });
      p.once("error", reject);
      p.once("exit", resolve);
    });
    if (code !== 0) throw new ManagedError("ARRANQUE", "PostgreSQL no arrancó (pg_ctl terminó con código " + code + "). Revisa logs\\postgres.");
  } finally {
    fs.closeSync(fd);
  }
}
export function stopCluster({ layout, runtimeDir, mode = "fast", timeoutSec = 60 }) {
  if (!clusterRunning(layout, runtimeDir)) return { wasRunning: false };
  const r = runTool(runtimeDir, "pg_ctl", ["stop", "-D", layout.data, "-m", mode, "-w", "-t", String(timeoutSec)], { timeout: (timeoutSec + 15) * 1000 });
  if (r.status !== 0) throw new ManagedError("PARADA", "PostgreSQL no se detuvo: " + r.stderr.trim().slice(0, 200));
  return { wasRunning: true };
}
export function connectionUrl({ port, user, password, database = "postgres" }) {
  const u = new URL("postgresql://placeholder");
  u.hostname = "127.0.0.1";
  u.port = String(port);
  u.username = user;
  u.password = password;
  u.pathname = "/" + database;
  return u.toString();
}
export const adminUrl = ({ port, password, database = "postgres" }) => connectionUrl({ port, user: SUPERUSER, password, database });

/**
 * Ownership proof. A cluster is ours only if (1) the marker inside it carries our installId, (2) its system identifier is the one the
 * manifest recorded. `password` (optional) adds (3): the running server reports the same identifier.
 */
export async function verifyOwnership({ layout, manifest, runtimeDir, pgClient = null }) {
  const marker = readMarker(layout);
  if (!marker || marker.installId !== manifest.installId) return { ok: false, why: "La carpeta de datos no lleva la marca de esta instalación." };
  const sid = systemIdentifier(runtimeDir, layout.data);
  if (sid !== manifest.postgres.systemIdentifier || marker.systemIdentifier !== sid) return { ok: false, why: "El identificador del clúster no coincide con el registrado." };
  if (pgClient) {
    const live = (await pgClient.query("select system_identifier::text as s from pg_control_system()")).rows[0].s;
    if (live !== sid) return { ok: false, why: "El servidor que responde no es el clúster registrado." };
  }
  return { ok: true };
}

/** The last lines of the server log, for the diagnosis shown to a person. Secrets are removed. */
export function serverLogTail(layout, secrets = [], lines = 25) {
  const dir = path.join(layout.logs, "postgres");
  try {
    const files = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!files.length) return "";
    return scrubSecrets(fs.readFileSync(path.join(dir, files[0].f), "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n"), secrets);
  } catch {
    return "";
  }
}

/**
 * Makes sure the managed instance of an installed application is running (every application start). Returns the port in use.
 * If the registered port was taken by another program, another free one is chosen and the cluster is configured for it; the caller
 * learns it through `portChanged` and updates the stored connection.
 */
export async function ensureRunning({ layout, manifest, bundleDir = null, portFirst = PORT_FIRST, portLast = PORT_LAST }) {
  const runtimeDir = path.join(layout.root, manifest.postgres.runtimeDir);
  verifyRuntimeQuick(runtimeDir);
  const owned = await verifyOwnership({ layout, manifest, runtimeDir });
  if (!owned.ok) throw new ManagedError("NO_PROPIA", owned.why + " No se enciende ni se modifica.");
  if (clusterRunning(layout, runtimeDir)) return { port: readConfiguredPort(layout), portChanged: false, alreadyRunning: true, runtimeDir };
  let port = readConfiguredPort(layout) ?? manifest.postgres.port;
  let portChanged = false;
  if (!(await isPortFree(port))) {
    port = await choosePort({ first: portFirst, last: portLast, avoid: [port] });
    writeManagedConf(layout, { port, runtimeDir });
    portChanged = true;
  }
  await startCluster({ layout, runtimeDir });
  return { port, portChanged, alreadyRunning: false, runtimeDir };
}

// ------------------------------------------------------------------------------------------------ PostgreSQL minor updates
const versionTuple = (v) => String(v).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
/** "18.7-1" vs "18.6-1": 1 when a is newer, 0 equal, -1 older (same major assumed by the caller). */
export function compareVersions(a, b) {
  const x = versionTuple(a);
  const y = versionTuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * A new application version may carry a newer PostgreSQL. Same major version (a minor update, data-compatible): the new package is
 * verified and copied next to the old one, the instance is restarted on it, and only after it answers is the old copy removed; if it does
 * not start, the manifest keeps pointing at the old copy and the instance is started on that. A DIFFERENT major version needs pg_upgrade,
 * a procedure of its own: it is refused here and the instance keeps running on the version it has.
 * Returns { action: "none" | "updated" | "refused" | "rolled-back", ... }.
 */
export async function updateRuntimeIfNewer({ layout, manifest, bundleDir }) {
  let bm;
  try {
    bm = readBundleManifest(bundleDir);
  } catch {
    return { action: "none" };
  }
  const current = manifest.postgres.version;
  if (bm.version === current) return { action: "none" };
  if (bm.major !== manifest.postgres.major) return { action: "refused", reason: `El paquete trae PostgreSQL ${bm.major} y la instancia usa ${manifest.postgres.major}: un cambio de versión mayor necesita un procedimiento aparte (pg_upgrade) y no se hace solo.` };
  if (compareVersions(bm.version, current) <= 0) return { action: "none" };
  const oldDir = path.join(layout.root, manifest.postgres.runtimeDir);
  const { runtimeDir: newDir } = installRuntime(bundleDir, layout);
  const wasRunning = clusterRunning(layout, oldDir);
  if (wasRunning) stopCluster({ layout, runtimeDir: oldDir });
  const previous = JSON.parse(JSON.stringify(manifest.postgres));
  manifest.postgres.version = bm.version;
  manifest.postgres.runtimeDir = path.join("runtime", bm.version);
  try {
    writeManifest(layout, manifest);
    await startCluster({ layout, runtimeDir: newDir });
    if (!wasRunning) stopCluster({ layout, runtimeDir: newDir });
  } catch (e) {
    try { stopCluster({ layout, runtimeDir: newDir, mode: "immediate" }); } catch { /* not running */ }
    manifest.postgres = previous;
    writeManifest(layout, manifest);
    fs.rmSync(newDir, { recursive: true, force: true });
    if (wasRunning) await startCluster({ layout, runtimeDir: oldDir });
    return { action: "rolled-back", reason: "La versión nueva de PostgreSQL no pudo iniciar; se conserva la anterior. " + (e?.message ?? "") };
  }
  fs.rmSync(oldDir, { recursive: true, force: true });
  return { action: "updated", from: current, to: bm.version };
}
