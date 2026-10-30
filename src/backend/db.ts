import { app } from "electron";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveDatabaseUrl } from "./db-config";

// The connection string is resolved here, once, and never baked into the package (see db-config.ts).
export const dbConfig = resolveDatabaseUrl({
  env: process.env,
  packaged: app.isPackaged,
  userDataDir: app.getPath("userData"),
  cwd: process.cwd(),
});
if (dbConfig.ok) {
  process.env.DATABASE_URL = dbConfig.url; // so error redaction knows the secret even when it came from config.json
} else {
  console.error("DB_CONFIG_ERROR:", dbConfig.reason);
}

// Without a valid configuration the pool points at an unusable address: main aborts startup before any query, and
// pg must never fall back to PG* defaults (an unintended local database).
export const pool = new Pool({
  connectionString: dbConfig.ok ? dbConfig.url : "postgresql://unconfigured@127.0.0.1:1/unconfigured",
});

// A lost connection (PostgreSQL restarted, an administrator terminated the session) makes the driver emit 'error':
//  - on an idle pooled client: handled by the pool's own listener below;
//  - on a client that is checked out (a transaction in flight): pg-pool removes its listener, and without one of ours the
//    error would be an uncaught exception that blocks or crashes the main process. The query itself still rejects, so the
//    caller gets a clean [ERROR_INTERNO]; the dead client is discarded and the next call reconnects.
pool.on("error", (err) => {
  console.error("DB_POOL_IDLE_CLIENT_ERROR:", (err as { code?: string }).code ?? "sin código");
});

// Configurar la zona horaria de la sesión al conectarse
pool.on("connect", async (client) => {
  client.on("error", (err) => {
    console.error("DB_CLIENT_ERROR:", (err as { code?: string }).code ?? "sin código");
  });
  try {
    // Obtener la zona horaria local del sistema
    const offset = -new Date().getTimezoneOffset(); // Offset en minutos (negativo porque getTimezoneOffset devuelve inverso)
    const hours = Math.floor(offset / 60);
    const minutes = Math.abs(offset % 60);
    const sign = hours >= 0 ? "+" : "-";
    const absHours = Math.abs(hours);
    const timezone = `${sign}${absHours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}`;

    await client.query(`SET timezone = '${timezone}'`);
    console.log(`PostgreSQL timezone configurado a: ${timezone}`);
  } catch (err) {
    console.error("Error setting timezone:", err);
  }
});

export const db = drizzle(pool);
