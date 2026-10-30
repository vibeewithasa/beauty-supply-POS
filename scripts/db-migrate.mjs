// The ONLY way a database schema is changed. The application itself never migrates (it refuses to run on a database
// that is not up to date).
//
//   node scripts/db-migrate.mjs                                         # report + dry run: changes NOTHING
//   node scripts/db-migrate.mjs --apply --confirm-database=<name>       # backup + precheck + migrate + verify
//
// --apply needs --confirm-database=<name> to be typed exactly like the database in DATABASE_URL: it is an explicit
// decision about THAT database, never a default. On a database that already holds data it first runs the read-only
// precheck and then takes a verified backup (pg_dump); if either fails, nothing is migrated. A brand-new empty database
// needs neither. Options: --backup-dir <folder> (default POS_BACKUP_DIR or <home>\Backups\beauty-pos, outside the project).
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyMigrations, assertLocal, backupDatabase, hasUserTables, OpsError, parseConnection, schemaStatus, scrub, withClient } from "./lib/db-ops.mjs";
import { describeSchemaState } from "./lib/schema-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOLDER = path.join(ROOT, "drizzle");
// accepts both "--name value" and "--name=value"
const arg = (name) => {
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = process.env.DATABASE_URL;
const apply = process.argv.includes("--apply");

try {
  if (!url) throw new OpsError("SIN_CONFIGURACION", "DATABASE_URL no está definido (variable de entorno o .env)");
  const conn = parseConnection(url);
  assertLocal(conn);
  console.log(`Base de datos: ${conn.database} (servidor ${conn.host}:${conn.port})`);

  const before = await schemaStatus(url, FOLDER);
  console.log(`Estado: ${before.status} · requeridas ${before.required} · aplicadas ${before.applied}${before.missing.length ? " · faltan: " + before.missing.join(", ") : ""}`);
  if (before.status === "ok") {
    console.log("La base ya está al día. No hay nada que hacer.");
    process.exit(0);
  }
  if (before.status === "newer") {
    const d = describeSchemaState(before);
    throw new OpsError("BASE_MAS_NUEVA", d.headline + ". " + d.detail);
  }
  const existing = await withClient(url, hasUserTables, "pos_migrate_probe");
  console.log(existing ? "La base ya contiene tablas: se exigen comprobación previa y respaldo verificado." : "La base está vacía (nueva): no requiere respaldo.");

  if (!apply) {
    if (existing) {
      const pre = spawnSync(process.execPath, [path.join(ROOT, "scripts", "precheck-integrity.mjs")], { cwd: ROOT, encoding: "utf8", env: process.env });
      console.log(scrub(pre.stdout, url).trimEnd());
      if (pre.status !== 0) console.log("La comprobación previa encontró BLOQUEOS: corrígelos antes de actualizar.");
    }
    console.log(`\nSIMULACIÓN: no se cambió nada. Para aplicar: node scripts/db-migrate.mjs --apply --confirm-database=${conn.database}`);
    process.exit(0);
  }

  if (arg("--confirm-database") !== conn.database) {
    throw new OpsError("SIN_CONFIRMACION", `--apply requiere --confirm-database=${conn.database} (escribe el nombre exacto de la base que vas a modificar)`);
  }
  let backupPath = null;
  if (existing) {
    const pre = spawnSync(process.execPath, [path.join(ROOT, "scripts", "precheck-integrity.mjs")], { cwd: ROOT, encoding: "utf8", env: process.env });
    console.log(scrub(pre.stdout, url).trimEnd());
    if (pre.status !== 0) throw new OpsError("PRECHECK", "La comprobación previa encontró bloqueos: no se migró nada");
    const outDir = path.resolve(arg("--backup-dir") || process.env.POS_BACKUP_DIR || path.join(os.homedir(), "Backups", "beauty-pos"));
    const rel = path.relative(ROOT, outDir);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new OpsError("DESTINO_EN_REPOSITORIO", "La carpeta de respaldos debe estar fuera del proyecto");
    const b = await backupDatabase({ url, outDir, label: "pre-migrate" });
    backupPath = b.file;
    console.log(`Respaldo verificado: ${b.file}\n  sha256 ${b.summary.sha256}`);
  }
  const n = await applyMigrations(url, FOLDER);
  const after = await schemaStatus(url, FOLDER);
  if (after.status !== "ok") throw new OpsError("VERIFICACION", `Tras migrar el estado es "${after.status}"`);
  console.log(`Migraciones aplicadas y verificadas (${n} requeridas, todas presentes).`);
  if (backupPath) console.log(`Si algo no quedó bien, el respaldo previo está en: ${backupPath} (restáuralo en una base nueva con scripts/db-restore.mjs).`);
} catch (e) {
  console.error("No se migró: " + scrub(e instanceof OpsError ? e.message : `Error inesperado: ${e.message}`, url));
  process.exit(1);
}
