// Prepares, and later maintains, the dedicated PostgreSQL instance of Estetica Leal POS (docs/SELF_CONTAINED_INSTALLER.md).
//
//   provisionManagedInstance   first installation: runtime copy -> cluster -> database -> schema -> app role -> data -> protected config
//   backupManaged / updateSchema / resetDemo   explicit administrative operations (the application itself never does these)
//
// Safety rules enforced here (and tested against a real PostgreSQL):
//   * only resources THIS installer created are ever changed or removed (installId marker + cluster system identifier + database comment),
//   * a failed run undoes only what that run created; a ready installation is never touched by provisioning,
//   * the app is never migrated at startup: schema changes happen here, after a verified backup,
//   * no secret is written to a log, a manifest or a command line (the superuser password travels in a temp file that is deleted and checked).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashPin } from "../../src/backend/pin-hash.ts";
import { DB_NAME_RE, OpsError, PROTECTED_DATABASES, applyMigrations, backupDatabase, createRuntimeRole, dropRuntimeRole, regrantRuntimeRole, schemaStatus, withClient } from "./db-ops.mjs";
import { seedDemo, validateDemoPins } from "./demo-seed.mjs";
import {
  MANAGED_COMMENT_PREFIX, MANIFEST_SCHEMA, ManagedError, PORT_FIRST, PORT_LAST, SUPERUSER, adminUrl, auditClusterConfig, connectionUrl, choosePort, clusterRunning, ensureRunning, initCluster,
  installRuntime, layoutFor, preflight, randomSecret, readManifest, scrubSecrets, secureDirectory, startCluster, stopCluster, systemIdentifier, verifyOwnership, writeManifest, readMarker,
} from "./managed-pg.mjs";

export const MODES = {
  demo: { database: "beauty_pos_demo", role: "pos_demo_runtime", label: "Demostración" },
  clean: { database: "estetica_leal_pos", role: "pos_leal_runtime", label: "Instalación limpia" },
};
export const RESET_CONFIRMATION = "REINICIAR";
export const PIN_RE = /^\d{6,8}$/;

export function validateInputs(mode, input) {
  if (!MODES[mode]) throw new ManagedError("MODO_INVALIDO", "El modo debe ser demostración o instalación limpia");
  if (mode === "demo") {
    validateDemoPins(input?.adminPin, input?.vendorPin);
  } else {
    const name = typeof input?.adminName === "string" ? input.adminName.trim() : "";
    // eslint-disable-next-line no-control-regex
    if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new ManagedError("NOMBRE_INVALIDO", "El nombre del administrador es obligatorio (máximo 120 caracteres)");
    if (typeof input?.adminPin !== "string" || !PIN_RE.test(input.adminPin)) throw new ManagedError("PIN_INVALIDO", "El PIN debe tener de 6 a 8 dígitos");
  }
}

function makeLogger(layout, secrets) {
  fs.mkdirSync(layout.logs, { recursive: true });
  const file = path.join(layout.logs, "provision-" + new Date().toISOString().replace(/[:.]/g, "-") + ".log");
  const write = (line) => fs.appendFileSync(file, `${new Date().toISOString()} ${scrubSecrets(line, secrets)}\n`);
  return { file, write };
}

const quote = (name) => {
  if (!DB_NAME_RE.test(name) || PROTECTED_DATABASES.has(name)) throw new ManagedError("BASE_INVALIDA", "Nombre de base no permitido");
  return '"' + name + '"';
};
const managedComment = (mode, installId) => `${MANAGED_COMMENT_PREFIX}${mode}:${installId}`;

