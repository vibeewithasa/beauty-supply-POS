/**
 * First-run setup operations (main process only). They work on a connection typed in the setup window, BEFORE it is saved:
 *  - inspectConnection: is PostgreSQL there, which version, does the database exist, how privileged is the role the app would
 *    use, which schema version does it hold (the app never migrates), is there an administrator;
 *  - saveConfiguration: stores the connection protected by Windows (config-store.ts);
 *  - createFirstAdmin: creates the first administrator when none exists (same PIN rules and lock as the users screen).
 * It never runs migrations and never returns the password, a hash or a driver message to the caller.
 */
import path from "node:path";
import pg from "pg";
import { BusinessError } from "./errors";
import { writeConfigV2 } from "./config-store";
import type { Cipher } from "./config-store";
import { describeConnectionError } from "./setup-validation";
import type { FirstAdminInput, SetupConnection } from "./setup-validation";
import { hashPin, verifyPin } from "./pin-hash";
import { checkSchema, describeSchemaState } from "../../scripts/lib/schema-state.mjs";

// Same key as USER_ADMIN_LOCK_KEY in users-service.ts and scripts/seed-admin.mjs: serializes with the user administration.
const USER_ADMIN_LOCK_KEY = 7_481_201;
const MIN_SERVER_VERSION = 120000;

export type InspectResult =
  | {
      ok: true;
      server: { version: string; supported: boolean };
      role: { name: string; level: "minimum" | "warning"; warnings: string[] };
      schema: { status: string; required: number; applied: number; missing: string[]; headline: string | null; detail: string | null };
      admin: { exists: boolean | null };
    }
  | { ok: false; code: string; message: string };

async function withClient<T>(conn: SetupConnection, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    host: conn.parts.host,
    port: conn.parts.port,
    database: conn.parts.database,
    user: conn.parts.user,
    password: conn.password ?? undefined,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    application_name: "pos_setup",
  });
  client.on("error", () => {
    /* a dropped connection surfaces through the pending query */
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function inspectConnection(conn: SetupConnection, appPath: string): Promise<InspectResult> {
  try {
    return await withClient(conn, async (c) => {
      const v = (await c.query("select current_setting('server_version_num')::int as num, current_setting('server_version') as text")).rows[0];
      const role = (await c.query("select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = current_user")).rows[0] ?? {};
      const owned = (await c.query("select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = current_user")).rows[0].n as number;
      const warnings: string[] = [];
      if (role.rolsuper) warnings.push("El usuario es superusuario de PostgreSQL: una contraseña robada daría control total del servidor.");
      if (role.rolcreatedb) warnings.push("El usuario puede crear bases de datos.");
      if (role.rolcreaterole) warnings.push("El usuario puede crear otros usuarios.");
      if (role.rolreplication || role.rolbypassrls) warnings.push("El usuario tiene privilegios de replicación o de saltarse la seguridad por filas.");
      if (owned > 0) warnings.push(`El usuario es dueño de ${owned} tabla(s): puede modificar o borrar la estructura. Usa un rol de privilegios mínimos (npm run db:roles).`);

      const state = await checkSchema(c, path.join(appPath, "drizzle"));
      const described = describeSchemaState(state);
      let adminExists: boolean | null = null;
      if (state.status === "ok") {
        adminExists = ((await c.query("select count(*)::int as n from users where role = 'admin' and active")).rows[0].n as number) > 0;
      }
      return {
        ok: true as const,
        server: { version: String(v.text), supported: (v.num as number) >= MIN_SERVER_VERSION },
        role: { name: conn.parts.user, level: warnings.length ? ("warning" as const) : ("minimum" as const), warnings },
        schema: {
          status: state.status,
          required: state.required,
          applied: state.applied,
          missing: state.missing,
          headline: described?.headline ?? null,
          detail: described?.detail ?? null,
        },
        admin: { exists: adminExists },
      };
    });
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    return { ok: false, ...describeConnectionError(e, conn.parts) };
  }
}

export function saveConfiguration(file: string, conn: SetupConnection, cipher: Cipher): { ok: true } | { ok: false; code: string; message: string } {
  const r = writeConfigV2(file, conn.parts, conn.password, cipher);
  return r.ok ? { ok: true } : { ok: false, code: r.code, message: r.message };
}

/** Creates the first administrator. Refuses when the schema is not current or an active administrator already exists. */
export async function createFirstAdmin(input: FirstAdminInput, appPath: string): Promise<{ ok: true; id: number; name: string }> {
  const { connection, name, pin } = input;
  try {
    return await withClient(connection, async (c) => {
      const state = await checkSchema(c, path.join(appPath, "drizzle"));
      if (state.status !== "ok") throw new BusinessError("ESQUEMA_NO_LISTO", "La base de datos aún no tiene el esquema que esta versión necesita: aplica las migraciones primero (docs/OPERATIONS.md)");
      await c.query("begin");
      try {
        await c.query("select pg_advisory_xact_lock($1)", [USER_ADMIN_LOCK_KEY]);
        const admins = (await c.query("select count(*)::int as n from users where role = 'admin' and active")).rows[0].n as number;
        if (admins > 0) throw new BusinessError("ADMIN_YA_EXISTE", "Ya existe un administrador activo: usa la pantalla Usuarios para crear otros");
        // logical PIN uniqueness across every user, active or not (salted hashes make the unique index useless for this)
        const all = (await c.query("select pin_hash from users")).rows as { pin_hash: string }[];
        if ((await Promise.all(all.map((u) => verifyPin(pin, u.pin_hash)))).some(Boolean)) {
          throw new BusinessError("PIN_EN_USO", "Ese PIN no está disponible; elige otro");
        }
        const inserted = (await c.query("insert into users(name, pin_hash, role) values($1, $2, 'admin') returning id, name", [name, await hashPin(pin)])).rows[0];
        await c.query("commit");
        return { ok: true as const, id: inserted.id as number, name: inserted.name as string };
      } catch (e) {
        await c.query("rollback").catch(() => {});
        throw e;
      }
    });
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    const d = describeConnectionError(e, connection.parts);
    throw new BusinessError(d.code, d.message);
  }
}

