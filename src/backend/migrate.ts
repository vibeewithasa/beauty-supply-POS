import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./db";

export async function createDbAndRunMigrations(app: Electron.App) {
  try {
    console.log("Iniciando conexión a base de datos...");
    const db = drizzle(pool);

    // Locate migrations folder both in dev and prod
    const devMigrations = path.join(process.cwd(), "drizzle");
    const prodMigrations = path.join(app.getAppPath(), "drizzle");
    const migrationsFolder =
      process.env.NODE_ENV === "development" ? devMigrations : prodMigrations;

    console.log("Ejecutando migraciones desde", migrationsFolder);
    await migrate(db, { migrationsFolder });
    console.log("Migraciones completadas.");
  } catch (error) {
    console.error("Error en migraciones:", error);
    throw error;
  }
}
