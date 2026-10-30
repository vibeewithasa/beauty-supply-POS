// Restores a backup into a NEW database (never over an existing one) and verifies it.
//
//   node scripts/db-restore.mjs --file <backup.dump> --target <new_database_name> [--no-verify]
//
// The target database must NOT exist: this tool creates it. It refuses protected names (beauty_pos, beauty_pos_smoke,
// postgres, templates) and the database configured in DATABASE_URL. The checksum is compared with the .summary.json
// next to the dump, and after restoring, row counts, migrations and the schema fingerprint are compared too.
// If anything fails, only the database this command created is dropped. Exit code 0 = restored and verified.
//
// To go back to production after checking the copy, do it deliberately and by hand (see docs/OPERATIONS.md).
import "dotenv/config";
import path from "node:path";
import { restoreToNewDatabase, scrub, OpsError } from "./lib/db-ops.mjs";

// accepts both "--name value" and "--name=value"
const arg = (name) => {
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = process.env.DATABASE_URL;
try {
  if (!url) throw new OpsError("SIN_CONFIGURACION", "DATABASE_URL no está definido (variable de entorno o .env)");
  const file = arg("--file");
  const target = arg("--target");
  if (!file || !target) throw new OpsError("USO", "Uso: node scripts/db-restore.mjs --file <respaldo.dump> --target <base_nueva>");
  const r = await restoreToNewDatabase({ url, file: path.resolve(file), target, verify: !process.argv.includes("--no-verify") });
  console.log("Restauración completada en la base NUEVA \"" + r.target + "\"");
  console.log("  sha256 del respaldo : " + r.sha256);
  console.log("  migraciones         : " + r.migrations);
  console.log("  huella del esquema  : " + r.schemaFingerprint);
  console.log("  filas               : " + JSON.stringify(r.counts));
  console.log("  verificación        : " + (r.verified ? r.checks.map((c) => `${c.check}=${c.ok ? "OK" : "FALLO"}`).join(", ") : "omitida (sin resumen o --no-verify)"));
} catch (e) {
  console.error("No se restauró nada: " + scrub(e instanceof OpsError ? e.message : `Error inesperado: ${e.message}`, url));
  process.exit(1);
}
