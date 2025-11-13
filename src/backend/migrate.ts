import path from "path";
import { app as electronApp } from "electron";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./db";

export async function createDbAndRunMigrations(app: Electron.App) {
  const db = drizzle(pool);

  // Locate migrations folder both in dev and prod
  const devMigrations = path.join(process.cwd(), "drizzle");
  const prodMigrations = path.join(app.getAppPath(), "drizzle");
  const migrationsFolder =
    process.env.NODE_ENV === "development" ? devMigrations : prodMigrations;

  await migrate(db, { migrationsFolder });
}
