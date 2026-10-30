// Usage: node e2e/legacy.mjs
// Legacy migration check (Sprint 06, block B1): takes the most recent VALIDATED backup of the owner's beauty_pos, restores it into
// a NEW disposable database, applies the pending migrations with the project's own explicit command, proves that the old data
// survived (row by row), checks integrity and cash reconciliation, and runs the PACKAGED application against that copy.
//
// Never connects to beauty_pos or any pre-existing database. The backup files are only read (their SHA-256 and timestamps are
// compared before and after). Everything it creates (the copy, its test users, a pre-migration backup in a temp folder) is removed.
// The row counts it asserts are the ones the backup itself recorded; nothing is invented. SKIP (never PASS) when there is no backup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { _electron } from "playwright-core";
import { ROOT, urlFor, createRecorder, summarize, expect, scrub, ui, sha256, hashModern, waitFor } from "./lib/harness.mjs";
import { listDump, findPgBin, restoreToNewDatabase, schemaStatus, sha256File, withClient, urlWithDatabase } from "../scripts/lib/db-ops.mjs";
import { verifyPin, needsUpgrade, isLegacyHash, isScryptHash } from "../src/backend/pin-hash.ts";

const BACKUP_DIR = path.resolve(process.env.E2E_BACKUP_DIR || path.join(os.homedir(), "Backups", "beauty-pos"));
const EXE = path.join(ROOT, "release", "win-unpacked", "Beauty POS.exe");
const J = JSON.stringify;
const JOURNAL = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")).entries;
const artifacts = path.join(ROOT, "e2e-artifacts");
let curPage = null; // the packaged window, for a screenshot when its test fails
const { results, rec, test, skip } = createRecorder("legacy", artifacts, () => curPage);
const tmpDirs = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const rnd = () => crypto.randomBytes(3).toString("hex");
const target = "beauty_pos_e2e_legacy" + rnd();
let copyCreated = false;
const apps = [];

// ---------------------------------------------------------------- the newest validated backup
function newestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const dumps = fs.readdirSync(BACKUP_DIR).filter((f) => /^beauty_pos_.*\.dump$/.test(f) && !f.endsWith(".partial"));
  const stamped = dumps
    .map((f) => ({ f, ts: (f.match(/(\d{8}T\d{6})/) || [])[1] || "" }))
    .filter((x) => x.ts)
    .sort((a, b) => b.ts.localeCompare(a.ts));
  if (!stamped.length) return null;
  const file = path.join(BACKUP_DIR, stamped[0].f);
  const jsonSum = file.replace(/\.dump$/, ".summary.json");
  const txtSum = file.replace(/\.dump$/, ".summary.txt");
  let expected = null;
  if (fs.existsSync(jsonSum)) {
    const s = JSON.parse(fs.readFileSync(jsonSum, "utf8"));
    expected = { sha256: s.sha256, counts: s.counts, migrations: s.migrationsApplied, source: path.basename(jsonSum) };
  } else if (fs.existsSync(txtSum)) {
    const t = fs.readFileSync(txtSum, "utf8");
    const counts = (t.match(/^row counts: (\{.*\})$/m) || [])[1];
    expected = {
      sha256: (t.match(/^sha256: ([0-9a-f]{64})$/m) || [])[1],
      counts: counts ? JSON.parse(counts) : null,
      migrations: Number((t.match(/^migrations applied: (\d+)$/m) || [])[1]),
      source: path.basename(txtSum),
    };
  }
  return { file, expected };
}
const snapshotBackups = () =>
  Object.fromEntries(fs.readdirSync(BACKUP_DIR).map((f) => { const p = path.join(BACKUP_DIR, f); const st = fs.statSync(p); return [f, { size: st.size, mtime: st.mtimeMs, sha: st.isFile() && st.size < 50e6 ? sha256File(p) : null }]; }));

