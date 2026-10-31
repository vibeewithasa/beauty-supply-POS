// Prepares a LOCAL PostgreSQL server for presenting the POS (the laptop of the demonstration):
//   1. creates a NEW database (it never touches an existing one),
//   2. applies the migrations explicitly (the application itself never migrates),
//   3. creates a least-privilege runtime role for the application,
//   4. loads the FICTIONAL demonstration dataset with an administrator and a seller whose PINs YOU choose.
//
// It is bundled inside the installed application (dist/tools/demo-setup.cjs) and run with the application's own runtime, so the
// laptop needs neither Node.js nor the source code:
//   set ELECTRON_RUN_AS_NODE=1 && "<install folder>\Beauty POS.exe" "<install folder>\resources\app.asar\dist\tools\demo-setup.cjs"
// (the Preparar-Base-Demo.cmd next to it does exactly that and asks for the values). In a development checkout:
//   node --experimental-strip-types scripts/demo-setup.mjs
//
// Everything comes from environment variables (so the secrets never appear on a command line):
//   POS_PG_ADMIN_PASSWORD   password of the PostgreSQL administrator account chosen when PostgreSQL was installed (required)
//   POS_PG_ADMIN_USER       default postgres            POS_PG_HOST default localhost            POS_PG_PORT default 5432
//   POS_DEMO_DATABASE       default beauty_pos_demo     (must NOT exist; protected names are refused)
//   POS_DEMO_ROLE           default pos_demo_runtime    (must NOT exist)
//   POS_DEMO_RUNTIME_PASSWORD  password for that role; if empty a strong one is generated and shown ONCE
//   POS_DEMO_ADMIN_PIN, POS_DEMO_VENDOR_PIN   6 to 8 digits each, different; never stored in clear and never baked into the installer
//   --no-data               create and migrate only (no demonstration dataset, no users)
// Exit code 0 = ready; 1 = nothing usable was left behind (what this run created is removed) and a plain explanation is printed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DB_NAME_RE, OpsError, PROTECTED_DATABASES, ROLE_NAME_RE, applyMigrations, createRuntimeRole, dropRuntimeRole, schemaStatus, withClient } from "./lib/db-ops.mjs";
import { seedDemo, validateDemoPins } from "./lib/demo-seed.mjs";

const here = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
// bundled: <app>/dist/tools/demo-setup.cjs -> <app>/drizzle ; from source: scripts/ -> ../drizzle
const MIGRATIONS = [path.join(here, "..", "..", "drizzle"), path.join(here, "..", "drizzle")].find((p) => fs.existsSync(path.join(p, "meta", "_journal.json")));

const env = process.env;
const opt = (name) => {
  const a = process.argv.find((x) => x.startsWith(name + "="));
  return a ? a.slice(name.length + 1) : undefined;
};
const host = (env.POS_PG_HOST || "localhost").trim();
const port = Number(env.POS_PG_PORT || 5432);
const adminUser = env.POS_PG_ADMIN_USER || "postgres";
const adminPassword = env.POS_PG_ADMIN_PASSWORD ?? "";
const database = opt("--database") || env.POS_DEMO_DATABASE || "beauty_pos_demo";
const role = opt("--role") || env.POS_DEMO_ROLE || "pos_demo_runtime";
const noData = process.argv.includes("--no-data");
const generated = !env.POS_DEMO_RUNTIME_PASSWORD;
const runtimePassword = env.POS_DEMO_RUNTIME_PASSWORD || crypto.randomBytes(15).toString("base64url");

