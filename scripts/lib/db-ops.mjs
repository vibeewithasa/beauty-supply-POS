// Operational database tools shared by the administrative scripts (db-backup, db-restore, db-migrate, db-roles) and
// the tests: verified pg_dump backups, restore into a NEW database only, explicit migrations, retention.
//
// Rules this module enforces:
//   * credentials are passed to the PostgreSQL tools through the environment (PGPASSWORD), never on a command line,
//     and are scrubbed from every message it produces;
//   * a backup never overwrites an existing file; it is verified (pg_restore -l, size, checksum) before it counts;
//   * a restore only ever CREATES a database that does not exist yet, never touches an existing one, and on failure
//     drops only the database it created itself;
//   * only loopback servers unless POS_ALLOW_REMOTE_DB=1.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { checkSchema, readJournal } from "./schema-state.mjs";

export const PROTECTED_DATABASES = new Set(["beauty_pos", "beauty_pos_smoke", "postgres", "template0", "template1"]);
export const DB_NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const BACKUP_NAME_RE = (db) => new RegExp(`^${db}_[a-z0-9-]{1,40}_\\d{8}T\\d{6}Z\\.dump$`);

export class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ connection helpers
export function parseConnection(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new OpsError("URL_INVALIDA", "DATABASE_URL no es una URL válida");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new OpsError("URL_INVALIDA", "DATABASE_URL debe usar postgresql://");
  return {
    host: u.hostname,
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

export function assertLocal(conn, env = process.env) {
  if (env.POS_ALLOW_REMOTE_DB === "1") return;
  if (!LOOPBACK.has(conn.host)) {
    throw new OpsError("SERVIDOR_NO_LOCAL", `El servidor "${conn.host}" no es local; define POS_ALLOW_REMOTE_DB=1 solo para una red local de confianza`);
  }
}

export function urlWithDatabase(urlString, database) {
  const u = new URL(urlString);
  u.pathname = "/" + database;
  return u.toString();
}

/** Removes the password and any connection URL from a message. */
export function scrub(text, urlString) {
  let t = String(text ?? "");
  try {
    const c = parseConnection(urlString);
    for (const secret of [c.password, encodeURIComponent(c.password), urlString]) if (secret && secret.length > 2) t = t.split(secret).join("***");
  } catch {
    /* no url to learn secrets from */
  }
  return t.replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
}

const pgEnv = (conn) => {
  const env = { ...process.env, PGPASSWORD: conn.password, PGCONNECT_TIMEOUT: "10" };
  delete env.DATABASE_URL;
  return env;
};

// ------------------------------------------------------------------ PostgreSQL client tools
export function findPgBin(env = process.env) {
  const exe = (name) => (process.platform === "win32" ? name + ".exe" : name);
  const has = (dir) => dir && fs.existsSync(path.join(dir, exe("pg_dump"))) && fs.existsSync(path.join(dir, exe("pg_restore")));
  for (const dir of [env.POS_PG_BIN, env.PG_BIN]) if (has(dir)) return dir;
  for (const dir of (env.PATH || "").split(path.delimiter)) if (has(dir)) return dir;
  if (process.platform === "win32") {
    const root = path.join(env.ProgramFiles || "C:/Program Files", "PostgreSQL");
    if (fs.existsSync(root)) {
      const versions = fs.readdirSync(root).filter((d) => /^\d+/.test(d)).sort((a, b) => parseInt(b) - parseInt(a));
      for (const v of versions) if (has(path.join(root, v, "bin"))) return path.join(root, v, "bin");
    }
  }
  throw new OpsError("PG_TOOLS", "No se encontraron pg_dump/pg_restore. Instala las herramientas de PostgreSQL o define POS_PG_BIN con su carpeta bin");
}
const tool = (bin, name) => path.join(bin, process.platform === "win32" ? name + ".exe" : name);

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** pg_restore -l: proves the file is a readable custom-format archive. */
export function listDump(file, bin) {
  const r = spawnSync(tool(bin, "pg_restore"), ["-l", file], { encoding: "utf8" });
  if (r.status !== 0) throw new OpsError("DUMP_INVALIDO", "El archivo no es un respaldo válido de PostgreSQL (pg_restore -l falló)");
  const lines = r.stdout.split("\n").filter((l) => l && !l.startsWith(";"));
  return { entries: lines.length, tableData: lines.filter((l) => / TABLE DATA public /.test(l)).length };
}

// ------------------------------------------------------------------ inspection (read-only)
export async function inspectDatabase(client, { rows = false } = {}) {
  await client.query("begin read only");
  try {
    const server = (await client.query("show server_version")).rows[0].server_version;
    const tables = (await client.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")).rows.map((r) => r.table_name);
    const counts = {};
    const rowHashes = {};
    for (const t of tables) {
      counts[t] = (await client.query(`select count(*)::int n from "${t}"`)).rows[0].n;
      if (rows) {
        const hasId = (await client.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='id'", [t])).rowCount > 0;
        rowHashes[t] = (await client.query(`select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by ${hasId ? "x.id" : "to_jsonb(x)::text"}), '')) m from "${t}" x`)).rows[0].m;
      }
    }
    const fp = await client.query(`select md5(string_agg(s, E'\\n' order by s)) m from (
        select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as s
          from information_schema.columns where table_schema='public'
        union all select 'idx ' || indexdef from pg_indexes where schemaname='public'
        union all select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || case when contype = 'c'
              -- PostgreSQL prints the same CHECK differently after a dump/restore (casts, parentheses): compare it without them
              then replace(translate(regexp_replace(lower(pg_get_constraintdef(oid)), '::[a-z_ ]+', '', 'g'), '()[] ', ''), 'array', '')
              else pg_get_constraintdef(oid) end
          from pg_constraint where connamespace='public'::regnamespace
      ) q`);
    const migrations = (await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null ok")).rows[0].ok
      ? (await client.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n
      : null;
    return { server, tables, counts, rowHashes: rows ? rowHashes : undefined, schemaFingerprint: fp.rows[0].m, migrations };
  } finally {
    await client.query("rollback");
  }
}

async function withClient(urlString, fn, appName = "pos_ops") {
  const client = new pg.Client({ connectionString: urlString, application_name: appName });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// ------------------------------------------------------------------ backup
export function sanitizeLabel(label) {
  const l = String(label ?? "manual").toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(l)) throw new OpsError("ETIQUETA_INVALIDA", "La etiqueta solo admite letras minúsculas, números y guiones (máximo 40)");
  return l;
}
const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
export const backupFileName = (db, label, date = new Date()) => `${db}_${sanitizeLabel(label)}_${stamp(date)}.dump`;

/**
 * Takes a verified custom-format backup of the database in `url` into `outDir` (outside the repository).
 * Returns the summary that is also written next to the dump. Never overwrites an existing file.
 */
export async function backupDatabase({ url, outDir, label = "manual", keep = 0, bin = findPgBin(), env = process.env, now = new Date() }) {
  const conn = parseConnection(url);
  assertLocal(conn, env);
  if (!DB_NAME_RE.test(conn.database)) throw new OpsError("BASE_INVALIDA", "El nombre de la base de datos no es válido");
  if (!outDir) throw new OpsError("DESTINO_REQUERIDO", "Indica la carpeta de destino del respaldo");
  const dir = path.resolve(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, backupFileName(conn.database, label, now));
  const partial = final + ".partial";
  if (fs.existsSync(final) || fs.existsSync(partial)) throw new OpsError("YA_EXISTE", "Ya existe un respaldo con ese nombre; no se sobrescribe");

  let inspection;
  try {
    inspection = await withClient(url, (c) => inspectDatabase(c), "pos_backup_inspect");
  } catch (e) {
    throw new OpsError("CONEXION", "No se pudo leer la base de datos: " + scrub(e.message, url));
  }
  const dump = spawnSync(tool(bin, "pg_dump"), ["-h", conn.host, "-p", conn.port, "-U", conn.user, "-d", conn.database, "-Fc", "--no-password", "-f", partial], { env: pgEnv(conn), encoding: "utf8" });
  if (dump.status !== 0) {
    fs.rmSync(partial, { force: true });
    throw new OpsError("PG_DUMP", "pg_dump falló: " + scrub(dump.stderr, url).trim().slice(0, 300));
  }
  let toc;
  try {
    toc = listDump(partial, bin);
    const size = fs.statSync(partial).size;
    if (size < 512) throw new OpsError("DUMP_INVALIDO", "El respaldo generado es sospechosamente pequeño");
    if (toc.tableData < inspection.tables.length) throw new OpsError("DUMP_INCOMPLETO", `El respaldo contiene ${toc.tableData} tablas con datos y la base tiene ${inspection.tables.length}`);
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw e;
  }
  if (fs.existsSync(final)) {
    fs.rmSync(partial, { force: true });
    throw new OpsError("YA_EXISTE", "Ya existe un respaldo con ese nombre; no se sobrescribe");
  }
  fs.renameSync(partial, final);
  const summary = {
    tool: "pos-db-backup/1",
    createdAt: now.toISOString(),
    database: conn.database,
    file: path.basename(final),
    serverVersion: inspection.server,
    pgDumpVersion: execFileSync(tool(bin, "pg_dump"), ["--version"], { encoding: "utf8" }).trim(),
    migrationsApplied: inspection.migrations,
    schemaFingerprint: inspection.schemaFingerprint,
    counts: inspection.counts,
    tocEntries: toc.entries,
    sizeBytes: fs.statSync(final).size,
    sha256: sha256File(final),
  };
  fs.writeFileSync(final.replace(/\.dump$/, ".summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  const pruned = keep > 0 ? pruneBackups(dir, conn.database, keep) : { kept: [], deleted: [] };
  return { file: final, summary, pruned };
}

/** Keeps the newest `keep` backups made by this tool for `db` in `dir`; never touches any other file. */
export function pruneBackups(dir, db, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new OpsError("RETENCION_INVALIDA", "La retención debe ser un entero mayor o igual a 1");
  const re = BACKUP_NAME_RE(db);
  const mine = fs.readdirSync(dir).filter((f) => re.test(f)).sort((a, b) => (b.match(/_(\d{8}T\d{6}Z)\.dump$/)[1]).localeCompare(a.match(/_(\d{8}T\d{6}Z)\.dump$/)[1]));
  const kept = mine.slice(0, keep);
  const deleted = mine.slice(keep);
  for (const f of deleted) {
    fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, f.replace(/\.dump$/, ".summary.json")), { force: true });
  }
  return { kept, deleted };
}

// ------------------------------------------------------------------ restore (new database only)
export function validateRestoreTarget(target, sourceDb) {
  if (typeof target !== "string" || !DB_NAME_RE.test(target)) throw new OpsError("DESTINO_INVALIDO", "El nombre de la base nueva debe ser minúsculas/números/guion bajo, empezar con letra (3 a 63 caracteres)");
  if (PROTECTED_DATABASES.has(target)) throw new OpsError("DESTINO_PROTEGIDO", `"${target}" es una base protegida: la restauración nunca se hace sobre ella`);
  if (target === sourceDb) throw new OpsError("DESTINO_PROTEGIDO", "La base nueva no puede ser la base configurada");
}

/**
 * Restores `file` into a database named `target` that this call CREATES. Refuses when it already exists. Verifies the
 * checksum against the summary next to the dump, the table counts, the migrations and the schema fingerprint.
 * On any failure the database it created is dropped (and only that one).
 */
export async function restoreToNewDatabase({ url, file, target, bin = findPgBin(), env = process.env, verify = true }) {
  const conn = parseConnection(url);
  assertLocal(conn, env);
  validateRestoreTarget(target, conn.database);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new OpsError("ARCHIVO", "No se encontró el archivo de respaldo");
  const sum = file.replace(/\.dump$/, ".summary.json");
  const expected = fs.existsSync(sum) ? JSON.parse(fs.readFileSync(sum, "utf8")) : null;
  const sha = sha256File(file);
  if (expected && expected.sha256 !== sha) throw new OpsError("CHECKSUM", "El checksum del respaldo no coincide con su resumen: el archivo está dañado o fue modificado");
  listDump(file, bin);

  const adminUrl = urlWithDatabase(url, "postgres");
  let created = false;
  try {
    await withClient(adminUrl, async (admin) => {
      const exists = await admin.query("select 1 from pg_database where datname=$1", [target]);
      if (exists.rowCount) throw new OpsError("DESTINO_EXISTE", `La base "${target}" ya existe: la restauración solo crea bases nuevas`);
      await admin.query(`CREATE DATABASE "${target}"`);
      created = true;
    }, "pos_restore_admin");
    const r = spawnSync(tool(bin, "pg_restore"), ["-h", conn.host, "-p", conn.port, "-U", conn.user, "-d", target, "--no-password", "--no-owner", "--no-privileges", "--exit-on-error", file], { env: pgEnv(conn), encoding: "utf8" });
    if (r.status !== 0) throw new OpsError("PG_RESTORE", "pg_restore falló: " + scrub(r.stderr, url).trim().slice(0, 300));
    const report = await withClient(urlWithDatabase(url, target), (c) => inspectDatabase(c, { rows: true }), "pos_restore_verify");
    const checks = [];
    if (verify && expected) {
      checks.push(["tablas y filas", JSON.stringify(expected.counts) === JSON.stringify(report.counts)]);
      checks.push(["huella del esquema", expected.schemaFingerprint === report.schemaFingerprint]);
      checks.push(["migraciones aplicadas", expected.migrationsApplied === report.migrations]);
    }
    const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
    if (failed.length) throw new OpsError("VERIFICACION", "La restauración no coincide con el respaldo: " + failed.join(", "));
    return { target, sha256: sha, counts: report.counts, rowHashes: report.rowHashes, schemaFingerprint: report.schemaFingerprint, migrations: report.migrations, verified: Boolean(verify && expected), checks: checks.map(([n, ok]) => ({ check: n, ok })) };
  } catch (e) {
    if (created) {
      try {
        await withClient(adminUrl, (a) => a.query(`DROP DATABASE "${target}" WITH (FORCE)`), "pos_restore_cleanup");
      } catch {
        /* the failure below is the one that matters */
      }
    }
    if (e instanceof OpsError) throw e;
    throw new OpsError("RESTAURACION", scrub(e.message, url));
  }
}

// ------------------------------------------------------------------ migrations (explicit)
/** True when the public schema already holds user tables (i.e. not a brand-new database). */
export async function hasUserTables(client) {
  const r = await client.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
  return r.rows[0].n > 0;
}

export async function schemaStatus(url, folder) {
  return withClient(url, (c) => checkSchema(c, folder), "pos_schema_status");
}

/** Applies the pending migrations with drizzle. This is the ONLY place that changes a schema. */
export async function applyMigrations(url, folder) {
  const pool = new pg.Pool({ connectionString: url, max: 1, application_name: "pos_migrator" });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
  return readJournal(folder).length;
}

// ------------------------------------------------------------------ least-privilege runtime role
// The application only verifies the schema now, so its runtime connection does not need to own the tables or create
// anything. This creates a login role that can read and write data and nothing else (no DDL, no TRUNCATE, no role or
// database creation). Migrations keep using the owner connection through scripts/db-migrate.mjs.
export const ROLE_NAME_RE = /^pos_[a-z0-9_]{2,40}$/;
export const ROLE_COMMENT = "pos-db-roles runtime role";

/** The grants (as SQL, with the role quoted) a runtime role needs; run after every migration to cover new tables. */
export function runtimeGrantSql(role, database) {
  if (!ROLE_NAME_RE.test(role)) throw new OpsError("ROL_INVALIDO", "El rol debe llamarse pos_<nombre> (minúsculas, números, guion bajo)");
  if (!DB_NAME_RE.test(database)) throw new OpsError("BASE_INVALIDA", "El nombre de la base de datos no es válido");
  const r = '"' + role + '"';
  return [
    'GRANT CONNECT ON DATABASE "' + database + '" TO ' + r,
    "GRANT USAGE ON SCHEMA public TO " + r,
    "GRANT USAGE ON SCHEMA drizzle TO " + r,
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO " + r,
    "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO " + r,
    "GRANT SELECT ON drizzle.__drizzle_migrations TO " + r,
  ];
}

/**
 * Creates a NEW runtime role (refuses when the name is taken: existing roles are never altered) and grants it the
 * minimum. The password is generated by the caller and passed in; it is never printed here.
 */
export async function createRuntimeRole(ownerUrl, { role, password, database }) {
  if (!password || password.length < 12) throw new OpsError("CLAVE_DEBIL", "La contraseña del rol debe tener al menos 12 caracteres");
  const sql = runtimeGrantSql(role, database);
  await withClient(urlWithDatabase(ownerUrl, database), async (c) => {
    const exists = await c.query("select 1 from pg_roles where rolname=$1", [role]);
    if (exists.rowCount) throw new OpsError("ROL_EXISTE", 'El rol "' + role + '" ya existe: esta herramienta no modifica roles existentes');
    const create = await c.query("select format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', $1::text, $2::text) as q", [role, password]);
    await c.query(create.rows[0].q);
    const comment = await c.query("select format('COMMENT ON ROLE %I IS %L', $1::text, $2::text) as q", [role, ROLE_COMMENT]);
    await c.query(comment.rows[0].q);
    for (const stmt of sql) await c.query(stmt);
  }, "pos_roles");
}

/** Re-applies the grants to a role THIS tool created (for example after a migration added tables). */
export async function regrantRuntimeRole(ownerUrl, { role, database }) {
  const sql = runtimeGrantSql(role, database);
  await withClient(urlWithDatabase(ownerUrl, database), async (c) => {
    const r = await c.query("select shobj_description(oid, 'pg_authid') as c from pg_roles where rolname=$1", [role]);
    if (!r.rowCount || r.rows[0].c !== ROLE_COMMENT) throw new OpsError("ROL_AJENO", 'El rol "' + role + '" no fue creado por esta herramienta: no se modifica');
    for (const stmt of sql) await c.query(stmt);
  }, "pos_roles");
}

/** Drops a role this tool created (used by tests for their temporary roles). Refuses any other role. */
export async function dropRuntimeRole(ownerUrl, role) {
  if (!ROLE_NAME_RE.test(role)) throw new OpsError("ROL_INVALIDO", "Rol no válido");
  await withClient(urlWithDatabase(ownerUrl, "postgres"), async (c) => {
    const r = await c.query("select shobj_description(oid, 'pg_authid') as c from pg_roles where rolname=$1", [role]);
    if (!r.rowCount) return;
    if (r.rows[0].c !== ROLE_COMMENT) throw new OpsError("ROL_AJENO", 'El rol "' + role + '" no fue creado por esta herramienta: no se elimina');
    const drop = await c.query("select format('DROP ROLE %I', $1::text) as q", [role]);
    await c.query(drop.rows[0].q);
  }, "pos_roles");
}

export { withClient };
