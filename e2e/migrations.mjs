// Usage: node e2e/migrations.mjs
// Migration safety checks, ALWAYS on throwaway databases created by this run (never on an existing one):
//   1. empty database -> all migrations apply; constraints really reject bad data
//   2. upgrade path: copy of the Phase 0 backup (4 migrations + real legacy data) -> migration 0004
//   3. incompatible data -> precheck reports BLOCKERs and the migration rolls back atomically
//   4. startup: a failing migration must stop the app before any IPC handler exists
// The legacy dump is optional: set E2E_LEGACY_DUMP (default: the Phase 0 backup path). Missing -> SKIP.
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { _electron } from "playwright-core";
import {
  ROOT, urlFor, createRunDb, dropRunDb, connectRunDb, buildMain, createRecorder, summarize, expect, scrub, waitFor,
} from "./lib/harness.mjs";

const PG_BIN = process.env.PG_BIN || "C:/Program Files/PostgreSQL/18/bin";
const DUMP = process.env.E2E_LEGACY_DUMP || "C:/Users/asahe/Backups/beauty-pos/beauty_pos_phase0_20261029T064645_commit0b7b1da.dump";
const MIGRATIONS = path.join(ROOT, "drizzle");
const JOURNAL = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")).entries.length;
const { results, rec, test, skip } = createRecorder("migrations", path.join(ROOT, "e2e-artifacts"), () => null);

const dbs = [];
async function newDb() { const n = await createRunDb(); dbs.push(n); return n; }
async function applyMigrations(name, folder = MIGRATIONS) {
  const pool = new pg.Pool({ connectionString: urlFor(name, "e2e_migrator"), max: 1 });
  try { await migrate(drizzle(pool), { migrationsFolder: folder }); } finally { await pool.end(); }
}
// A migrations folder holding only the 4 historical migrations: reproduces the pre-0004 schema without any dump.
function makeFolder(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-pre4-"));
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, count);
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) fs.copyFileSync(path.join(MIGRATIONS, e.tag + ".sql"), path.join(dir, e.tag + ".sql"));
  return dir;
}
function restoreDump(name) {
  const u = new URL(urlFor(name));
  const r = spawnSync(path.join(PG_BIN, "pg_restore.exe"), ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username), "-d", name, "--no-password", "--exit-on-error", DUMP],
    { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, encoding: "utf8" });
  if (r.status !== 0) throw new Error("pg_restore failed: " + scrub(r.stderr || "").slice(0, 300));
}
function precheck(name) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/precheck-integrity.mjs"), `--database=${name}`], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: scrub(r.stdout + r.stderr) };
}
const tables = ["users", "products", "sales", "sale_items", "inventory_movements", "cash_movements", "cash_sessions", "returns", "return_items", "price_changes", "deleted_products_log"];
async function fingerprint(db, skipCols = {}) {
  const out = {};
  for (const t of tables) {
    const cols = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position", [t])).rows.map((r) => r.column_name).filter((c) => c !== skipCols[t]);
    out[t] = (await db.query(`select count(*)::int n, md5(coalesce(string_agg(row(${cols.map((c) => `"${c}"`).join(",")})::text, '|' order by id),'')) m from "${t}"`)).rows[0];
  }
  return JSON.stringify(out);
}
const one = async (db, sql, p) => (await db.query(sql, p)).rows[0];
const expectSqlError = async (db, sql, code, label) => {
  try { await db.query(sql); } catch (e) { expect(e.code === code, `${label}: expected SQLSTATE ${code}, got ${e.code}`); return; }
  throw new Error(`${label}: statement was accepted but must be rejected (${code})`);
};

