// Usage: node e2e/ops.mjs
// Operational tooling checks (no Electron): verified backups, restore into a NEW database only, retention, safe errors,
// and the least-privilege runtime role. Everything runs on throwaway beauty_pos_e2e_* databases and test roles created
// (and removed) by this run. It never connects to beauty_pos, beauty_pos_smoke or any pre-existing database to write.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import {
  ROOT, urlFor, createRunDb, prepareRunDb, dropRunDb, connectRunDb, createRecorder, summarize, expect, scrub,
} from "./lib/harness.mjs";
import {
  backupDatabase, inspectDatabase, listDump, findPgBin, pruneBackups, sha256File, withClient, urlWithDatabase, copyToSecondLocation, validateSecondLocation, restoreToNewDatabase,
  createRuntimeRole, dropRuntimeRole, regrantRuntimeRole, runtimeGrantSql, backupFileName, parseConnection, DB_NAME_RE,
} from "../scripts/lib/db-ops.mjs";

const JOURNAL = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")).entries.length;
const { results, rec, test } = createRecorder("ops", path.join(ROOT, "e2e-artifacts"), () => null);
const tmpDirs = [];
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
const restored = new Set();
const roles = new Set();
const rnd = () => crypto.randomBytes(4).toString("hex");
const J = JSON.stringify;
const one = async (db, sql, p) => (await db.query(sql, p)).rows[0];