/** Creates the database, applies the schema, creates the app role and loads the data of `mode`. Used by installation and by the demo reset. */
async function buildDatabase({ port, adminPassword, mode, installId, migrationsDir, runtimePassword, input, log }) {
  const { database, role } = MODES[mode];
  const toAdmin = (db) => adminUrl({ port, password: adminPassword, database: db });
  await withClient(toAdmin("postgres"), async (c) => {
    const v = (await c.query("select current_setting('server_version_num')::int n")).rows[0].n;
    if (v < 120000) throw new ManagedError("VERSION", "PostgreSQL es demasiado antiguo");
    if ((await c.query("select 1 from pg_database where datname=$1", [database])).rowCount) throw new ManagedError("BASE_EXISTE", `La base "${database}" ya existe: no se modifica`);
    await c.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'`);
    const comment = (await c.query("select format('COMMENT ON DATABASE %I IS %L', $1::text, $2::text) q", [database, managedComment(mode, installId)])).rows[0].q;
    await c.query(comment);
  }, "pos_install");
  log(`database ${database} created`);
  await applyMigrations(toAdmin(database), migrationsDir);
  const st = await schemaStatus(toAdmin(database), migrationsDir);
  if (st.status !== "ok") throw new ManagedError("ESQUEMA", `La base quedó en estado "${st.status}" tras migrar`);
  log(`schema applied (${st.applied} migrations)`);
  await createRuntimeRole(toAdmin("postgres"), { role, password: runtimePassword, database });
  log(`runtime role ${role} created`);
  let seeded;
  if (mode === "demo") {
    seeded = await withClient(toAdmin(database), (c) => seedDemo(c, { adminPin: input.adminPin, vendorPin: input.vendorPin }), "pos_install_seed");
  } else {
    const hash = await hashPin(input.adminPin);
    await withClient(toAdmin(database), async (c) => {
      const used = (await c.query("select (select count(*) from users)::int u, (select count(*) from products)::int p, (select count(*) from sales)::int s")).rows[0];
      if (used.u + used.p + used.s > 0) throw new ManagedError("BASE_CON_DATOS", "La base nueva debe estar vacía");
      await c.query("insert into users(name, pin_hash, role) values($1,$2,'admin')", [input.adminName.trim(), hash]);
    }, "pos_install_seed");
    seeded = { users: 1, products: 0, sales: 0, returns: 0, sessions: 0 };
  }
  log(`data loaded: ${JSON.stringify(seeded)}`);
  return { database, role, migrations: st.applied, seeded };
}

/** Removes what a previous unfinished run of THIS installer left (proved by its marker); refuses anything else. */
async function cleanLeftovers(layout, previous, log) {
  const runtimeDir = path.join(layout.root, previous.postgres?.runtimeDir ?? "runtime");
  const dataExists = fs.existsSync(layout.data);
  if (dataExists) {
    const marker = readMarker(layout);
    if (!marker || marker.installId !== previous.installId) throw new ManagedError("CARPETA_AJENA", "La carpeta de datos no pertenece al intento anterior de este instalador: no se borra.");
    if (fs.existsSync(path.join(runtimeDir, "bin", "pg_ctl.exe"))) {
      try { stopCluster({ layout, runtimeDir, mode: "immediate" }); } catch { /* not running */ }
    }
    fs.rmSync(layout.data, { recursive: true, force: true });
    log("removed leftover data folder of the failed attempt");
  }
  fs.rmSync(layout.tmp, { recursive: true, force: true });
  fs.rmSync(layout.adminSecret, { force: true });
}

/**
 * Installs the dedicated instance. `persist({ connection, adminPassword })` must store the connection (protected by Windows) and the
 * superuser password; if it throws, the whole installation is undone. Resolves with { layout, manifest, connection, summary }.
 */
