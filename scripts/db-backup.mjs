// Verified backup of the database in DATABASE_URL (.env or the environment) with pg_dump (custom format).
//
//   node scripts/db-backup.mjs [--out <folder>] [--label <text>] [--keep <N>] [--second-copy <folder>]
//
//   --out    destination folder (default: POS_BACKUP_DIR, or <home>\Backups\beauty-pos). It must be OUTSIDE this project.
//   --label  short name added to the file ("manual", "diario", "pre-migrate"...). Default: manual.
//   --keep   afterwards keep only the newest N backups made by this tool for this database (retention).
//   --second-copy  a SECOND location chosen by the operator (external drive, USB, folder of another PC of the local
//            network; or POS_BACKUP_SECOND_DIR). The backup is copied there and the copy verified with SHA-256. Nothing is
//            uploaded anywhere, URLs and cloud-synchronized folders are refused, nothing is overwritten or deleted there.
//            If the location is unavailable the primary backup still counts, and the exit code is 3.
//
// The backup is never overwritten, is verified with pg_restore -l and a SHA-256 checksum, and is written together with a
// .summary.json (row counts, schema fingerprint, migrations). Exit code 0 = verified backup (and, if requested, a verified second
// copy); 1 = no valid backup; 3 = valid primary backup but the second copy was not verified. Every run is logged with its date and
// result in backup.log (next to the backups).
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupDatabase, parseConnection, scrub, OpsError } from "./lib/db-ops.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// accepts both "--name value" and "--name=value"
const arg = (name) => {
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = process.env.DATABASE_URL;
const outDir = path.resolve(arg("--out") || process.env.POS_BACKUP_DIR || path.join(os.homedir(), "Backups", "beauty-pos"));
const keepArg = arg("--keep");
const label = arg("--label") || "manual";
const secondArg = arg("--second-copy") || process.env.POS_BACKUP_SECOND_DIR || null;

function log(line) {
  const rel = path.relative(ROOT, outDir);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return; // a refused destination inside the project is never created
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(path.join(outDir, "backup.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never hide the real result */
  }
}

try {
  if (!url) throw new OpsError("SIN_CONFIGURACION", "DATABASE_URL no está definido (variable de entorno o .env)");
  const rel = path.relative(ROOT, outDir);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new OpsError("DESTINO_EN_REPOSITORIO", "La carpeta de respaldos debe estar fuera del proyecto (los respaldos contienen datos reales y nunca van a Git)");
  const keep = keepArg === undefined ? 0 : Number(keepArg);
  if (keepArg !== undefined && (!Number.isInteger(keep) || keep < 1)) throw new OpsError("RETENCION_INVALIDA", "--keep debe ser un entero mayor o igual a 1");
  if (secondArg) {
    const relSecond = path.relative(ROOT, path.resolve(secondArg));
    if (!relSecond.startsWith("..") && !path.isAbsolute(relSecond)) throw new OpsError("DESTINO_EN_REPOSITORIO", "La segunda copia debe estar fuera del proyecto");
  }
  const r = await backupDatabase({ url, outDir, label, keep, secondCopyDir: secondArg });
  const second = r.secondCopy ? ` second=${r.secondCopy.status} dir=${r.secondCopy.dir}` : "";
  log(`OK ${parseConnection(url).database} ${r.summary.file} ${r.summary.sizeBytes}B sha256=${r.summary.sha256.slice(0, 16)}… pruned=${r.pruned.deleted.length}${second}`);
  console.log("Respaldo verificado");
  console.log("  archivo : " + r.file);
  console.log("  tamaño  : " + r.summary.sizeBytes + " bytes");
  console.log("  sha256  : " + r.summary.sha256);
  console.log("  tablas  : " + Object.keys(r.summary.counts).length + " · migraciones aplicadas: " + r.summary.migrationsApplied);
  console.log("  filas   : " + JSON.stringify(r.summary.counts));
  if (r.pruned.deleted.length) console.log("  retención: se eliminaron " + r.pruned.deleted.length + " respaldos antiguos de esta herramienta (solo en la ubicación principal)");
  if (r.secondCopy) {
    if (r.secondCopy.status === "verified") {
      console.log("Segunda copia verificada (SHA-256)");
      console.log("  carpeta : " + r.secondCopy.dir);
    } else {
      console.error(`RESPALDO PRINCIPAL CORRECTO, pero la segunda copia NO se verificó (${r.secondCopy.status}): ${scrub(r.secondCopy.message, url)}`);
      process.exit(3);
    }
  }
} catch (e) {
  const msg = scrub(e instanceof OpsError ? e.message : `Error inesperado: ${e.message}`, url);
  log(`FALLO ${e.code || "ERROR"} ${msg}`);
  console.error("No se generó un respaldo válido: " + msg);
  process.exit(1);
}
