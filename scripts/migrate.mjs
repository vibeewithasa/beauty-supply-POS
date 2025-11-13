import "dotenv/config";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL no está definido. Crea .env primero.");
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  console.log("Ejecutando migraciones desde", migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.log("Migraciones completadas.");
  await pool.end();
}

main().catch(async (e) => {
  console.error("Error en migraciones:", e);
  process.exit(1);
});