const say = (line = "") => console.log(line);
const urlFor = (db) => {
  const u = new URL("postgresql://placeholder");
  u.hostname = host.replace(/^\[|\]$/g, "");
  u.port = String(port);
  u.username = encodeURIComponent(adminUser);
  u.password = encodeURIComponent(adminPassword);
  u.pathname = "/" + db;
  return u.toString();
};
const secrets = () => [adminPassword, runtimePassword, env.POS_DEMO_ADMIN_PIN, env.POS_DEMO_VENDOR_PIN].filter((s) => s && s.length > 2);
const clean = (text) => secrets().reduce((t, s) => t.split(s).join("***"), String(text)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");

let createdDb = false;
let createdRole = false;
// (an async function, not top-level await: the tool is bundled as CommonJS for the installed application)
async function main() {
try {
  if (!MIGRATIONS) throw new OpsError("SIN_MIGRACIONES", "No se encontró la carpeta de migraciones de esta instalación");
  if (!DB_NAME_RE.test(database)) throw new OpsError("BASE_INVALIDA", "El nombre de la base debe ir en minúsculas, números y guion bajo (empezar con letra, 3 a 63 caracteres)");
  if (PROTECTED_DATABASES.has(database)) throw new OpsError("BASE_PROTEGIDA", `"${database}" es una base protegida: esta herramienta solo crea bases NUEVAS`);
  if (!ROLE_NAME_RE.test(role)) throw new OpsError("ROL_INVALIDO", "El usuario de la aplicación debe llamarse pos_<nombre> (minúsculas, números y guion bajo)");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && env.POS_ALLOW_REMOTE_DB !== "1") throw new OpsError("SERVIDOR_NO_LOCAL", "El servidor debe ser local (localhost)");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OpsError("PUERTO_INVALIDO", "Puerto inválido");
  if (!adminPassword) throw new OpsError("SIN_CLAVE", "Falta la contraseña del administrador de PostgreSQL (POS_PG_ADMIN_PASSWORD)");
  if (!noData) validateDemoPins(env.POS_DEMO_ADMIN_PIN, env.POS_DEMO_VENDOR_PIN);
  if (runtimePassword.length < 12) throw new OpsError("CLAVE_DEBIL", "La contraseña del usuario de la aplicación debe tener al menos 12 caracteres");

  say("== Preparación de la base de demostración de Estética Leal POS");
  say(`Servidor: ${host}:${port}   Base nueva: ${database}   Usuario de la aplicación: ${role}`);

  // 1. connect as the PostgreSQL administrator and check what this server can do
  await withClient(urlFor("postgres"), async (c) => {
    const v = (await c.query("select current_setting('server_version_num')::int as n, current_setting('server_version') as t")).rows[0];
    if (v.n < 120000) throw new OpsError("VERSION", `PostgreSQL ${v.t} es demasiado antiguo: se necesita la versión 12 o superior`);
    const me = (await c.query("select rolcreatedb, rolcreaterole, rolsuper from pg_roles where rolname = current_user")).rows[0];
    if (!me.rolsuper && !(me.rolcreatedb && me.rolcreaterole)) throw new OpsError("PERMISOS", `El usuario "${adminUser}" no puede crear bases de datos y usuarios: usa la cuenta administradora de PostgreSQL`);
    if ((await c.query("select 1 from pg_database where datname = $1", [database])).rowCount) {
      throw new OpsError("BASE_EXISTE", `La base "${database}" ya existe. Esta herramienta nunca modifica una base existente: elige otro nombre (POS_DEMO_DATABASE) o bórrala tú mismo si es solo de pruebas`);
    }
    if ((await c.query("select 1 from pg_roles where rolname = $1", [role])).rowCount) {
      throw new OpsError("ROL_EXISTE", `El usuario "${role}" ya existe. Esta herramienta no modifica usuarios existentes: elige otro nombre (POS_DEMO_ROLE)`);
    }
    say(`PostgreSQL ${v.t}: conexión correcta.`);

    // 2. a NEW database, in UTF-8 whatever the cluster's default locale is (a Windows cluster is often WIN1252)
    const attempts = [
      ["UTF-8, orden en español (ICU)", `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'es-MX'`],
      ["UTF-8, orden por bytes (C)", `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`],
      ["la codificación predeterminada del servidor", `CREATE DATABASE "${database}"`],
    ];
    let used = null;
    for (const [label, sql] of attempts) {
      try {
        await c.query(sql);
        used = label;
        break;
      } catch (e) {
        if (e.code === "42P04") throw e; // exists (race): stop
      }
    }
    if (!used) throw new OpsError("CREAR_BASE", "No se pudo crear la base de datos");
    createdDb = true;
    say(`Base "${database}" creada (${used}).`);
  }, "pos_demo_setup");

  // 3. the schema, applied explicitly and verified
  const owner = urlFor(database);
  await applyMigrations(owner, MIGRATIONS);
  const st = await schemaStatus(owner, MIGRATIONS);
  if (st.status !== "ok") throw new OpsError("ESQUEMA", `La base quedó en estado "${st.status}" tras migrar`);
  say(`Estructura aplicada y verificada (${st.applied} migraciones).`);

  // 4. the application's own login: data only, no DDL, no ownership
  await createRuntimeRole(urlFor("postgres"), { role, password: runtimePassword, database });
  createdRole = true;
  say(`Usuario de la aplicación "${role}" creado con privilegios mínimos (sin permisos de estructura).`);

  // 5. the fictional dataset and the two demonstration users
  let seeded = null;
  if (!noData) {
    seeded = await withClient(owner, (c) => seedDemo(c, { adminPin: env.POS_DEMO_ADMIN_PIN, vendorPin: env.POS_DEMO_VENDOR_PIN }), "pos_demo_seed");
    say(`Datos ficticios cargados: ${seeded.products} productos, ${seeded.sessions} cajas de días anteriores, ${seeded.sales} ventas, ${seeded.returns} devoluciones, 2 usuarios.`);
  } else {
    say("Sin datos de demostración (--no-data): crea el primer administrador desde la ventana de configuración de la aplicación.");
  }

  say();
  say("LISTO. Ahora abre Estética Leal POS; en la ventana de configuración escribe:");
  say(`   Servidor: ${host}     Puerto: ${port}     Base de datos: ${database}`);
  say(`   Usuario: ${role}`);
  say(generated ? `   Contraseña: ${runtimePassword}     (se muestra SOLO ahora: anótala o cópiala a la ventana de configuración)` : "   Contraseña: la que escribiste para el usuario de la aplicación");
  if (!noData) say("   Los PIN de los usuarios \"Administrador Demo\" y \"Vendedor Demo\" son los que acabas de elegir (no se muestran ni se guardan en claro).");
} catch (e) {
  // leave nothing half-made: remove ONLY what this run created
  try {
    if (createdRole) await dropRuntimeRole(urlFor("postgres"), role);
  } catch { /* the failure below is the one that matters */ }
  try {
    if (createdDb) await withClient(urlFor("postgres"), (c) => c.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`), "pos_demo_cleanup");
  } catch { /* ignore */ }
  const code = e && typeof e.code === "string" ? e.code : "";
  let msg = e instanceof OpsError || (e instanceof Error && /^(El |La |No |Falta|Puerto|PostgreSQL|Los |Esta )/.test(e.message)) ? e.message : null;
  if (!msg) {
    if (code === "ECONNREFUSED") msg = `No hay un servidor PostgreSQL escuchando en ${host}:${port}. Comprueba que PostgreSQL esté instalado e iniciado (servicio "postgresql-x64-NN").`;
    else if (code === "28P01") msg = `La contraseña de "${adminUser}" no es correcta.`;
    else if (code === "ENOTFOUND") msg = `No se encontró el servidor "${host}".`;
    else msg = `Error inesperado${code ? ` (código ${code})` : ""}: ${e?.message ?? e}`;
  }
  console.error("No se preparó la base de demostración: " + clean(msg));
  if (createdDb || createdRole) console.error("Se eliminó lo que esta ejecución había creado. Puedes corregir el problema y volver a intentarlo.");
  process.exit(1);
}
}
main();
