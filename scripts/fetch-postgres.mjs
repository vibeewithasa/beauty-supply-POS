// Prepares the PostgreSQL that travels inside the installer (build machine only; the laptop never downloads anything).
//
//   node scripts/fetch-postgres.mjs [--force]
//
//   1. downloads the official binaries archive named in scripts/postgresql-pin.json (once; cached in vendor/postgresql/),
//   2. REFUSES any file whose SHA-256 is not the pinned one (a changed archive is never used silently),
//   3. extracts it into a scratch folder and keeps only what a dedicated cluster needs (no pgAdmin, docs, headers, StackBuilder,
//      translations, Python/Perl/Tcl languages, JIT),
//   4. adds the Visual C++ runtime DLLs the binaries need (app-local), after checking that each carries a valid Microsoft signature,
//   5. writes vendor/pg-bundle/postgresql-bundle.json: version, source, and the SHA-256 of EVERY file. The application re-checks it
//      when it copies the bundle to its runtime folder (scripts/lib/managed-pg.mjs).
// vendor/ is ignored by Git: binaries are never committed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(fs.readFileSync(path.join(root, "scripts", "postgresql-pin.json"), "utf8"));
const vendor = path.join(root, "vendor", "postgresql");
const archive = path.join(vendor, path.basename(new URL(pin.url).pathname));
const scratch = path.join(vendor, "extract");
const bundle = path.join(root, "vendor", "pg-bundle");
const force = process.argv.includes("--force");

const KEEP_EXE = new Set(["postgres", "initdb", "pg_ctl", "pg_controldata", "pg_dump", "pg_restore", "pg_isready", "psql"]);
const DROP_BIN_RE = /^(wx.*\.dll|stackbuilder\.exe|.*\.lib|testplug\.dll)$/i;
const DROP_LIB_RE = /^(plpython|plperl|pltcl|llvmjit|libpython|.*\.lib$)/i;
const VC_RUNTIME = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];

const log = (m) => console.log("[fetch-postgres] " + m);
function sha256File(file) {
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
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, hops) =>
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
          res.resume();
          return get(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + " al descargar " + u));
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
      }).on("error", reject);
    get(url, 0);
  });
}
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}
function msSignature(file) {
  const ps = "$s = Get-AuthenticodeSignature -LiteralPath $env:POS_SIG_FILE; [pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject; version = (Get-Item -LiteralPath $env:POS_SIG_FILE).VersionInfo.ProductVersion } | ConvertTo-Json -Compress";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", env: { ...process.env, POS_SIG_FILE: file } });
  if (r.status !== 0) throw new Error("No se pudo comprobar la firma de " + file);
  return JSON.parse(r.stdout);
}

if (process.platform !== "win32") {
  console.error("Este paso prepara el PostgreSQL de Windows y solo se ejecuta en Windows.");
  process.exit(1);
}

// already prepared for this pin?
const manifestFile = path.join(bundle, "postgresql-bundle.json");
if (!force && fs.existsSync(manifestFile)) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (m.sourceSha256 === pin.sha256 && m.version === pin.version) {
      log(`El paquete ${pin.version} ya está preparado en vendor/pg-bundle (usa --force para rehacerlo).`);
      process.exit(0);
    }
  } catch { /* rebuild */ }
}

fs.mkdirSync(vendor, { recursive: true });
if (!fs.existsSync(archive) || sha256File(archive) !== pin.sha256) {
  if (fs.existsSync(archive)) { log("El archivo guardado no coincide con el hash fijado: se descarga de nuevo."); fs.rmSync(archive); }
  log(`Descargando ${pin.url} (${(pin.bytes / 1048576).toFixed(0)} MB)...`);
  await download(pin.url, archive + ".part");
  const got = sha256File(archive + ".part");
  if (got !== pin.sha256) {
    fs.rmSync(archive + ".part", { force: true });
    console.error(`RECHAZADO: el SHA-256 descargado (${got}) no es el fijado en scripts/postgresql-pin.json (${pin.sha256}). No se usa.`);
    process.exit(1);
  }
  fs.renameSync(archive + ".part", archive);
}
log("SHA-256 del archivo oficial verificado: " + pin.sha256);

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const x = spawnSync(tar, ["-xf", archive, "-C", scratch, "--exclude", "pgsql/pgAdmin*", "--exclude", "pgsql/doc", "--exclude", "pgsql/include", "--exclude", "pgsql/StackBuilder", "--exclude", "pgsql/symbols"], { encoding: "utf8" });
if (x.status !== 0) { console.error("No se pudo extraer el archivo: " + (x.stderr || x.error)); process.exit(1); }
const src = path.join(scratch, "pgsql");

