/**
 * Startup gate: the application never creates or changes the database schema. It only checks (with SELECTs) that the
 * database has exactly the migrations this version requires, and refuses to register any IPC handler otherwise.
 * Changing a schema is an explicit administrative action: `npm run db:migrate` (see docs/OPERATIONS.md).
 */
import path from "node:path";
import { pool } from "./db";
import { checkSchema, describeSchemaState } from "../../scripts/lib/schema-state.mjs";

export type StartupCheck = { ok: true } | { ok: false; headline: string; detail: string };

export async function verifyDatabaseSchema(appPath: string): Promise<StartupCheck> {
  try {
    const state = await checkSchema(pool, path.join(appPath, "drizzle"));
    const d = describeSchemaState(state);
    if (!d) {
      console.log(`Esquema verificado: ${state.applied} migraciones aplicadas (todas las requeridas).`);
      return { ok: true };
    }
    console.error(`SCHEMA_CHECK_FAILED: status=${state.status} required=${state.required} applied=${state.applied} missing=${state.missing.join(",")} unknown=${state.unknown}`);
    return { ok: false, ...d };
  } catch (error) {
    // never show connection details: the log keeps only the driver's error code/message class
    const code = (error as { code?: string } | null)?.code ?? "desconocido";
    console.error(`SCHEMA_CHECK_ERROR: no se pudo leer el estado del esquema (código ${code})`);
    return { ok: false, headline: "No se pudo comprobar la base de datos", detail: "Revisa que PostgreSQL esté activo y que la configuración sea correcta." };
  }
}