const cli = (script, args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const copyClient = async () => { const c = new pg.Client({ connectionString: urlFor(target, "e2e_legacy_verify") }); await c.connect(); return c; };
// per-table fingerprint without the columns that migrations 0007/0008 ADD (everything else must be byte-identical)
const ADDED = ["operation_id", "product_name", "product_sku", "sale_id"];
async function tableHashes(c) {
  const tables = (await c.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name in ('users','products','sales','sale_items','inventory_movements','cash_movements','cash_sessions','returns','return_items','price_changes','deleted_products_log') order by 1")).rows.map((r) => r.table_name);
  const out = {};
  for (const t of tables) {
    const expr = ADDED.map((k) => `- '${k}'`).join(" ");
    out[t] = (await c.query(`select count(*)::int n, md5(coalesce(string_agg((to_jsonb(x) ${expr})::text, '|' order by x.id), '')) m from "${t}" x`)).rows[0];
  }
  return out;
}

const found = newestBackup();
let before = null;
let hashesBefore;
let hashesAfterMigration;
let testAdmin;
let testVendor;
try {
  if (!found || !found.expected || !found.expected.sha256 || !found.expected.counts) {
    skip("LEG-00.no_validated_backup_found", "migration", `no backup with a summary in ${BACKUP_DIR}: nothing was checked (this is NOT a pass)`);
  } else {
    before = snapshotBackups();
    const src = urlFor("postgres");
    const bin = findPgBin();
    const BASE = path.basename(found.file);

    await test("LEG-01.the_newest_backup_is_intact_and_is_the_one_that_gets_restored", "migration", async () => {
      const sha = sha256File(found.file);
      expect(sha === found.expected.sha256, "the SHA-256 of the file equals the one recorded in " + found.expected.source);
      const toc = listDump(found.file, bin);
      expect(toc.tableData >= 11, "pg_restore -l lists the tables with data: " + toc.tableData);
      return `${BASE} (${found.expected.source}), ${fs.statSync(found.file).size} bytes, sha256 ${sha.slice(0, 16)}…`;
    });

    await test("LEG-02.restores_into_a_new_database_with_the_recorded_counts_and_migrations", "migration", async () => {
      const r = await restoreToNewDatabase({ url: src, file: found.file, target, bin, verify: true });
      copyCreated = true;

      expect(r.migrations === found.expected.migrations, `migrations present in the copy: ${r.migrations} (backup recorded ${found.expected.migrations})`);
      const rec1 = J(found.expected.counts), got = J(Object.fromEntries(Object.keys(found.expected.counts).map((k) => [k, r.counts[k]])));
      expect(rec1 === got, `row counts equal what the backup recorded: ${got}`);
      const c = await copyClient();
      try {
        const mig = (await c.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n;
        expect(mig === found.expected.migrations && found.expected.migrations < JOURNAL.length, `the copy is behind the current journal (${mig} of ${JOURNAL.length}): 0007, 0008 and 0009 are pending`);
        const st = await schemaStatus(urlFor(target), path.join(ROOT, "drizzle"));
        expect(st.status === "missing" && st.missing.join() === JOURNAL.slice(found.expected.migrations).map((e) => e.tag).join(), "the pending ones are exactly: " + st.missing.join(", "));
        // the same database seen by an app whose migration files were checked out with CRLF (Windows autocrlf): still recognised
        const crlf = mkTmp("e2e legacy crlf ");
        fs.mkdirSync(path.join(crlf, "meta"));
        fs.copyFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), path.join(crlf, "meta/_journal.json"));
        for (const e of JOURNAL) fs.writeFileSync(path.join(crlf, e.tag + ".sql"), fs.readFileSync(path.join(ROOT, "drizzle", e.tag + ".sql"), "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
        const stCrlf = await schemaStatus(urlFor(target), crlf);
        expect(stCrlf.status === "missing" && stCrlf.missing.join() === st.missing.join() && stCrlf.unknown === 0, "line endings do not change what the database is recognised as: " + J(stCrlf));
      } finally { await c.end(); }
      return `restored as ${target}: sales=${r.counts.sales}, cash_sessions=${r.counts.cash_sessions}, cash_movements=${r.counts.cash_movements}, inventory_movements=${r.counts.inventory_movements}, users=${r.counts.users}` +
        (r.counts.sales === 9 && r.counts.cash_sessions === 3 ? " (9 sales and 3 sessions, as the owner's manual tests left them)" : " (NOT 9 sales / 3 sessions: these are the real counts of the backup)");
    });

    await test("LEG-03.the_read_only_precheck_accepts_the_legacy_data_and_a_dry_run_changes_nothing", "migration", async () => {
      const c = await copyClient();
      try { hashesBefore = await tableHashes(c); } finally { await c.end(); }
      const pre = cli("precheck-integrity.mjs", [`--database=${target}`]);
      expect(pre.code === 0, "precheck found no blockers:\n" + scrub(pre.out).slice(-400));
      const dry = cli("db-migrate.mjs", [], { DATABASE_URL: urlFor(target) });
      expect(dry.code === 0 && /SIMULACI/.test(dry.out) && /faltan: 0007/.test(dry.out), "the dry run reports 0007, 0008 and 0009 and stops: " + scrub(dry.out).slice(-300));
      const c2 = await copyClient();
      try {
        const mig = (await c2.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n;
        expect(mig === found.expected.migrations, "nothing changed after the dry run");
        expect(J(await tableHashes(c2)) === J(hashesBefore), "no row changed after the dry run");
      } finally { await c2.end(); }
    });

    await test("LEG-04.the_explicit_migration_takes_a_verified_backup_then_applies_0007_0008_0009", "migration", async () => {
      const backupDir = mkTmp("e2e legacy premigrate ");
      const noConfirm = cli("db-migrate.mjs", ["--apply", "--backup-dir", backupDir], { DATABASE_URL: urlFor(target) });
      expect(noConfirm.code === 1 && /--confirm-database/.test(noConfirm.out), "--apply without the exact database name is refused");
      const run1 = cli("db-migrate.mjs", ["--apply", `--confirm-database=${target}`, "--backup-dir", backupDir], { DATABASE_URL: urlFor(target) });
      expect(run1.code === 0 && /Migraciones aplicadas y verificadas/.test(run1.out), "applied and verified: " + scrub(run1.out).slice(-400));
      const dumps = fs.readdirSync(backupDir).filter((f) => f.endsWith(".dump"));
      expect(dumps.length === 1 && /pre-migrate/.test(dumps[0]), "a verified pre-migration backup was taken first: " + dumps.join());
      const st = await schemaStatus(urlFor(target), path.join(ROOT, "drizzle"));
      expect(st.status === "ok" && st.applied === JOURNAL.length, `schema is at the current version (${st.applied}/${JOURNAL.length})`);
      const again = cli("db-migrate.mjs", [], { DATABASE_URL: urlFor(target) });
      expect(/ya está al día/.test(again.out), "running it again is a no-op");
    });

    await test("LEG-05.historical_sales_sessions_movements_and_inventory_survive_row_by_row", "migration", async () => {
      const c = await copyClient();
      try {
        hashesAfterMigration = await tableHashes(c);
        for (const t of Object.keys(hashesBefore)) {
          expect(J(hashesAfterMigration[t]) === J(hashesBefore[t]), `${t}: ${hashesBefore[t].n} rows, identical content after the migration (compared without the columns 0007/0008 add)`);
        }
        const cols = (await c.query("select table_name||'.'||column_name c, is_nullable n from information_schema.columns where (table_name,column_name) in (('sales','operation_id'),('sale_items','product_name'),('sale_items','product_sku'),('cash_movements','sale_id'))")).rows;
        expect(cols.length === 4 && cols.every((x) => x.n === "YES"), "the added columns are nullable and were not back-filled except the documented cash link: " + J(cols));
        expect((await c.query("select count(*)::int n from sale_items where product_name is not null or product_sku is not null")).rows[0].n === 0, "old sale lines keep no invented names (the receipt falls back to the catalogue)");
        expect((await c.query("select count(*)::int n from sales where operation_id is not null")).rows[0].n === 0, "old sales have no operation id");
        const bs = (await c.query("select name, address, phone, logo_data from business_settings")).rows;
        expect(bs.length === 1 && bs[0].name === "Estética Leal" && bs[0].address === null && bs[0].phone === null && bs[0].logo_data === null, "the business settings row is the default one: name only");
        expect((await c.query("select count(*)::int n from refund_settlements")).rows[0].n === 0, "the refund ledger is empty: nothing invented as paid");
        const link = (await c.query(`select count(*)::int total, count(sale_id)::int linked,
            count(*) filter (where reason ~ '^Venta #[0-9]+ - (Efectivo|Tarjeta)')::int sale_like from cash_movements`)).rows[0];
        expect(link.linked <= link.sale_like, `0008 linked only sale-created movements: ${link.linked} linked of ${link.sale_like} that look like sales, ${link.total} movements in all`);
        const returns = (await c.query("select refund_status s, count(*)::int n from returns group by 1")).rows;
        expect(returns.every((r) => r.s !== "paid"), "no return became paid: " + J(returns));
        return `${link.linked} of ${link.total} cash movements linked to their sale; returns: ${J(returns)}`;
      } finally { await c.end(); }
    });

    await test("LEG-06.integrity_foreign_keys_checks_and_cash_reconciliation_of_the_historical_data", "migration", async () => {
      const c = await copyClient();
      try {
        expect((await c.query("select count(*)::int n from pg_constraint where connamespace='public'::regnamespace and not convalidated")).rows[0].n === 0, "every constraint is validated");
        const fks = (await c.query(`select c.conrelid::regclass::text child, c.confrelid::regclass::text parent,
            (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) ccol,
            (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) pcol
          from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1`)).rows;
        const orphans = [];
        for (const f of fks) {
          const n = (await c.query(`select count(*)::int n from ${f.child} ch left join ${f.parent} p on p."${f.pcol}" = ch."${f.ccol}" where ch."${f.ccol}" is not null and p."${f.pcol}" is null`)).rows[0].n;
          if (n) orphans.push(`${f.child}.${f.ccol}->${f.parent}: ${n}`);
        }
        expect(orphans.length === 0 && fks.length >= 16, `${fks.length} foreign keys, no orphan rows ${orphans.join(", ")}`);
        const badTotals = (await c.query("select count(*)::int n from sales s where s.total <> (select coalesce(sum(subtotal),0) from sale_items i where i.sale_id = s.id)")).rows[0].n;
        expect(badTotals === 0, "every sale total equals the sum of its lines");
        const badLines = (await c.query("select count(*)::int n from sale_items where subtotal <> unit_price * quantity")).rows[0].n;
        expect(badLines === 0, "every line subtotal is unit price x quantity");
        const neg = (await c.query("select count(*)::int n from products where stock < 0")).rows[0].n;
        expect(neg === 0, "no negative stock");
        // cash: what the register summary would show (initial + cash sales + manual in - manual out - cash refunds) vs the stored balance
        const sessions = (await c.query(`select s.id, s.status, s.initial_amount, s.current_amount, s.final_amount,
            (select coalesce(sum(total),0) from sales where cash_session_id = s.id and payment_method = 'cash') cash_sales,
            (select coalesce(sum(amount),0) from cash_movements m where m.session_id = s.id and m.sale_id is null and m.type = 'IN') man_in,
            (select coalesce(sum(amount),0) from cash_movements m where m.session_id = s.id and m.sale_id is null and m.type = 'OUT') man_out
          from cash_sessions s order by s.id`)).rows;
        const report = sessions.map((s) => {
          const expected = Math.round((Number(s.initial_amount) + Number(s.cash_sales) + Number(s.man_in) - Number(s.man_out)) * 100) / 100;
          return { id: s.id, status: s.status, expected, balance: Number(s.current_amount), ok: Math.abs(expected - Number(s.current_amount)) < 0.005 };
        });
        const bad = report.filter((r) => !r.ok);
        if (bad.length) rec("LEG-06b.cash_reconciliation_of_historical_sessions", "WARN", "records do not reconcile with the stored balance for " + J(bad) + " (owner's manual-test data; the app shows these as 'no concilian', it does not hide them)", { kind: "migration" });
        return `${sessions.length} sessions: ${report.filter((r) => r.ok).length} reconcile, ${bad.length} do not`;
      } finally { await c.end(); }
    });

    await test("LEG-07.stored_pins_keep_their_formats_and_both_formats_log_in_on_the_migrated_copy", "migration", async () => {
      const c = await copyClient();
      try {
        const users = (await c.query("select id, role, active, pin_hash from users order by id")).rows;
        const formats = users.map((u) => (isScryptHash(u.pin_hash) ? "scrypt" : isLegacyHash(u.pin_hash) ? "sha256-legacy" : "UNKNOWN"));
        expect(formats.every((f) => f !== "UNKNOWN"), "every stored PIN hash is in a supported format: " + formats.join());
        expect(users.map((u) => u.pin_hash).length === new Set(users.map((u) => u.pin_hash)).size, "no two users share a hash");
        expect(await verifyPin("000000", users.find((u) => isScryptHash(u.pin_hash))?.pin_hash ?? "x").then((v) => v === false), "an existing scrypt hash is parseable (a wrong PIN simply fails)");
        expect(users.filter((u) => isLegacyHash(u.pin_hash)).every((u) => needsUpgrade(u.pin_hash)), "legacy hashes are marked for the in-place upgrade at the next login");
        // the owner's PINs are unknown here: add TEST users to the COPY (never to beauty_pos) to prove both formats log in
        const mk = (n) => crypto.randomInt(0, 10 ** n).toString().padStart(n, "0");
        testAdmin = { pin: mk(7) };
        testVendor = { pin: mk(4) };
        const ia = (await c.query("insert into users(name,pin_hash,role) values('E2E legacy-check admin',$1,'admin') returning id", [hashModern(testAdmin.pin)])).rows[0].id;
        const iv = (await c.query("insert into users(name,pin_hash,role) values('E2E legacy-check vendor',$1,'vendor') returning id", [sha256(testVendor.pin)])).rows[0].id;
        testAdmin.id = ia; testVendor.id = iv;
        return `existing users: ${formats.join(", ")}; plus one scrypt test admin and one legacy-hash test vendor added to the copy`;
      } finally { await c.end(); }
    });

    if (!fs.existsSync(EXE)) {
      skip("LEG-08.packaged_application_on_the_migrated_copy", "e2e", "the packaged app is not built (npm run package:dir): the packaged part was NOT run");
    } else {
      await test("LEG-08.the_packaged_application_runs_on_the_migrated_copy_and_shows_the_historical_data", "e2e", async () => {
        const ud = mkTmp("pos-legacy-ud-");
        const env = { ...process.env, DATABASE_URL: urlFor(target, "e2e_legacy_app") };
        delete env.ELECTRON_RUN_AS_NODE;
        const app = await _electron.launch({ executablePath: EXE, args: ["--user-data-dir=" + ud], cwd: ROOT, env, timeout: 60000 });
        apps.push(app);
        const log = [];
        for (const s of [app.process().stdout, app.process().stderr]) s && s.on("data", (b) => log.push(...String(b).split(/\r?\n/).filter(Boolean)));
        const page = await app.firstWindow();
        curPage = page;
        await page.waitForLoadState("domcontentloaded");
        const c = await copyClient();
        try {
          await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 20000 });
          await ui.login(page, testAdmin.pin);
          await page.waitForURL(/#\/dashboard$/, { timeout: 15000 });
          const sales = (await c.query("select count(*)::int n from sales")).rows[0].n;
          await ui.nav(page, "Historial");
          const table = page.getByRole("table", { name: "Ventas" });
          await table.waitFor();
          await waitFor(async () => (await table.locator("tbody tr").count()) >= Math.min(sales, 20), 10000);
          const shown = await table.locator("tbody tr").count();
          expect(shown === Math.min(sales, 20), `Historial lists the ${sales} historical sales (${shown} rows)`);
          const first = (await c.query("select id from sales order by created_at desc, id desc limit 1")).rows[0].id;
          await page.getByRole("button", { name: `Ver venta ${first}`, exact: true }).click();
          await page.getByRole("dialog").getByText(`Venta #${first}`).first().waitFor();
          await page.getByRole("dialog").getByRole("button", { name: "Ver recibo" }).click();
          await page.frameLocator('iframe[title="Vista previa del recibo"]').getByText("ESTÉTICA LEAL").waitFor({ timeout: 10000 });
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          // register history: the historical sessions
          const sessions = (await c.query("select count(*)::int n from cash_sessions")).rows[0].n;
          await page.evaluate(() => { location.hash = "#/cash/history"; });
          const sessionTable = page.getByRole("table", { name: "Sesiones de caja" });
          await sessionTable.waitFor({ timeout: 10000 });
          await waitFor(async () => (await sessionTable.locator("tbody tr").count()) >= Math.min(sessions, 20), 10000);
          expect((await sessionTable.locator("tbody tr").count()) === Math.min(sessions, 20), `Caja > Historial lists the ${sessions} historical sessions`);
          // reports over the whole history agree with SQL
          await ui.nav(page, "Reportes");
          const span = (await c.query("select min(created_at) a, max(created_at) b from sales")).rows[0];
          const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const from = new Date(span.a), to = new Date(span.b);
          await page.getByLabel("Desde").fill(day(from));
          await page.getByLabel("Hasta").fill(day(to));
          await page.getByRole("button", { name: "Generar reporte" }).click();
          await page.getByTestId("rp-count").waitFor();
          const lo = new Date(from.getFullYear(), from.getMonth(), from.getDate()), hi = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
          const agg = (await c.query("select count(*)::int n, coalesce(sum(total),0)::numeric t from sales where created_at >= $1 and created_at < $2", [lo, hi])).rows[0];
          expect((await page.getByTestId("rp-count").innerText()).trim() === String(agg.n), `Reportes over the historical range counts ${agg.n} sales`);
          expect((await page.locator("body").innerText()).includes("$" + Number(agg.t).toFixed(2)), "and shows the same total as SQL: $" + Number(agg.t).toFixed(2));
          await page.getByRole("link", { name: "Dashboard" }).click();
          await page.waitForURL(/#\/dashboard$/);
          // the legacy-hash vendor also signs in (and is upgraded in place), both formats work on the migrated data
          await ui.logout(page);
          await page.getByText("Ingresa tu PIN para comenzar").waitFor();
          await ui.login(page, testVendor.pin);
          await page.waitForURL(/#\/sales$/, { timeout: 15000 });
          expect(/^scrypt\$/.test((await c.query("select pin_hash from users where id=$1", [testVendor.id])).rows[0].pin_hash), "the legacy hash was upgraded to scrypt after the login");
          expect(!log.some((l) => l.includes(new URL(urlFor("x")).password) && new URL(urlFor("x")).password.length >= 8), "no password in the application log");
        } finally { await c.end(); }
        await app.close().catch(() => {});
        const c2 = await copyClient();
        try {
          const after = await tableHashes(c2);
          for (const t of Object.keys(hashesAfterMigration)) {
            if (t === "users") continue;
            expect(J(after[t]) === J(hashesAfterMigration[t]), `${t}: the application did not change historical rows by being opened and browsed`);
          }
        } finally { await c2.end(); }
        return `application ${path.basename(EXE)} opened the migrated copy; history, receipt, sessions, reports and both PIN formats worked`;
      });
    }

    await test("LEG-09.the_backup_files_were_only_read_and_the_protected_databases_were_never_opened", "migration", async () => {
      const after = snapshotBackups();
      expect(J(after) === J(before), `every file in ${BACKUP_DIR} is byte-identical (size, mtime and SHA-256) to before this test`);
      expect(Object.keys(after).some((f) => f.startsWith("beauty_pos_phase0_")), "the Phase 0 backup is still there");
    });
  }
} catch (e) {
  rec("legacy.unexpected_error", "FAIL", scrub(String(e.stack || e)).split("\n").slice(0, 3).join(" | "), { kind: "migration" });
} finally {
  for (const a of apps) await a.close().catch(() => {});
  if (copyCreated && /^beauty_pos_e2e_legacy[0-9a-f]{6}$/.test(target)) {
    try { await withClient(urlWithDatabase(urlFor("x"), "postgres"), (a) => a.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`), "e2e_legacy_cleanup"); } catch (e) { console.log("could not drop " + target + ": " + e.message); }
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}
const { summary, exitCode } = summarize(results, null, { suite: "legacy" });
console.log("SUMMARY", JSON.stringify(summary));
process.exit(exitCode);
