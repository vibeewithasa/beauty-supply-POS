// Least-privilege PostgreSQL role for the application's runtime connection (data read/write only: no DDL, no TRUNCATE,
// no role/database creation). Migrations keep using the owner connection through scripts/db-migrate.mjs.
//
//   node scripts/db-roles.mjs --role pos_runtime                                  # prints the SQL it would run, changes nothing
//   POS_RUNTIME_PASSWORD=<12+ chars> node scripts/db-roles.mjs --role pos_runtime --apply --confirm-database=<name>
//   node scripts/db-roles.mjs --role pos_runtime --regrant --confirm-database=<name>   # after a migration added tables
//
// The role name must be pos_<name>. The password comes ONLY from POS_RUNTIME_PASSWORD (never a command-line argument).
// An existing role is never altered, except to re-apply grants to a role this tool created itself (--regrant).
// Then point the application at it (DATABASE_URL or config.json) — see docs/OPERATIONS.md.
import "dotenv/config";
import { assertLocal, createRuntimeRole, OpsError, parseConnection, regrantRuntimeRole, runtimeGrantSql, scrub } from "./lib/db-ops.mjs";

const arg = (name) => {
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = process.env.DATABASE_URL;
try {
  if (!url) throw new OpsError("SIN_CONFIGURACION", "DATABASE_URL (la conexión del PROPIETARIO) no está definida");
  const conn = parseConnection(url);
  assertLocal(conn);
  const role = arg("--role");
  if (!role) throw new OpsError("USO", "Uso: node scripts/db-roles.mjs --role pos_<nombre> [--apply|--regrant --confirm-database=<base>]");
  const sql = runtimeGrantSql(role, conn.database);
  const apply = process.argv.includes("--apply");
  const regrant = process.argv.includes("--regrant");
  if (!apply && !regrant) {
    console.log(`SIMULACIÓN (no se cambió nada). Para el rol "${role}" en la base "${conn.database}" se ejecutaría:`);
    console.log("  CREATE ROLE " + role + " LOGIN PASSWORD '***' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    for (const q of sql) console.log("  " + q);
    process.exit(0);
  }
  if (arg("--confirm-database") !== conn.database) throw new OpsError("SIN_CONFIRMACION", `Se requiere --confirm-database=${conn.database}`);
  if (regrant) {
    await regrantRuntimeRole(url, { role, database: conn.database });
    console.log(`Permisos re-aplicados al rol "${role}" en "${conn.database}".`);
  } else {
    await createRuntimeRole(url, { role, password: process.env.POS_RUNTIME_PASSWORD, database: conn.database });
    console.log(`Rol "${role}" creado en "${conn.database}" con permisos de datos únicamente. Configura la aplicación para usarlo (docs/OPERATIONS.md).`);
  }
} catch (e) {
  console.error("No se cambió nada: " + scrub(e instanceof OpsError ? e.message : `Error inesperado: ${e.message}`, url).replace(process.env.POS_RUNTIME_PASSWORD || "\u0000", "***"));
  process.exit(1);
}