async function dropTestDb(name) {
  if (!/^beauty_pos_e2e_[a-z0-9]+$/.test(name) || !restored.has(name)) throw new Error("refusing to drop " + name);
  await withClient(urlWithDatabase(urlFor("x"), "postgres"), (a) => a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`), "e2e_ops_cleanup");
  restored.delete(name);
}
const dbExists = async (name) => withClient(urlWithDatabase(urlFor("x"), "postgres"), async (a) => (await a.query("select 1 from pg_database where datname=$1", [name])).rowCount > 0, "e2e_ops_probe");
const cli = (script, args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};

async function seed(db) {
  await db.query("insert into users(name,pin_hash,role,active) values('Ana Pérez','h-ana','admin',true),('Luis Núñez','h-luis','vendor',true)");
  await db.query("insert into products(sku,name,price,stock,category,barcode) values('OPS-1','Shampoo ñandú 500 ml','125.50',40,'Cabello','750100'),('OPS-2','Tinte \"rojo\" & café','89.90',12,'Color',null)");
  const s = (await one(db, "insert into cash_sessions(opened_by,initial_amount,current_amount,status,opened_at,closed_at,closed_by,final_amount) values(1,'200','1500.50','closed',now() - interval '2 days', now() - interval '1 day',1,'1500.50') returning id")).id;
  const sale = (await one(db, "insert into sales(user_id,cash_session_id,total,payment_method,created_at,operation_id) values(2,$1,'251.00','cash',now() - interval '1 day 3 hours','op-seed-0001') returning id", [s])).id;
  await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,1,2,'125.50','251.00','Shampoo ñandú 500 ml','OPS-1')", [sale]);
  await db.query("insert into cash_movements(session_id,user_id,type,amount,reason) values($1,2,'IN','251.00','Venta #1 - Efectivo'),($1,1,'OUT','50.00','Retiro para cambio')", [s]);
  await db.query("insert into inventory_movements(product_id,type,amount,reason,user_id) values(1,'OUT',-2,'Venta #1',2)");
  const ret = (await one(db, "insert into returns(sale_id,total_refund,refund_status,reason,processed_by) values($1,'125.50','pending','Producto dañado',1) returning id", [sale])).id;
  await db.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values($1,1,1,1,'125.50')", [ret]);
  await db.query("update business_settings set address='Av. Reforma 100, Col. Centro', phone='55 1234 5678', footer_message='¡Vuelva pronto!' where id=1");
}

let src, srcName, srcUrl;
try {
  srcName = await createRunDb();
  await prepareRunDb(srcName);
  srcUrl = urlFor(srcName, "e2e_ops");
  src = await connectRunDb(srcName);
  await seed(src);
  const PG_BIN = findPgBin();
  const password = parseConnection(urlFor("x")).password;
  // A short local password shows up by chance inside hashes and timestamps, so a plain substring test would be flaky:
  // it is only used when long enough; the URL pattern and the strong test passwords below cover the rest.
  const leaks = (text) => /postgres(ql)?:\/\//.test(text) || (password.length >= 8 && text.includes(password));

  // ================================================================== backup -> restore -> compare
  const dirWithSpaces = mkTmp("e2e ops backups with spaces ");
  let backupFile;
  await test("OPS-01.backup_then_restore_into_a_new_database_is_identical_row_by_row", "integration", async () => {
    const r = cli("db-backup.mjs", ["--out", dirWithSpaces, "--label", "test"], { DATABASE_URL: srcUrl });
    expect(r.code === 0, "backup CLI succeeded: " + scrub(r.out).slice(-300));
    const files = fs.readdirSync(dirWithSpaces);
    const dump = files.find((f) => f.endsWith(".dump"));
    expect(dump && new RegExp(`^${srcName}_test_\\d{8}T\\d{6}Z\\.dump$`).test(dump), "named <db>_<label>_<UTC timestamp>.dump: " + files.join());
    backupFile = path.join(dirWithSpaces, dump);
    const summary = JSON.parse(fs.readFileSync(backupFile.replace(/\.dump$/, ".summary.json"), "utf8"));
    expect(summary.sha256 === sha256File(backupFile), "summary checksum matches the file");
    expect(summary.counts.users === 2 && summary.counts.sales === 1 && summary.migrationsApplied === JOURNAL, "summary counts: " + J(summary.counts));
    expect(listDump(backupFile, PG_BIN).tableData >= 11, "pg_restore -l lists the tables with data");
    for (const f of files) {
      const text = fs.readFileSync(path.join(dirWithSpaces, f), "latin1");
      expect(f.endsWith(".dump") ? true : !leaks(text), "no password or URL in " + f);
    }
    expect(!leaks(r.out), "the CLI output does not contain the password or a connection URL");

    const target = "beauty_pos_e2e_restore" + rnd();
    restored.add(target);
    const rr = cli("db-restore.mjs", ["--file", backupFile, "--target", target], { DATABASE_URL: srcUrl });
    expect(rr.code === 0 && /verificación\s+: tablas y filas=OK, huella del esquema=OK, migraciones aplicadas=OK/.test(rr.out), "restore CLI succeeded and verified: " + scrub(rr.out).slice(-300));
    const a = await withClient(srcUrl, (c) => inspectDatabase(c, { rows: true }), "e2e_ops_a");
    const b = await withClient(urlFor(target, "e2e_ops"), (c) => inspectDatabase(c, { rows: true }), "e2e_ops_b");
    expect(J(a.counts) === J(b.counts), "same row counts");
    expect(J(a.rowHashes) === J(b.rowHashes), "same content of every table (row hashes): " + J({ a: a.rowHashes, b: b.rowHashes }));
    expect(a.schemaFingerprint === b.schemaFingerprint && a.migrations === b.migrations, "same schema fingerprint and migrations");
    const u = await withClient(urlFor(target, "e2e_ops"), (c) => c.query("select name from users order by id").then((x) => x.rows.map((y) => y.name)), "e2e_ops_c");
    expect(u[0] === "Ana Pérez" && u[1] === "Luis Núñez", "accents survive: " + J(u));
    await dropTestDb(target);
  });

  await test("OPS-02.a_backup_is_never_overwritten", "integration", async () => {
    const dir = mkTmp("e2e ops overwrite ");
    const now = new Date("2026-01-02T03:04:05Z");
    const first = await backupDatabase({ url: srcUrl, outDir: dir, label: "fixed", now });
    const sha = sha256File(first.file);
    let code = null;
    try { await backupDatabase({ url: srcUrl, outDir: dir, label: "fixed", now }); } catch (e) { code = e.code; }
    expect(code === "YA_EXISTE", "second backup with the same name refused: " + code);
    expect(sha256File(first.file) === sha && fs.readdirSync(dir).filter((f) => f.endsWith(".partial")).length === 0, "the first file is intact and no partial file is left");
  });

  // ================================================================== restore safety
  await test("OPS-03.restore_only_ever_creates_a_new_database", "security", async () => {
    const baseline = async () => J(await withClient(srcUrl, (c) => inspectDatabase(c, { rows: true }), "e2e_ops_base"));
    const before = await baseline();
    for (const [target, why] of [["beauty_pos", "protected"], ["beauty_pos_smoke", "protected"], ["postgres", "protected"], ["template1", "protected"], [srcName, "the configured database"], ["Bad-Name", "invalid"], ["x", "too short"], ["a;drop database postgres", "injection"]]) {
      const r = cli("db-restore.mjs", ["--file", backupFile, "--target", target], { DATABASE_URL: srcUrl });
      expect(r.code === 1 && /No se restauró nada/.test(r.out), `${why} target "${target}" refused: ` + scrub(r.out).slice(-160));
    }
    // an existing, non-protected database is refused and stays untouched
    const other = await createRunDb();
    restored.add(other);
    const od = await connectRunDb(other);
    const r = cli("db-restore.mjs", ["--file", backupFile, "--target", other], { DATABASE_URL: srcUrl });
    expect(r.code === 1 && /ya existe/.test(r.out), "existing database refused: " + scrub(r.out).slice(-160));
    expect((await one(od, "select count(*)::int n from information_schema.tables where table_schema='public'")).n === 0, "the existing database received nothing");
    await od.end();
    await dropRunDb(other);
    restored.delete(other);
    expect((await baseline()) === before, "the source database is unchanged");
  });
  await test("OPS-04.damaged_backups_are_rejected_and_a_failed_restore_drops_only_what_it_created", "security", async () => {
    const dir = mkTmp("e2e ops damaged ");
    // 1) modified file: checksum no longer matches its summary
    const tampered = path.join(dir, path.basename(backupFile));
    fs.copyFileSync(backupFile, tampered);
    fs.copyFileSync(backupFile.replace(/\.dump$/, ".summary.json"), tampered.replace(/\.dump$/, ".summary.json"));
    const buf = fs.readFileSync(tampered);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    fs.writeFileSync(tampered, buf);
    const target = "beauty_pos_e2e_restore" + rnd();
    restored.add(target);
    let r = cli("db-restore.mjs", ["--file", tampered, "--target", target], { DATABASE_URL: srcUrl });
    expect(r.code === 1 && /checksum/i.test(r.out) && !(await dbExists(target)), "checksum mismatch refused, nothing created: " + scrub(r.out).slice(-160));
    // 2) not a backup at all
    const junk = path.join(dir, "junk.dump");
    fs.writeFileSync(junk, "this is not a postgres archive");
    r = cli("db-restore.mjs", ["--file", junk, "--target", target], { DATABASE_URL: srcUrl });
    expect(r.code === 1 && /no es un respaldo válido/.test(r.out) && !(await dbExists(target)), "garbage refused before creating anything: " + scrub(r.out).slice(-160));
    // 3) truncated archive without summary: the table of contents is readable but the data is not -> restore fails AFTER creating the target
    const cut = path.join(dir, "cut.dump");
    fs.writeFileSync(cut, fs.readFileSync(backupFile).subarray(0, Math.floor(fs.statSync(backupFile).size * 0.6)));
    r = cli("db-restore.mjs", ["--file", cut, "--target", target], { DATABASE_URL: srcUrl });
    expect(r.code === 1 && /No se restauró nada/.test(r.out), "truncated archive fails: " + scrub(r.out).slice(-160));
    expect(!(await dbExists(target)), "the database that restore created was dropped again");
    expect(!leaks(r.out), "the error does not leak the password or a URL");
    expect(await dbExists(srcName), "the source database is still there");
    restored.delete(target);
  });

  // ================================================================== retention
  await test("OPS-05.retention_keeps_the_newest_and_never_touches_other_files", "integration", async () => {
    const dir = mkTmp("e2e ops retention ");
    const mk = (name) => fs.writeFileSync(path.join(dir, name), "x");
    const stamps = ["20260101T010101Z", "20260102T010101Z", "20260103T010101Z", "20260104T010101Z", "20260105T010101Z", "20260106T010101Z"];
    for (const t of stamps) { mk(`beauty_pos_e2e_ret_diario_${t}.dump`); mk(`beauty_pos_e2e_ret_diario_${t}.summary.json`); }
    const foreign = ["notes.txt", "otra_base_diario_20260101T010101Z.dump", "beauty_pos_e2e_ret_manual_notastamp.dump", "backup.log", "beauty_pos_e2e_retX_diario_20260101T010101Z.dump"];
    foreign.forEach(mk);
    const r = pruneBackups(dir, "beauty_pos_e2e_ret", 3);
    expect(J(r.kept) === J(stamps.slice(-3).reverse().map((t) => `beauty_pos_e2e_ret_diario_${t}.dump`)), "kept the 3 newest: " + J(r.kept));
    expect(r.deleted.length === 3, "deleted the 3 oldest dumps");
    const left = fs.readdirSync(dir);
    expect(foreign.every((f) => left.includes(f)), "foreign files untouched: " + left.join());
    expect(!left.some((f) => /20260101|20260102|20260103/.test(f) && f.startsWith("beauty_pos_e2e_ret_diario")), "old dumps AND their summaries are gone");
    for (const bad of [0, -1, 1.5, "3", NaN]) {
      let code = null;
      try { pruneBackups(dir, "beauty_pos_e2e_ret", bad); } catch (e) { code = e.code; }
      expect(code === "RETENCION_INVALIDA", "invalid retention " + bad);
    }
    // through the CLI: scheduled-style runs with --keep
    const out = mkTmp("e2e ops scheduled ");
    for (let i = 0; i < 3; i++) {
      const rr = cli("db-backup.mjs", ["--out", out, "--label", "diario", "--keep", "2"], { DATABASE_URL: srcUrl });
      expect(rr.code === 0, "scheduled-style run " + i + ": " + scrub(rr.out).slice(-200));
      await new Promise((res) => setTimeout(res, 1100)); // the file name has one-second resolution
    }
    expect(fs.readdirSync(out).filter((f) => f.endsWith(".dump")).length === 2, "only 2 backups remain after 3 runs with --keep 2");
    expect(/OK .*diario/.test(fs.readFileSync(path.join(out, "backup.log"), "utf8")), "backup.log records the runs");
  });

  // ================================================================== safe errors
  await test("OPS-06.errors_are_safe_and_destinations_are_checked", "security", async () => {
    const dir = mkTmp("e2e ops errors ");
    const wrongPw = new URL(srcUrl);
    wrongPw.password = "definitely-wrong-password-xyz";
    let r = cli("db-backup.mjs", ["--out", dir], { DATABASE_URL: wrongPw.toString() });
    expect(r.code === 1 && /No se generó un respaldo válido/.test(r.out) && !r.out.includes("definitely-wrong-password-xyz") && !leaks(r.out), "wrong password: failed without leaking secrets: " + scrub(r.out).slice(-200));
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".dump") || f.endsWith(".partial")).length === 0, "no file left behind");
    expect(/FALLO/.test(fs.readFileSync(path.join(dir, "backup.log"), "utf8")) && !fs.readFileSync(path.join(dir, "backup.log"), "utf8").includes("definitely-wrong"), "the failure is logged without secrets");
    const remote = new URL(srcUrl);
    remote.hostname = "192.0.2.10";
    r = cli("db-backup.mjs", ["--out", dir], { DATABASE_URL: remote.toString(), POS_ALLOW_REMOTE_DB: "" });
    expect(r.code === 1 && /no es local/.test(r.out), "remote server refused: " + r.out.slice(-160));
    fs.rmSync(path.join(ROOT, "e2e-artifacts", "inside-the-repo"), { recursive: true, force: true });
    r = cli("db-backup.mjs", ["--out", path.join(ROOT, "e2e-artifacts", "inside-the-repo")], { DATABASE_URL: srcUrl });
    expect(r.code === 1 && /fuera del proyecto/.test(r.out) && !fs.existsSync(path.join(ROOT, "e2e-artifacts", "inside-the-repo")), "a destination inside the repository is refused");
    r = cli("db-backup.mjs", ["--out", dir, "--label", "Bad Label!"], { DATABASE_URL: srcUrl });
    expect(r.code === 1 && /etiqueta/i.test(r.out), "invalid label refused");
    r = cli("db-backup.mjs", ["--out", dir, "--keep", "0"], { DATABASE_URL: srcUrl });
    expect(r.code === 1 && /--keep/.test(r.out), "invalid --keep refused");
    let code = null;
    const empty = mkTmp("e2e ops nopg ");
    try { findPgBin({ POS_PG_BIN: empty, PG_BIN: empty, PATH: empty, ProgramFiles: empty }); } catch (e) { code = e.code; }
    expect(code === "PG_TOOLS", "missing pg tools explained: " + code);
    expect(backupFileName("beauty_pos", "diario", new Date("2026-03-04T05:06:07Z")) === "beauty_pos_diario_20260304T050607Z.dump", "file name format");
    expect(DB_NAME_RE.test("beauty_pos_e2e_ok") && !DB_NAME_RE.test("Bad") && !DB_NAME_RE.test("a b"), "database name rule");
  });

  await test("OPS-09.the_task_scheduler_wrapper_makes_a_verified_backup_with_a_path_containing_spaces", "integration", async () => {
    const dir = mkTmp("e2e ops task folder ");
    const r = spawnSync("cmd.exe", ["/c", path.join(ROOT, "scripts", "db-backup-task.cmd")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: srcUrl, POS_BACKUP_DIR: dir } });
    expect(r.status === 0, "wrapper exit code " + r.status + " " + scrub((r.stdout || "") + (r.stderr || "")).slice(-200));
    const files = fs.readdirSync(dir);
    expect(files.some((f) => new RegExp("^" + srcName + "_diario_\\d{8}T\\d{6}Z\\.dump$").test(f)), "a *_diario_* backup exists: " + files.join());
    const log = fs.readFileSync(path.join(dir, "task.log"), "utf8");
    expect(/Respaldo verificado/.test(log) && !/postgres(ql)?:\/\//.test(log), "task.log reports the verified backup without connection details");
  });

  // ================================================================== least-privilege runtime role
  await test("OPS-07.runtime_role_can_run_the_application_queries_but_cannot_change_the_schema", "security", async () => {
    const role = "pos_e2e_rt_" + rnd();
    roles.add(role);
    const pw = crypto.randomBytes(12).toString("base64url");
    const ownerUrl = urlFor(srcName, "e2e_ops_owner");
    await createRuntimeRole(ownerUrl, { role, password: pw, database: srcName });
    const u = new URL(urlFor(srcName, "e2e_ops_rt"));
    u.username = role;
    u.password = pw;
    const rt = new pg.Client({ connectionString: u.toString() });
    await rt.connect();
    try {
      // what the application does
      expect((await rt.query("select count(*)::int n from users")).rows[0].n === 2, "SELECT");
      expect((await rt.query("select hash from drizzle.__drizzle_migrations")).rowCount === JOURNAL, "reads the migration table for the startup check");
      await rt.query("begin");
      await rt.query("select pg_advisory_xact_lock(7481201)");
      await rt.query("select * from products where id=1 for update");
      await rt.query("insert into products(sku,name,price,stock) values('RT-1','runtime','1.00',1)");
      await rt.query("update products set stock=stock+1 where sku='RT-1'");
      await rt.query("insert into inventory_movements(product_id,type,amount,reason,user_id) values((select id from products where sku='RT-1'),'IN',1,'rt',1)");
      await rt.query("delete from inventory_movements where reason='rt'");
      await rt.query("delete from products where sku='RT-1'");
      await rt.query("rollback");
      await rt.query("set timezone = '-06:00'");
      // what it must NOT be able to do
      const denied = async (sql, label) => {
        try { await rt.query(sql); } catch (e) { expect(e.code === "42501", `${label} denied with permission error, got ${e.code}`); return; }
        throw new Error(label + " was allowed");
      };
      await denied("create table rt_hack(id int)", "CREATE TABLE");
      await denied("alter table users add column x int", "ALTER TABLE");
      await denied("drop table business_settings", "DROP TABLE");
      await denied("truncate users", "TRUNCATE");
      await denied("update drizzle.__drizzle_migrations set hash='x'", "tampering with the migrations table");
      await denied("insert into drizzle.__drizzle_migrations(hash,created_at) values('x',1)", "forging a migration row");
      await denied("create schema rt_hack", "CREATE SCHEMA");
      await denied("create role rt_hack", "CREATE ROLE");
      await denied("create database rt_hack", "CREATE DATABASE");
    } finally { await rt.end(); }
    // the role cannot be used to take over an existing role: creating the same role again is refused, and a foreign role is never dropped/regranted
    let c1 = null, c2 = null, c3 = null;
    try { await createRuntimeRole(ownerUrl, { role, password: pw, database: srcName }); } catch (e) { c1 = e.code; }
    try { await regrantRuntimeRole(ownerUrl, { role: "pos_postgres_foreign", database: srcName }); } catch (e) { c2 = e.code; }
    try { await createRuntimeRole(ownerUrl, { role: "pos_weak_pw", password: "short", database: srcName }); } catch (e) { c3 = e.code; }
    expect(c1 === "ROL_EXISTE" && c3 === "CLAVE_DEBIL" && (c2 === "ROL_AJENO"), "existing/foreign roles are not altered: " + J([c1, c2, c3]));
    expect(runtimeGrantSql(role, srcName).every((q) => !/ALL PRIVILEGES|SUPERUSER|CREATE\b/.test(q)), "the grants contain no DDL or ownership privileges");
  });
  await test("OPS-08.role_script_dry_run_changes_nothing_and_never_takes_the_password_from_the_command_line", "security", async () => {
    const before = await withClient(urlWithDatabase(urlFor("x"), "postgres"), async (a) => (await a.query("select count(*)::int n from pg_roles")).rows[0].n, "e2e_ops_roles");
    let r = cli("db-roles.mjs", ["--role", "pos_dry_run_only"], { DATABASE_URL: srcUrl });
    expect(r.code === 0 && /SIMULACI/.test(r.out) && /PASSWORD '\*\*\*'/.test(r.out), "dry run prints the plan with the password masked: " + r.out.slice(0, 120));
    r = cli("db-roles.mjs", ["--role", "pos_dry_run_only", "--apply"], { DATABASE_URL: srcUrl, POS_RUNTIME_PASSWORD: "long-enough-password-1" });
    expect(r.code === 1 && /--confirm-database/.test(r.out) && !r.out.includes("long-enough-password-1"), "--apply needs the confirmation and never echoes the password");
    r = cli("db-roles.mjs", ["--role", "admin", "--apply", "--confirm-database=" + srcName], { DATABASE_URL: srcUrl, POS_RUNTIME_PASSWORD: "long-enough-password-1" });
    expect(r.code === 1 && /pos_<nombre>/.test(r.out), "only pos_* role names are accepted");
    const after = await withClient(urlWithDatabase(urlFor("x"), "postgres"), async (a) => (await a.query("select count(*)::int n from pg_roles")).rows[0].n, "e2e_ops_roles");
    expect(before === after, "no role was created: " + before + " -> " + after);
  });
  // ================================================================== second copy (Sprint 06, block B2)
  await test("OPS-10.a_second_copy_is_made_verified_and_logged_and_the_database_can_be_recovered_from_it", "integration", async () => {
    const primary = mkTmp("e2e ops primary ");
    const second = path.join(mkTmp("e2e ops second parent "), "externo con espacios");
    const r = cli("db-backup.mjs", ["--out", primary, "--label", "dos", "--second-copy", second], { DATABASE_URL: srcUrl });
    expect(r.code === 0 && /Segunda copia verificada/.test(r.out), "CLI exit 0 and says the second copy was verified: " + scrub(r.out).slice(-300));
    const dump = fs.readdirSync(primary).find((f) => f.endsWith(".dump"));
    const sFiles = fs.readdirSync(second).sort();
    expect(J(sFiles) === J([dump, dump.replace(/\.dump$/, ".summary.json")].sort()), "the dump and its summary are in the second location: " + sFiles.join());
    expect(sha256File(path.join(second, dump)) === sha256File(path.join(primary, dump)), "identical SHA-256");
    const log = fs.readFileSync(path.join(primary, "backup.log"), "utf8");
    expect(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z OK .* second=verified dir=/m.test(log), "the date and the result of both copies are logged: " + log.trim());
    expect(!leaks(log) && !leaks(r.out), "no password or URL in the log or the output");
    for (const f of sFiles) expect(f.endsWith(".dump") || !leaks(fs.readFileSync(path.join(second, f), "latin1")), "no secret in " + f);
    // recovery FROM the second copy, into a new database, verified row by row
    const target = "beauty_pos_e2e_second" + rnd();
    restored.add(target);
    const rr = cli("db-restore.mjs", ["--file", path.join(second, dump), "--target", target], { DATABASE_URL: srcUrl });
    expect(rr.code === 0 && /tablas y filas=OK, huella del esquema=OK, migraciones aplicadas=OK/.test(rr.out), "restore from the second copy verified: " + scrub(rr.out).slice(-300));
    const a = await withClient(srcUrl, (c) => inspectDatabase(c, { rows: true }), "e2e_ops_a");
    const b = await withClient(urlWithDatabase(srcUrl, target), (c) => inspectDatabase(c, { rows: true }), "e2e_ops_b");
    expect(J(a.counts) === J(b.counts) && J(a.rowHashes) === J(b.rowHashes) && a.schemaFingerprint === b.schemaFingerprint, "the recovered database equals the original");
    await dropTestDb(target);
  });
  await test("OPS-11.the_second_location_is_never_overwritten_or_pruned_and_a_corrupt_copy_is_refused", "security", async () => {
    const primary = mkTmp("e2e ops primary2 ");
    const second = mkTmp("e2e ops second2 ");
    fs.writeFileSync(path.join(second, "historico-viejo.dump"), "an old backup the tool did not make");
    const r1 = await backupDatabase({ url: srcUrl, outDir: primary, label: "uno", secondCopyDir: second });
    expect(r1.secondCopy.status === "verified", J(r1.secondCopy));
    const copied = path.join(second, path.basename(r1.file));
    // the same copy again is recognised, not rewritten
    const again = copyToSecondLocation({ file: r1.file, destDir: second });
    expect(again.status === "verified" && /ya existía/.test(again.message), "idempotent: " + J(again));
    // a different file under the same name is NEVER replaced
    const before = fs.readFileSync(copied);
    fs.writeFileSync(copied, "tampered");
    const clash = copyToSecondLocation({ file: r1.file, destDir: second });
    expect(clash.status === "failed" && /no se sobrescribe/.test(clash.message) && fs.readFileSync(copied, "utf8") === "tampered", "a different existing file is kept as it is: " + J(clash));
    // and a corrupt copy cannot be restored: the checksum of its summary does not match
    const target = "beauty_pos_e2e_corrupt" + rnd();
    let refused = null;
    try { await restoreToNewDatabase({ url: srcUrl, file: copied, target }); } catch (e) { refused = e.code; }
    expect(refused === "CHECKSUM", "restoring a corrupt second copy is refused: " + refused);
    expect(!(await dbExists(target)), "and no database was left behind");
    fs.writeFileSync(copied, before);
    // retention only ever touches the PRIMARY location: nothing in the second one is deleted
    for (let i = 0; i < 3; i++) await backupDatabase({ url: srcUrl, outDir: primary, label: "r" + i, keep: 1, secondCopyDir: second, now: new Date(Date.now() + (i + 1) * 2000) });
    expect(fs.readdirSync(primary).filter((f) => f.endsWith(".dump")).length === 1, "the primary location kept only the newest");
    const kept = fs.readdirSync(second).filter((f) => f.endsWith(".dump"));
    expect(kept.length === 5 && kept.includes("historico-viejo.dump"), "the second location kept every historical backup (and the foreign file): " + kept.length);
  });
  await test("OPS-12.an_unavailable_second_location_is_reported_and_never_hides_the_valid_primary_backup", "integration", async () => {
    const primary = mkTmp("e2e ops primary3 ");
    const missingDrive = path.join(mkTmp("e2e ops gone "), "unplugged", "backups"); // the parent does not exist: a disconnected drive
    const r = cli("db-backup.mjs", ["--out", primary, "--second-copy", missingDrive], { DATABASE_URL: srcUrl });
    expect(r.code === 3 && /RESPALDO PRINCIPAL CORRECTO/.test(r.out) && /unavailable/.test(r.out), "exit code 3 with a clear message: " + r.code + " " + scrub(r.out).slice(-300));
    const dump = fs.readdirSync(primary).find((f) => f.endsWith(".dump"));
    expect(dump && sha256File(path.join(primary, dump)) === JSON.parse(fs.readFileSync(path.join(primary, dump.replace(/\.dump$/, ".summary.json")), "utf8")).sha256, "the primary backup is complete and verified");
    expect(!fs.existsSync(path.dirname(missingDrive)), "nothing was created at the unavailable location");
    expect(/second=unavailable/.test(fs.readFileSync(path.join(primary, "backup.log"), "utf8")), "the result is in the log");
    // unreadable choices are refused with a stable code, not attempted
    const rel = cli("db-backup.mjs", ["--out", primary, "--second-copy", path.join(ROOT, "backups-here")], { DATABASE_URL: srcUrl });
    expect(rel.code === 1 && /fuera del proyecto/.test(rel.out) && !fs.existsSync(path.join(ROOT, "backups-here")), "a second copy inside the repository is refused");
  });
  await test("OPS-13.the_second_location_cannot_be_a_url_the_same_place_or_a_cloud_synchronized_folder", "security", async () => {
    const primary = mkTmp("e2e ops primary4 ");
    const code = (fn) => { try { fn(); return "OK"; } catch (e) { return e.code; } };
    expect(code(() => validateSecondLocation("https://example.com/backups", primary)) === "SEGUNDA_COPIA_URL", "https");
    expect(code(() => validateSecondLocation("s3://bucket/backups", primary)) === "SEGUNDA_COPIA_URL", "s3");
    expect(code(() => validateSecondLocation("ftp://host/x", primary)) === "SEGUNDA_COPIA_URL", "ftp");
    expect(code(() => validateSecondLocation(primary, primary)) === "SEGUNDA_COPIA_IGUAL", "the same folder");
    expect(code(() => validateSecondLocation(path.join(primary, "sub"), primary)) === "SEGUNDA_COPIA_IGUAL", "a folder inside the primary one");
    expect(code(() => validateSecondLocation("", primary)) === "SEGUNDA_COPIA_INVALIDA" && code(() => validateSecondLocation(null, primary)) === "SEGUNDA_COPIA_INVALIDA", "empty");
    for (const name of ["OneDrive", "OneDrive - Empresa", "Dropbox", "Google Drive", "iCloudDrive", "MEGA", "Nextcloud"]) {
      expect(code(() => validateSecondLocation(path.join(os.tmpdir(), name, "backups"), primary, {})) === "SEGUNDA_COPIA_NUBE", name + " is refused");
    }
    expect(code(() => validateSecondLocation(path.join(os.tmpdir(), "OneDrive", "backups"), primary, { POS_ALLOW_SYNCED_FOLDER: "1" })) === "OK", "the operator can accept it explicitly");
    expect(code(() => validateSecondLocation(path.join(os.tmpdir(), "Respaldos externos", "pos"), primary, {})) === "OK", "a normal folder is fine");
    // through backupDatabase the primary backup still succeeds and the refusal is reported
    const r = await backupDatabase({ url: srcUrl, outDir: primary, label: "nube", secondCopyDir: "https://example.com/x" });
    expect(r.secondCopy.status === "failed" && /no sube respaldos a internet/.test(r.secondCopy.message) && fs.existsSync(r.file), "refused second copy reported, primary kept: " + J(r.secondCopy));
  });
} catch (e) {
  rec("ops.unexpected_error", "FAIL", scrub(String(e.stack || e)).split("\n").slice(0, 3).join(" | "), { kind: "integration" });
} finally {
  try { await src?.end(); } catch { /* ignore */ }
  for (const n of [...restored]) { try { await dropTestDb(n); } catch (e) { console.log("could not drop " + n + ": " + e.message); } }
  if (srcName) { try { await dropRunDb(srcName); } catch (e) { console.log("could not drop " + srcName + ": " + e.message); } }
  for (const r of roles) { try { await dropRuntimeRole(urlFor("x"), r); } catch (e) { console.log("could not drop role " + r + ": " + e.message); } }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}
const { summary, exitCode } = summarize(results, null, { suite: "ops" });
console.log("SUMMARY", JSON.stringify(summary));
process.exit(exitCode);