fs.rmSync(bundle, { recursive: true, force: true });
for (const d of ["bin", "lib", "share"]) fs.mkdirSync(path.join(bundle, d), { recursive: true });

for (const f of fs.readdirSync(path.join(src, "bin"))) {
  const ext = path.extname(f).toLowerCase();
  if (DROP_BIN_RE.test(f)) continue;
  if (ext === ".exe" && !KEEP_EXE.has(path.basename(f, ext))) continue;
  fs.copyFileSync(path.join(src, "bin", f), path.join(bundle, "bin", f));
}
for (const f of fs.readdirSync(path.join(src, "lib"), { withFileTypes: true })) {
  if (f.isDirectory() || DROP_LIB_RE.test(f.name)) continue;
  fs.copyFileSync(path.join(src, "lib", f.name), path.join(bundle, "lib", f.name));
}
fs.cpSync(path.join(src, "share"), path.join(bundle, "share"), { recursive: true, filter: (p) => !/[\\/]share[\\/](locale|doc)([\\/]|$)/.test(p) });
for (const lic of ["server_license.txt", "commandlinetools_3rd_party_licenses.txt"]) fs.copyFileSync(path.join(src, lic), path.join(bundle, lic));

// Visual C++ runtime, app-local, from the Microsoft-signed copies of this machine
const sys32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const vcruntime = [];
for (const name of VC_RUNTIME) {
  const from = path.join(sys32, name);
  if (!fs.existsSync(from)) { console.error(`Falta ${name} en esta máquina de construcción: instala el redistribuible de Visual C++ 2015-2022 x64 y repite.`); process.exit(1); }
  const sig = msSignature(from);
  if (sig.status !== "Valid" || !/Microsoft/i.test(sig.subject)) { console.error(`${name} no tiene una firma válida de Microsoft (${sig.status}).`); process.exit(1); }
  fs.copyFileSync(from, path.join(bundle, "bin", name));
  vcruntime.push({ name, version: sig.version, sha256: sha256File(from) });
}
fs.writeFileSync(
  path.join(bundle, "NOTICE-vc-runtime.txt"),
  "Microsoft Visual C++ 2015-2022 Redistributable (x64): vcruntime140.dll, vcruntime140_1.dll, msvcp140.dll.\r\nSe incluyen junto a los ejecutables de PostgreSQL (despliegue app-local de los archivos redistribuibles de Microsoft) para que funcionen en un Windows sin ese paquete instalado.\r\nVersion: " + vcruntime.map((v) => v.name + " " + v.version).join("; ") + "\r\n"
);

const files = walk(bundle).filter((f) => f !== "postgresql-bundle.json").map((f) => ({ path: f, size: fs.statSync(path.join(bundle, f)).size, sha256: sha256File(path.join(bundle, f)) }));
for (const must of ["bin/postgres.exe", "bin/initdb.exe", "bin/pg_ctl.exe", "bin/pg_controldata.exe", "bin/pg_dump.exe", "bin/pg_restore.exe", "share/postgres.bki", "share/timezone/UTC"]) {
  if (!files.some((f) => f.path === must)) { console.error("Falta en el paquete: " + must); process.exit(1); }
}
const total = files.reduce((s, f) => s + f.size, 0);
const filesHash = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
fs.writeFileSync(
  manifestFile,
  JSON.stringify({ format: 1, version: pin.version, major: pin.major, source: pin.url, sourceSha256: pin.sha256, builtAt: new Date().toISOString(), vcruntime, fileCount: files.length, totalBytes: total, filesSha256: filesHash, files }, null, 1)
);
fs.rmSync(scratch, { recursive: true, force: true });
log(`Paquete listo: ${files.length} archivos, ${(total / 1048576).toFixed(0)} MB, version ${pin.version}, huella ${filesHash.slice(0, 16)}...`);