export async function provisionManagedInstance({ root, bundleDir, migrationsDir, mode, input, appVersion = "0.0.0", onStep = () => {}, persist, unpersist = async () => {}, minFreeBytes, portFirst = PORT_FIRST, portLast = PORT_LAST }) {
  validateInputs(mode, input);
  const layout = layoutFor(root);
  const adminPassword = randomSecret(24);
  const runtimePassword = randomSecret(24);
  const secrets = [adminPassword, runtimePassword, input.adminPin, input.vendorPin];
  const undo = [];
  let manifest = null;
  let logger = null;
  let current = { id: "preflight", label: "Comprobaciones previas" };
  const step = async (id, label, fn) => {
    current = { id, label };
    onStep({ id, label, status: "running" });
    logger?.write(`STEP ${id} start`);
    try {
      const r = await fn();
      onStep({ id, label, status: "done" });
      logger?.write(`STEP ${id} done`);
      return r;
    } catch (e) {
      onStep({ id, label, status: "failed" });
      throw e;
    }
  };

  try {
    const pf = await step("preflight", "Comprobaciones previas", async () => {
      const r = await preflight({ layout, bundleDir, minFreeBytes, portFirst, portLast });
      if (!r.ok) throw new ManagedError("PREFLIGHT", r.checks.filter((c) => c.status === "fail").map((c) => c.message).join(" "));
      return r;
    });
    if (pf.existing === "ready") throw new ManagedError("YA_INSTALADO", "Ya existe una instalación de Estética Leal POS: no se vuelve a preparar ni se siembran datos encima.");

    fs.mkdirSync(layout.root, { recursive: true });
    secureDirectory(layout.root);
    logger = makeLogger(layout, secrets);
    logger.write(`provision start mode=${mode} app=${appVersion}`);

    if (pf.existing === "provisioning" || pf.existing === "failed") await cleanLeftovers(layout, pf.manifest, (m) => logger.write(m));

    const installId = crypto.randomUUID();
    const bundleVersion = JSON.parse(fs.readFileSync(path.join(bundleDir, "postgresql-bundle.json"), "utf8"));
    manifest = {
      schema: MANIFEST_SCHEMA, installId, createdAt: new Date().toISOString(), appVersion, state: "provisioning", steps: [],
      postgres: { version: bundleVersion.version, major: bundleVersion.major, runtimeDir: path.join("runtime", bundleVersion.version), dataDir: "data", port: pf.port, systemIdentifier: null, superuser: SUPERUSER },
      database: { name: MODES[mode].database, runtimeRole: MODES[mode].role, mode },
    };
    const mark = (id) => { manifest.steps.push(id); writeManifest(layout, manifest); };
    writeManifest(layout, manifest);
    undo.push(async () => {
      manifest.state = "failed";
      manifest.failedStep = current.id;
      writeManifest(layout, manifest);
    });

    const { runtimeDir, created } = await step("runtime", "Copiando y verificando PostgreSQL", async () => installRuntime(bundleDir, layout));
    if (created) undo.push(async () => fs.rmSync(runtimeDir, { recursive: true, force: true }));
    mark("runtime");

    const port = await choosePort({ first: portFirst, last: portLast }); // checked again right before use
    manifest.postgres.port = port;

    await step("initdb", "Creando la instancia de PostgreSQL", async () => {
      undo.push(async () => {
        try { stopCluster({ layout, runtimeDir, mode: "immediate" }); } catch { /* ignore */ }
        fs.rmSync(layout.data, { recursive: true, force: true });
        fs.rmSync(layout.tmp, { recursive: true, force: true });
      });
      const r = initCluster({ layout, runtimeDir, port, superPassword: adminPassword, installId });
      manifest.postgres.systemIdentifier = r.systemIdentifier;
      mark("initdb");
    });

    await step("start", "Iniciando PostgreSQL", async () => {
      await startCluster({ layout, runtimeDir });
      const own = await verifyOwnership({ layout, manifest, runtimeDir });
      if (!own.ok) throw new ManagedError("NO_PROPIA", own.why);
      mark("start");
    });

    const built = await step("database", mode === "demo" ? "Preparando la base y los datos de demostración" : "Preparando la base de datos limpia", async () =>
      buildDatabase({ port, adminPassword, mode, installId, migrationsDir, runtimePassword, input, log: (m) => logger.write(m) }));
    manifest.schemaMigrations = built.migrations;
    mark("database");

    const connection = { host: "127.0.0.1", port, database: built.database, user: built.role, password: runtimePassword };
    await step("config", "Guardando la configuración protegida", async () => {
      undo.push(async () => { fs.rmSync(layout.adminSecret, { force: true }); await unpersist(); });
      await persist({ connection, adminPassword });
      mark("config");
    });

    await step("verify", "Verificando la instalación", async () => {
      const bad = auditClusterConfig(layout);
      if (bad.length) throw new ManagedError("CONFIG_INSEGURA", bad.join("; "));
      await withClient(connectionUrl({ port, user: built.role, password: runtimePassword, database: built.database }), async (c) => {
        const n = (await c.query("select count(*)::int n from users")).rows[0].n;
        if (n < 1) throw new ManagedError("SIN_USUARIOS", "La base no tiene usuarios");
      }, "pos_install_verify");
    });
    manifest.state = "ready";
    mark("ready");
    logger.write("provision complete");
    return { layout, manifest, connection, summary: built, logFile: logger.file };
  } catch (e) {
    const failure = current;
    logger?.write(`FAILED at ${failure.id}: ${e?.code ?? ""} ${e?.message ?? e}`);
    for (const fn of undo.reverse()) {
      try { await fn(); } catch (u) { logger?.write("undo error: " + (u?.message ?? u)); }
    }
    const message = e instanceof ManagedError || e instanceof OpsError ? e.message : `Error inesperado${e?.code ? " (" + e.code + ")" : ""}`;
    const err = new ManagedError(e?.code && typeof e.code === "string" ? e.code : "FALLO", scrubSecrets(message, secrets));
    err.step = failure;
    err.logFile = logger?.file ?? null;
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ explicit administrative operations
export async function loadManaged(root, { requireReady = true } = {}) {
  const layout = layoutFor(root);
  const manifest = readManifest(layout);
  if (!manifest) throw new ManagedError("SIN_INSTALACION", "No hay una instalación administrada de Estética Leal POS en esta cuenta");
  if (requireReady && manifest.state !== "ready") throw new ManagedError("NO_LISTA", "La instalación no terminó de prepararse");
  const runtimeDir = path.join(layout.root, manifest.postgres.runtimeDir);
  return { layout, manifest, runtimeDir };
}

async function runningAdmin(root, adminPassword) {
  const m = await loadManaged(root);
  const r = await ensureRunning({ layout: m.layout, manifest: m.manifest });
  const own = await verifyOwnership({ layout: m.layout, manifest: m.manifest, runtimeDir: m.runtimeDir });
  if (!own.ok) throw new ManagedError("NO_PROPIA", own.why);
  const url = (db) => adminUrl({ port: r.port, password: adminPassword, database: db });
  await withClient(url("postgres"), async (c) => {
    const live = await verifyOwnership({ layout: m.layout, manifest: m.manifest, runtimeDir: m.runtimeDir, pgClient: c });
    if (!live.ok) throw new ManagedError("NO_PROPIA", live.why);
  }, "pos_manage");
  return { ...m, port: r.port, url };
}

/** A verified pg_dump of the managed database into <root>\backups. Returns { file, summary }. */
export async function backupManaged({ root, adminPassword, label = "manual" }) {
  const m = await runningAdmin(root, adminPassword);
  fs.mkdirSync(m.layout.backups, { recursive: true });
  secureDirectory(m.layout.root);
  const r = await backupDatabase({ url: m.url(m.manifest.database.name), outDir: m.layout.backups, label, bin: path.join(m.runtimeDir, "bin") });
  return { file: r.file, summary: r.summary };
}

/** Applies pending migrations, ONLY after a verified backup, and re-grants the runtime role. */
export async function updateSchema({ root, adminPassword, migrationsDir }) {
  const m = await runningAdmin(root, adminPassword);
  const db = m.manifest.database.name;
  const before = await schemaStatus(m.url(db), migrationsDir);
  if (before.status === "ok") return { changed: false, status: before };
  if (before.status === "newer") throw new ManagedError("ESQUEMA_MAS_NUEVO", "La base tiene una estructura más nueva que esta versión de la aplicación: actualiza la aplicación, no la base.");
  const backup = await backupManaged({ root, adminPassword, label: "pre-migracion" });
  await applyMigrations(m.url(db), migrationsDir);
  await regrantRuntimeRole(m.url("postgres"), { role: m.manifest.database.runtimeRole, database: db });
  const after = await schemaStatus(m.url(db), migrationsDir);
  if (after.status !== "ok") throw new ManagedError("ESQUEMA", "La estructura no quedó al día tras migrar; el respaldo está en " + path.basename(backup.file));
  m.manifest.schemaMigrations = after.applied;
  writeManifest(m.layout, m.manifest);
  return { changed: true, status: after, backup: backup.file };
}

/**
 * Starts the demonstration over. Allowed ONLY for a database that is inequivocally this installer's demonstration (installation mode,
 * database comment with our installId), after typing the confirmation word and after a verified backup. `persist` stores the new
 * runtime password. The demonstration users are recreated with the PINs given now.
 */
export async function resetDemo({ root, adminPassword, confirm, input, migrationsDir, persist, onStep = () => {} }) {
  if (confirm !== RESET_CONFIRMATION) throw new ManagedError("SIN_CONFIRMACION", `Escribe ${RESET_CONFIRMATION} para confirmar`);
  validateInputs("demo", input);
  const m = await runningAdmin(root, adminPassword);
  if (m.manifest.database.mode !== "demo") throw new ManagedError("NO_ES_DEMO", "Esta instalación es limpia: no se puede reiniciar como demostración ni sembrar datos ficticios encima.");
  const { name: database, runtimeRole: role } = m.manifest.database;
  if (database !== MODES.demo.database || role !== MODES.demo.role) throw new ManagedError("NO_ES_DEMO", "La base registrada no es la de demostración gestionada.");
  const comment = await withClient(m.url("postgres"), async (c) => (await c.query("select shobj_description(oid,'pg_database') c from pg_database where datname=$1", [database])).rows[0]?.c ?? null, "pos_manage");
  if (comment !== managedComment("demo", m.manifest.installId)) throw new ManagedError("NO_ES_DEMO", "La base no está marcada como demostración gestionada por esta instalación: no se elimina.");

  const secrets = [adminPassword, input.adminPin, input.vendorPin];
  onStep({ id: "backup", label: "Respaldo previo", status: "running" });
  const backup = await backupManaged({ root, adminPassword, label: "pre-reinicio-demo" });
  onStep({ id: "backup", label: "Respaldo previo", status: "done" });
  const runtimePassword = randomSecret(24);
  try {
    onStep({ id: "drop", label: "Quitando la demostración anterior", status: "running" });
    await withClient(m.url("postgres"), async (c) => {
      await c.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`);
    }, "pos_manage");
    await dropRuntimeRole(m.url("postgres"), role);
    onStep({ id: "drop", label: "Quitando la demostración anterior", status: "done" });
    onStep({ id: "rebuild", label: "Cargando la demostración de nuevo", status: "running" });
    const built = await buildDatabase({ port: m.port, adminPassword, mode: "demo", installId: m.manifest.installId, migrationsDir, runtimePassword, input, log: () => {} });
    await persist({ connection: { host: "127.0.0.1", port: m.port, database: built.database, user: built.role, password: runtimePassword }, adminPassword });
    onStep({ id: "rebuild", label: "Cargando la demostración de nuevo", status: "done" });
    return { backup: backup.file, summary: built };
  } catch (e) {
    const msg = scrubSecrets(e?.message ?? String(e), [...secrets, runtimePassword]);
    throw new ManagedError("REINICIO_FALLIDO", `El reinicio no terminó (${msg}). El respaldo previo está en ${backup.file} y se puede restaurar.`);
  }
}

export { clusterRunning, stopCluster, startCluster, systemIdentifier };

/** What the maintenance window shows. Read only. */
export async function managedStatus({ root, adminPassword, migrationsDir }) {
  const m = await runningAdmin(root, adminPassword);
  const db = m.manifest.database.name;
  const schema = await schemaStatus(m.url(db), migrationsDir);
  let backups = [];
  try {
    backups = fs.readdirSync(m.layout.backups).filter((f) => f.endsWith(".dump")).sort().reverse();
  } catch { /* no backups yet */ }
  return {
    mode: m.manifest.database.mode,
    database: db,
    port: m.port,
    postgresVersion: m.manifest.postgres.version,
    installedAt: m.manifest.createdAt,
    schema: { status: schema.status, applied: schema.applied, required: schema.required },
    backups: { folder: m.layout.backups, count: backups.length, latest: backups[0] ?? null },
    dataFolder: m.layout.data,
  };
}
