// Read-only: which migrations the database in DATABASE_URL has compared with what this version requires.
//   node scripts/db-status.mjs        (exit 0 = up to date, 1 = needs an update or cannot be read)
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocal, OpsError, parseConnection, schemaStatus, scrub } from "./lib/db-ops.mjs";

const url = process.env.DATABASE_URL;
try {
  if (!url) throw new OpsError("SIN_CONFIGURACION", "DATABASE_URL no está definido (variable de entorno o .env)");
  const conn = parseConnection(url);
  assertLocal(conn);
  const s = await schemaStatus(url, path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle"));
  console.log(`Base de datos: ${conn.database} · estado: ${s.status} · requeridas ${s.required} · aplicadas ${s.applied}${s.missing.length ? " · faltan: " + s.missing.join(", ") : ""}`);
  process.exit(s.status === "ok" ? 0 : 1);
} catch (e) {
  console.error("No se pudo comprobar: " + scrub(e instanceof OpsError ? e.message : e.message, url));
  process.exit(1);
}