try {
  buildMain();

  // ------------------------------------------------------------ 1. empty database
  const empty = await newDb();
  const edb = await connectRunDb(empty);
  await test("MIG-01.empty_database_applies_all_migrations", "migration", async () => {
    await applyMigrations(empty);
    expect((await one(edb, "select count(*)::int n from drizzle.__drizzle_migrations")).n === JOURNAL, `journal has ${JOURNAL} migrations`);
    const names = (await edb.query("select conname from pg_constraint where connamespace='public'::regnamespace")).rows.map((r) => r.conname);
    for (const n of ["products_stock_non_negative", "sale_items_quantity_positive", "cash_sessions_state_coherent", "cash_sessions_current_non_negative", "sales_cash_session_id_cash_sessions_id_fk", "sale_items_product_id_products_id_fk", "cash_movements_session_id_cash_sessions_id_fk"]) expect(names.includes(n), "missing constraint " + n);
    expect((await one(edb, "select count(*)::int n from pg_indexes where indexname='cash_sessions_single_open'")).n === 1, "single-open index");
    expect((await one(edb, "select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='product_status' and e.enumlabel='deleted'")).n === 1, "enum value 'deleted'");
    expect((await one(edb, "select count(*)::int n from pg_constraint where connamespace='public'::regnamespace and not convalidated")).n === 0, "all constraints validated");
    const cnt = async (t) => (await one(edb, "select count(*)::int n from pg_constraint where connamespace='public'::regnamespace and contype=$1", [t])).n;
    expect((await cnt("f")) === 10, "exactly 10 foreign keys, got " + (await cnt("f")));
    expect((await cnt("c")) === 14, "exactly 14 CHECK constraints, got " + (await cnt("c")));
    expect((await one(edb, "select string_agg(e.enumlabel, ',' order by e.enumsortorder) v from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='refund_status'")).v === "pending,paid,legacy_unspecified", "refund_status enum");
    expect((await one(edb, "select column_default d from information_schema.columns where table_name='returns' and column_name='refund_status'")).d.startsWith("'pending'"), "new returns default to pending");
    expect((await one(edb, "select count(*)::int n from pg_indexes where schemaname='public' and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%WHERE%'")).n === 1, "exactly one partial unique index");
    return "10 foreign keys, 14 CHECK, 1 partial unique index, enum values 'deleted' and refund_status";
  });
  await test("MIG-02.constraints_reject_bad_data_at_the_database_level", "migration", async () => {
    await edb.query("insert into users(name,pin_hash,role) values('m','x','admin')");
    await edb.query("insert into products(sku,name,price,stock) values('MIG-1','m','1.00',1)");
    await expectSqlError(edb, "update products set stock = -1 where sku='MIG-1'", "23514", "negative stock");
    await expectSqlError(edb, "insert into products(sku,name,price,stock) values('MIG-2','m','-1.00',1)", "23514", "negative price");
    await edb.query("insert into cash_sessions(opened_by,initial_amount,current_amount) values(1,'10','10')");
    await expectSqlError(edb, "insert into cash_sessions(opened_by,initial_amount,current_amount) values(1,'1','1')", "23505", "second open session");
    await edb.query("update products set status='deleted', stock=0 where sku='MIG-1'");
    await expectSqlError(edb, "update products set stock=1 where sku='MIG-1'", "23514", "a deleted product cannot hold stock");
    await edb.query("update products set status='active', stock=1 where sku='MIG-1'");
    await expectSqlError(edb, "update cash_sessions set current_amount='-1'", "23514", "negative cash balance");
    await expectSqlError(edb, "update cash_sessions set status='closed'", "23514", "closed without closed_at/closed_by/final_amount");
    await expectSqlError(edb, "update cash_sessions set closed_at=now()", "23514", "closed_at while status open");
    await expectSqlError(edb, "insert into cash_movements(session_id,user_id,type,amount,reason) values(999,1,'IN','1','x')", "23503", "movement of unknown session");
    await expectSqlError(edb, "insert into cash_movements(session_id,user_id,type,amount,reason) values(1,1,'IN','-1','x')", "23514", "negative movement");
    await edb.query("insert into sales(user_id,cash_session_id,total,payment_method) values(1,1,'1','cash')");
    await expectSqlError(edb, "insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal) values(1,1,0,'1','0')", "23514", "quantity 0");
    await expectSqlError(edb, "insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal) values(1,999,1,'1','1')", "23503", "unknown product");
    await expectSqlError(edb, "insert into sales(user_id,cash_session_id,total,payment_method) values(1,999,'1','cash')", "23503", "unknown cash session");
    await edb.query("insert into inventory_movements(product_id,user_id,type,amount,reason) values(1,1,'IN',1,'x')");
    await expectSqlError(edb, "delete from products where sku='MIG-1'", "23503", "product with inventory history cannot be physically deleted");
    // returns (migration 0005)
    await edb.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal) values(1,1,2,'1','2')");
    await edb.query("insert into returns(sale_id,reason,processed_by,total_refund) values(1,'x',1,'1')");
    await expectSqlError(edb, "insert into returns(sale_id,reason,processed_by) values(999,'x',1)", "23503", "return of an unknown sale");
    await expectSqlError(edb, "update returns set total_refund='-1'", "23514", "negative refund");
    await expectSqlError(edb, "insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values((select min(id) from returns),(select min(id) from sale_items),1,0,'0')", "23514", "return quantity 0");
    await expectSqlError(edb, "insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values((select min(id) from returns),999,1,1,'1')", "23503", "return of an unknown sale line");
    await expectSqlError(edb, "insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values(999,(select min(id) from sale_items),1,1,'1')", "23503", "return line of an unknown return");
    await edb.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values((select min(id) from returns),(select min(id) from sale_items),1,1,'1')");
    await expectSqlError(edb, "insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values((select min(id) from returns),(select min(id) from sale_items),1,1,'1')", "23505", "same sale line twice in one return");
    expect((await edb.query("select refund_status from returns")).rows[0].refund_status === "pending", "a return inserted without a state is 'pending'");
    // valid closing is accepted
    await edb.query("update cash_sessions set status='closed', closed_at=now(), closed_by=1, final_amount='10'");
    await edb.query("insert into cash_sessions(opened_by,initial_amount,current_amount) values(1,'1','1')"); // a new one may open after closing
  });
  await edb.end();

  // ------------------------------------------------------------ 2/3. legacy upgrade path
  if (!fs.existsSync(DUMP)) {
    for (const id of ["MIG-03.legacy_copy_upgrades_without_losing_data", "MIG-04.incompatible_data_is_reported_and_the_migration_rolls_back"]) skip(id, "migration", `legacy dump not found (${path.basename(DUMP)}); set E2E_LEGACY_DUMP`);
  } else {
    const legacy = await newDb();
    restoreDump(legacy);
    const ldb = await connectRunDb(legacy);
    await test("MIG-03.legacy_copy_upgrade_changes_only_the_reconciled_column", "migration", async () => {
      // Full-row hash per table (every column, including cash_sessions.status).
      const full = async () => {
        const o = {};
        for (const t of tables) o[t] = (await ldb.query(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x.id),'')) m from "${t}" x`)).rows[0];
        return o;
      };
      const sessions = async () => (await ldb.query("select id, status, (closed_at is not null) as closed, to_jsonb(c) - 'status' as rest from cash_sessions c order by id")).rows;
      const migrations = async () => (await ldb.query("select id, hash, created_at from drizzle.__drizzle_migrations order by id")).rows;

      const preFull = await full(), preSess = await sessions(), preMig = await migrations();
      expect(preMig.length === 4, "copy starts with the 4 historical migrations");
      const stale = preSess.filter((r) => r.closed && r.status === "open").map((r) => r.id);
      expect(stale.length >= 1, "precondition: legacy sessions closed but status still 'open'");

      const pre = precheck(legacy);
      expect(pre.code === 0, "precheck must report no blockers:\n" + pre.out);
      expect(JSON.stringify(await full()) === JSON.stringify(preFull), "precheck is read-only: nothing changed after running it");

      await applyMigrations(legacy);
      const postFull = await full(), postSess = await sessions(), postMig = await migrations();

      // 1) migrations: the 4 old rows untouched, exactly one new row matching the file
      expect(postMig.length === JOURNAL && JSON.stringify(postMig.slice(0, 4)) === JSON.stringify(preMig), "the 4 historical migration rows are unchanged");
      const entries = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")).entries;
      for (let i = 4; i < entries.length; i++) {
        const file = fs.readFileSync(path.join(MIGRATIONS, entries[i].tag + ".sql"), "utf8");
        expect(postMig[i].hash === crypto.createHash("sha256").update(file).digest("hex") && Number(postMig[i].created_at) === entries[i].when, entries[i].tag + " recorded once, with the hash of the file");
      }

      // 2) every other business table: identical count AND identical full-row hash
      const untouched = tables.filter((t) => t !== "cash_sessions");
      for (const t of untouched) expect(JSON.stringify(postFull[t]) === JSON.stringify(preFull[t]), `table ${t} must be byte-identical, but changed`);

      // 3) cash_sessions: hash differs on purpose; only the status column changed, only on the stale rows
      expect(postFull.cash_sessions.n === preFull.cash_sessions.n, "same number of sessions");
      expect(postFull.cash_sessions.m !== preFull.cash_sessions.m, "cash_sessions hash differs (deliberate reconciliation)");
      expect(JSON.stringify(postSess.map((r) => [r.id, r.rest])) === JSON.stringify(preSess.map((r) => [r.id, r.rest])), "every column except status is identical, row by row");
      const changed = postSess.filter((r, i) => r.status !== preSess[i].status).map((r) => r.id);
      expect(JSON.stringify(changed) === JSON.stringify(stale), "status changed exactly on the stale rows: " + JSON.stringify({ changed, stale }));
      expect(postSess.every((r) => (r.status === "closed") === r.closed), "status now agrees with closed_at everywhere");
      expect((await one(ldb, "select count(*)::int n from pg_constraint where connamespace='public'::regnamespace and not convalidated")).n === 0, "all constraints validated against the real data");

      // 4) idempotent
      await applyMigrations(legacy);
      expect(JSON.stringify(await migrations()) === JSON.stringify(postMig) && JSON.stringify(await full()) === JSON.stringify(postFull), "second run changes nothing");
      return `status open->closed on session ids [${stale}] only; ${untouched.length} other tables byte-identical; 4 old migration rows unchanged + ${JOURNAL - 4} new; re-run is a no-op`;
    });
    await ldb.end();

    const bad = await newDb();
    restoreDump(bad);
    const bdb = await connectRunDb(bad);
    await test("MIG-04.incompatible_data_is_reported_and_the_migration_rolls_back", "migration", async () => {
      await bdb.query("update products set stock = -3 where id = (select min(id) from products)"); // data the new CHECK would reject
      const pre = precheck(bad);
      expect(pre.code === 1 && /BLOCKER\s+\d+\s+products with negative stock/.test(pre.out), "precheck must flag the blocker:\n" + pre.out);
      const snapshot = await fingerprint(bdb);
      let failed = false;
      try { await applyMigrations(bad); } catch { failed = true; }
      expect(failed, "the migration must fail on incompatible data");
      expect((await one(bdb, "select count(*)::int n from drizzle.__drizzle_migrations")).n === 4, "migration not recorded");
      expect((await one(bdb, "select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='product_status' and e.enumlabel='deleted'")).n === 0, "enum value rolled back");
      expect((await one(bdb, "select count(*)::int n from pg_indexes where indexname='cash_sessions_single_open'")).n === 0, "no partial index");
      expect((await one(bdb, "select (to_regtype('refund_status') is null) as gone")).gone, "0005's enum type rolled back too (both migrations share one transaction)");
      expect((await one(bdb, "select count(*)::int n from pg_constraint where conname like '%_non_negative' or conname like '%_fk' or conname like '%_positive' or conname='cash_sessions_state_coherent'")).n === 0, "no partial constraints");
      expect((await one(bdb, "select count(*)::int n from cash_sessions where closed_at is not null and status='open'")).n >= 1, "the reconciliation UPDATE was rolled back too");
      expect((await fingerprint(bdb)) === snapshot, "data untouched after the failed attempt");
    });
    await bdb.end();
  }

  // ------------------------------------------------------------ 3b. precheck vs the real constraint, state by state
  // For every combination: build a pre-0004 database, insert one session, run the precheck, then really apply 0004.
  // The precheck verdict must match the migration outcome, and the precheck must not write anything.
  const pre4 = makeFolder(4);
  const SCENARIOS = [
    ["open_coherent", "'open', null, null, null", true],
    ["closed_coherent", "'closed', now(), 1, '5'", true],
    ["legacy_closed_with_old_open_status_is_reconcilable", "'open', now(), 1, '5'", true],
    ["closed_without_date", "'closed', null, null, null", false],
    ["closed_without_date_but_with_closer_and_amount", "'closed', null, 1, '5'", false],
    ["open_with_closing_data", "'open', null, 1, '5'", false],
    ["open_with_only_closer", "'open', null, 1, null", false],
    ["closed_incomplete_no_closer_no_amount", "'closed', now(), null, null", false],
    ["closed_missing_only_amount", "'closed', now(), 1, null", false],
    ["legacy_old_open_status_but_incomplete", "'open', now(), null, null", false],
  ];
  let n = 0;
  for (const [label, values, compatible] of SCENARIOS) {
    await test(`MIG-06.${String(++n).padStart(2, "0")}_precheck_matches_constraint::${label}`, "migration", async () => {
      const name = await newDb();
      await applyMigrations(name, pre4);
      const db = await connectRunDb(name);
      try {
        await db.query(`insert into cash_sessions(opened_by, initial_amount, current_amount, status, closed_at, closed_by, final_amount) values (1, '10', '10', ${values})`);
        const before = await fingerprint(db);
        const pre = precheck(name);
        expect((await fingerprint(db)) === before, "the precheck wrote something");
        expect(pre.code === (compatible ? 0 : 1), `precheck exit ${pre.code}, expected ${compatible ? 0 : 1}:\n${pre.out}`);
        let applied = true;
        try { await applyMigrations(name); } catch { applied = false; }
        expect(applied === compatible, `the migration ${applied ? "applied" : "failed"} but the precheck said ${compatible ? "compatible" : "blocked"}`);
        if (compatible) {
          const row = await one(db, "select status, closed_at is not null as closed from cash_sessions");
          expect((row.status === "closed") === row.closed, "state coherent after migrating");
        } else {
          expect((await one(db, "select count(*)::int n from drizzle.__drizzle_migrations")).n === 4, "failed migration left no trace");
        }
        return compatible ? "compatible: precheck exit 0 and 0004 applied" : "blocked: precheck exit 1 and 0004 rolled back";
      } finally { await db.end(); }
    });
  }
  fs.rmSync(pre4, { recursive: true, force: true });

  // ------------------------------------------------------------ 3c. returns migration (0005) on legacy returns data
  const pre5 = makeFolder(5);
  const seedSale = async (db) => {
    await db.query("insert into products(sku,name,price,stock) values('R-1','r','10.00',5)");
    await db.query("insert into cash_sessions(opened_by,initial_amount,current_amount,status,closed_at,closed_by,final_amount) values(1,'1','1','closed',now(),1,'1')");
    await db.query("insert into sales(user_id,cash_session_id,total,payment_method) values(1,1,'20.00','cash')");
    await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal) values(1,1,2,'10.00','20.00')");
  };
  await test("MIG-07.legacy_returns_are_marked_legacy_unspecified_never_paid_or_pending", "migration", async () => {
    const name = await newDb();
    await applyMigrations(name, pre5);
    const db = await connectRunDb(name);
    try {
      await seedSale(db);
      await db.query("insert into returns(sale_id,total_refund,reason,processed_by) values(1,'10.00','legacy',1), (1,null,'legacy no total',1)");
      await db.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values(1,1,1,1,'10.00')");
      const before = (await db.query("select id, sale_id, total_refund, reason, processed_by, created_at from returns order by id")).rows;
      const pre = precheck(name);
      expect(pre.code === 0 && /existing returns/.test(pre.out), "precheck accepts clean legacy returns:\n" + pre.out);
      await applyMigrations(name);
      const after = (await db.query("select id, sale_id, total_refund, reason, processed_by, created_at, refund_status from returns order by id")).rows;
      expect(after.length === 2 && after.every((r) => r.refund_status === "legacy_unspecified"), "legacy rows: " + JSON.stringify(after.map((r) => r.refund_status)));
      expect(JSON.stringify(after.map(({ refund_status, ...rest }) => rest)) === JSON.stringify(before), "every other column of the legacy returns is unchanged");
      await db.query("insert into returns(sale_id,total_refund,reason,processed_by) values(1,'1.00','new',1)");
      expect((await one(db, "select refund_status from returns where reason='new'")).refund_status === "pending", "returns created after the migration start as pending");
      expect((await one(db, "select count(*)::int n from returns where refund_status='paid'")).n === 0, "nothing is ever 'paid' by the migration");
      return "legacy -> legacy_unspecified, new -> pending, no 'paid'";
    } finally { await db.end(); }
  });
  const RETURN_BLOCKERS = [
    ["orphan_return_line", "insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values(999,1,1,1,'1')", /return_items -> returns orphans/],
    ["return_of_unknown_sale", "insert into returns(sale_id,reason,processed_by) values(999,'x',1)", /returns -> sales orphans/],
    ["zero_quantity_line", "insert into returns(sale_id,reason,processed_by) values(1,'x',1); insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values(1,1,1,0,'0')", /return_items with quantity <= 0/],
    ["negative_refund", "insert into returns(sale_id,total_refund,reason,processed_by) values(1,'-5','x',1)", /negative amounts/],
    ["duplicate_lines_in_one_return", "insert into returns(sale_id,reason,processed_by) values(1,'x',1); insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values(1,1,1,1,'1'),(1,1,1,1,'1')", /duplicate \(return_id, sale_item_id\)/],
  ];
  for (const [label, sqlText, re] of RETURN_BLOCKERS) {
    await test("MIG-08.returns_blocker_is_reported_and_rolls_back::" + label, "migration", async () => {
      const name = await newDb();
      await applyMigrations(name, pre5);
      const db = await connectRunDb(name);
      try {
        await seedSale(db);
        await db.query(sqlText);
        const before = await fingerprint(db);
        const pre = precheck(name);
        expect(pre.code === 1 && re.test(pre.out), "precheck must flag it:\n" + pre.out);
        expect((await fingerprint(db)) === before, "precheck wrote something");
        let failed = false;
        try { await applyMigrations(name); } catch { failed = true; }
        expect(failed, "0005 must fail on this data");
        expect((await one(db, "select count(*)::int n from drizzle.__drizzle_migrations")).n === 5, "nothing recorded");
        expect((await one(db, "select (to_regtype('refund_status') is null) as gone")).gone, "enum rolled back");
        expect((await fingerprint(db)) === before, "data untouched");
      } finally { await db.end(); }
    });
  }
  fs.rmSync(pre5, { recursive: true, force: true });

  // ------------------------------------------------------------ 4. startup must abort when migrations fail
  await test("MIG-05.app_refuses_to_run_when_migrations_fail", "migration", async () => {
    const broken = await newDb();
    const bdb = await connectRunDb(broken);
    // a conflicting pre-existing table makes migration 0003 fail (column created_at does not exist)
    await bdb.query("create table cash_movements (id serial primary key)");
    const env = { ...process.env, DATABASE_URL: urlFor(broken, "e2e_app") };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: path.join(ROOT, "node_modules/electron/dist/electron.exe"), args: ["."], cwd: ROOT, env, timeout: 60000 });
    const log = [];
    for (const s of [app.process().stdout, app.process().stderr]) s && s.on("data", (b) => log.push(String(b)));
    try {
      const win = await app.firstWindow();
      await waitFor(async () => win.url().startsWith("data:text/html"), 15000);
      expect(win.url().startsWith("data:text/html"), "only the static error page is shown: " + win.url().slice(0, 40));
      expect((await win.evaluate(() => document.body.innerText)).includes("No se pudo preparar la base de datos"), "error message shown");
      expect((await win.evaluate(() => typeof window.api)) === "undefined", "the error page has no API");
      expect(log.join("").includes("STARTUP_ABORTED"), "main logged STARTUP_ABORTED");
      // even a window WITH the preload cannot reach any handler: none was registered
      await app.evaluate(({ BrowserWindow }, preload) => {
        const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
        w.loadURL("data:text/html,<p>probe</p>");
      }, path.join(ROOT, "dist/preload/preload.cjs"));
      const probe = await waitFor(async () => app.windows().find((w) => w.url().includes("probe")), 15000);
      expect(probe, "probe window");
      const r = await probe.evaluate(async () => { try { await window.api.auth.login("0000"); return "ALLOWED"; } catch (e) { return String(e.message); } });
      expect(/No handler registered/.test(r), "IPC handlers must not exist after a failed migration, got: " + r);
    } finally { await app.close().catch(() => {}); }
    const cols = (await bdb.query("select column_name from information_schema.columns where table_schema='public' and table_name='cash_movements'")).rows.map((r) => r.column_name);
    expect(cols.join() === "id", "the broken database was not modified: " + cols.join());
    expect((await one(bdb, "select count(*)::int n from information_schema.tables where table_schema='public' and table_name='users'")).n === 0, "no schema was half-created (migrations ran in one rolled-back transaction)");
    await bdb.end();
  });
} catch (e) {
  rec("migrations.unexpected_error", "FAIL", scrub(String(e.stack || e)).split("\n").slice(0, 3).join(" | "), { kind: "migration" });
} finally {
  for (const n of dbs) { try { await dropRunDb(n); } catch (e) { console.log("could not drop " + n + ": " + e.message); } }
}
const { summary, exitCode } = summarize(results, null, { suite: "migrations" });
console.log("SUMMARY", JSON.stringify(summary));
process.exit(exitCode);
