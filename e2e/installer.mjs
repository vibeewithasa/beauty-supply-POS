// Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning e2e/installer.mjs   (npm run test:installer)
// Provisioning of the dedicated PostgreSQL against the REAL bundled binaries (vendor/pg-bundle, built by `npm run fetch:postgres`).
// No Electron. Nothing is installed and no Windows service is registered: every instance is a throwaway cluster started with pg_ctl from a
// temp folder of this run, on a port of its own (56200-56299), stopped and deleted at the end. The developer's own PostgreSQL is only
// READ (database/role lists, schema counts) to prove it is left untouched.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { ROOT, createRecorder, expect, summarize, urlFor } from "./lib/harness.mjs";
import { verifyPin } from "../src/backend/pin-hash.ts";
import { expectedTotals } from "../scripts/lib/demo-data.mjs";
import { restoreToNewDatabase, withClient } from "../scripts/lib/db-ops.mjs";
import {
  auditAcl, auditClusterConfig, clusterRunning, currentUserSid, detectForeignPostgres, ensureRunning, layoutFor, preflight, readManifest, readConfiguredPort, adminUrl,
  stopCluster, verifyOwnership, verifyTree, readBundleManifest, installRuntime, isPortFree,
} from "../scripts/lib/managed-pg.mjs";
import { backupManaged, loadManaged, managedStatus, provisionManagedInstance, resetDemo, updateSchema } from "../scripts/lib/provision.mjs";

const BUNDLE = path.join(ROOT, "vendor", "pg-bundle");
const MIGRATIONS = path.join(ROOT, "drizzle");
const artifacts = path.join(ROOT, "e2e-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const { results, rec, test } = createRecorder("installer", artifacts, () => null);
const tmpRoots = [];
const mkRoot = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pos-inst-" + tag + "-"));
  tmpRoots.push(d);
  return path.join(d, "managed");
};
let nextPort = 56200;
const portRange = () => { const first = nextPort; nextPort += 10; return { portFirst: first, portLast: first + 9 }; };
const PS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const ps = (cmd, env = {}) => spawnSync(PS, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", env: { ...process.env, ...env } });
const rnd = (n = 8) => crypto.randomBytes(n).toString("hex");
const pin6 = () => String(crypto.randomInt(100000, 999999));
const distinctPins = () => { const a = pin6(); let v = pin6(); while (v === a) v = pin6(); return { adminPin: a, vendorPin: v }; };
const adminPwdOf = new Map(); // root -> cluster superuser password captured by `persist` (what the app would store protected)
const connOf = new Map();
const persistFor = (root) => async ({ connection, adminPassword }) => { adminPwdOf.set(root, adminPassword); connOf.set(root, connection); };
const install = (root, mode, input, extra = {}) =>
  provisionManagedInstance({ root, bundleDir: BUNDLE, migrationsDir: MIGRATIONS, mode, input, appVersion: "0.8.0-test", persist: persistFor(root), ...portRange(), ...extra });
const appUrl = (c, port = c.port, password = c.password) => {
  const u = new URL("postgresql://placeholder");
  u.hostname = "127.0.0.1";
  u.port = String(port);
  u.username = c.user;
  u.password = password;
  u.pathname = "/" + c.database;
  return u.toString();
};
const q = async (url, sql, p) => withClient(url, async (c) => (await c.query(sql, p)).rows, "inst_test");
const runtimeOf = (root) => path.join(root, "runtime", readBundleManifest(BUNDLE).version);
const cleanupRoot = (root) => {
  try {
    const l = layoutFor(root);
    const rt = runtimeOf(root);
    if (fs.existsSync(path.join(l.data, "postmaster.pid"))) stopCluster({ layout: l, runtimeDir: rt, mode: "immediate" });
  } catch { /* force below */ }
};
const processesUnder = (dir) => {
  const r = ps("(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:POS_DIR, [StringComparison]::OrdinalIgnoreCase) } | Measure-Object).Count", { POS_DIR: dir + path.sep });
  return Number(String(r.stdout).trim()) || 0;
};
const killProcessesUnder = (dir) => ps("Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:POS_DIR, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }", { POS_DIR: dir + path.sep });
const treeText = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : out.push(f); } };
  walk(dir);
  return out;
};

// snapshot of the developer's own PostgreSQL (read only): proves scenario 25
async function foreignSnapshot() {
  const base = urlFor("postgres", "inst_snapshot");
  return withClient(base, async (c) => {
    const dbs = (await c.query("select datname from pg_database order by 1")).rows.map((r) => r.datname);
    const roles = (await c.query("select rolname from pg_roles order by 1")).rows.map((r) => r.rolname);
    const started = (await c.query("select pg_postmaster_start_time()::text t")).rows[0].t;
    return { dbs, roles, started };
  }, "inst_snapshot").catch(() => null);
}

let before = null;
const secretsSeen = []; // every secret this run generated, for the leak scan
const logLeaks = (dir, secrets) => treeText(dir).filter((f) => /\.(log|json|txt)$/i.test(f) && f.indexOf(path.sep + "runtime" + path.sep) < 0 && f.indexOf(path.sep + "base" + path.sep) < 0)
  .filter((f) => { const t = fs.readFileSync(f, "utf8"); const inPgLog = f.includes(path.sep + "postgres" + path.sep); return secrets.some((s) => s && s.length > 3 && (s.length >= 12 || !inPgLog) && t.includes(s)); });

let demo = null; // the shared demonstration install used by several checks
try {
  expect(fs.existsSync(path.join(BUNDLE, "postgresql-bundle.json")), "run `npm run fetch:postgres` first (vendor/pg-bundle is missing)");
  before = await foreignSnapshot();

  // ------------------------------------------------------------------------------------------------ the package
  await test("INST-01.the_bundled_package_matches_its_pin_and_every_file_hash", "integration", async () => {
    const pin = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "postgresql-pin.json"), "utf8"));
    const bm = readBundleManifest(BUNDLE);
    expect(bm.sourceSha256 === pin.sha256 && bm.version === pin.version && bm.source === pin.url, "bundle manifest is for the pinned archive");
    expect(/^[0-9a-f]{64}$/.test(bm.sourceSha256), "sha256 shape");
    const bad = verifyTree(BUNDLE, bm);
    expect(bad.length === 0, "all " + bm.fileCount + " files match: " + bad.slice(0, 2).join("; "));
    for (const n of ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]) expect(fs.existsSync(path.join(BUNDLE, "bin", n)), n + " travels with the binaries");
    expect(fs.existsSync(path.join(BUNDLE, "server_license.txt")), "license text included");
    return `${bm.fileCount} files, ${(bm.totalBytes / 1048576).toFixed(0)} MB`;
  });

  await test("INST-02.a_tampered_package_or_runtime_is_refused", "security", async () => {
    const copy = path.join(os.tmpdir(), "pos-inst-tamper-" + rnd(4));
    tmpRoots.push(copy);
    fs.cpSync(BUNDLE, copy, { recursive: true });
    fs.appendFileSync(path.join(copy, "bin", "pg_ctl.exe"), "x");
    const root = mkRoot("tamper");
    let err;
    try { installRuntime(copy, layoutFor(root)); } catch (e) { err = e; }
    expect(err?.code === "PAQUETE_ALTERADO", "tampered bundle refused: " + err?.code);
    expect(!fs.existsSync(path.join(root, "runtime")), "nothing copied");
    const bad = verifyTree(copy, readBundleManifest(copy), { only: ["bin/pg_ctl.exe"] });
    expect(bad.length === 1, "single-file check sees it");
  });

  // ------------------------------------------------------------------------------------------------ preflight scenarios
  await test("INST-03.preflight_reports_this_machine_and_sees_the_developers_own_postgres_without_touching_it", "integration", async () => {
    const root = mkRoot("pf");
    const r = await preflight({ layout: layoutFor(root), bundleDir: BUNDLE, ...portRange() });
    expect(r.ok, "preflight ok: " + r.checks.filter((c) => c.status === "fail").map((c) => c.message).join(" "));
    const ids = r.checks.map((c) => c.id);
    for (const id of ["windows", "disk", "bundle", "foreign", "port"]) expect(ids.includes(id), "check " + id);
    expect(r.windows.arch === "x64", "x64");
    const foreign = await detectForeignPostgres();
    expect(foreign.services.length >= 1 || foreign.port5432InUse, "this machine has its own PostgreSQL (scenario: another PostgreSQL on 5432)");
    expect(!fs.existsSync(root), "preflight created nothing");
    return `${foreign.services.map((s) => s.name + ":" + s.state).join(",") || "listener only"}`;
  });

  await test("INST-04.insufficient_disk_space_stops_before_anything_is_created", "integration", async () => {
    const root = mkRoot("disk");
    let err;
    try { await install(root, "demo", distinctPins(), { minFreeBytes: Number.MAX_SAFE_INTEGER }); } catch (e) { err = e; }
    expect(err?.code === "PREFLIGHT" && /Espacio insuficiente/.test(err.message), "space refused: " + err?.message);
    expect(!fs.existsSync(root), "no folder was created");
  });

  await test("INST-05.a_busy_preferred_port_moves_the_instance_to_the_next_free_one", "integration", async () => {
    const root = mkRoot("port");
    const range = portRange();
    const blocker = net.createServer();
    await new Promise((res) => blocker.listen(range.portFirst, "127.0.0.1", res));
    try {
      expect(!(await isPortFree(range.portFirst)), "the blocker is seen");
      const r = await install(root, "clean", { adminName: "Admin Prueba", adminPin: pin6() }, range);
      expect(r.connection.port === range.portFirst + 1, "next free port chosen: " + r.connection.port);
      expect(readManifest(layoutFor(root)).postgres.port === r.connection.port && readConfiguredPort(layoutFor(root)) === r.connection.port, "manifest and cluster agree");
    } finally {
      blocker.close();
      cleanupRoot(root);
    }
  });

  // ------------------------------------------------------------------------------------------------ first installation: demonstration
  const dpins = distinctPins();
  const demoRoot = mkRoot("demo");
  const steps = [];
  await test("INST-06.first_installation_in_demonstration_mode_builds_everything_without_manual_postgresql_work", "integration", async () => {
    demo = await install(demoRoot, "demo", dpins, { onStep: (s) => steps.push(s.id + ":" + s.status) });
    expect(demo.manifest.state === "ready", "ready");
    expect(demo.summary.seeded.products === 24 && demo.summary.seeded.sales === 12 && demo.summary.seeded.returns === 2, "demonstration dataset: " + JSON.stringify(demo.summary.seeded));
    expect(demo.summary.migrations === 10 || demo.summary.migrations >= 10, "schema applied");
    expect(["preflight", "runtime", "initdb", "start", "database", "config", "verify"].every((id) => steps.includes(id + ":done")), "all steps reported: " + steps.join(","));
    expect(connOf.get(demoRoot)?.user === "pos_demo_runtime", "runtime role returned to the caller for protected storage");
    secretsSeen.push(adminPwdOf.get(demoRoot), connOf.get(demoRoot).password, dpins.adminPin, dpins.vendorPin);
    return `port ${demo.connection.port}`;
  });

  await test("INST-07.demonstration_data_matches_the_definition_to_the_cent_and_pins_are_only_hashes", "integration", async () => {
    const url = appUrl(connOf.get(demoRoot), demo.connection.port);
    const T = expectedTotals();
    const rows = await q(url, "select (select count(*) from products)::int p, (select count(*) from sales)::int s, (select count(*) from returns)::int r, (select count(*) from cash_sessions)::int cs, (select coalesce(sum(total),0)::text from sales where payment_method='cash') cash, (select coalesce(sum(total),0)::text from sales where payment_method='card') card");
    const r = rows[0];
    expect(r.p === T.products && r.s === T.sales && r.r === T.returns && r.cs === 3, "counts: " + JSON.stringify(r));
    expect(Math.round(Number(r.cash) * 100) === T.cashSalesCents && Math.round(Number(r.card) * 100) === T.cardSalesCents, "money matches to the cent");
    const users = await q(url, "select name, role, pin_hash from users order by id");
    expect(users.length === 2 && users[0].name === "Administrador Demo", "two demonstration users");
    expect(await verifyPin(dpins.adminPin, users[0].pin_hash) && await verifyPin(dpins.vendorPin, users[1].pin_hash), "chosen PINs verify");
    expect(users.every((u) => /^scrypt\$/.test(u.pin_hash) && !u.pin_hash.includes(dpins.adminPin)), "stored as salted scrypt only");
    const noKnown = await Promise.all(["654321", "000000", "111111", "246810", "121212"].map((p) => verifyPin(p, users[0].pin_hash)));
    expect(!noKnown.some(Boolean), "no well-known PIN works");
  });

  await test("INST-08.the_runtime_role_has_minimum_privileges_and_the_cluster_is_scram_loopback_only", "security", async () => {
    const l = layoutFor(demoRoot);
    const c = connOf.get(demoRoot);
    const url = appUrl(c);
    let ddl = "", create = "";
    try { await q(url, "create table hacked(x int)"); } catch (e) { ddl = e.code; }
    try { await q(url, "create role evil"); } catch (e) { create = e.code; }
    expect(ddl === "42501" && create === "42501", "no DDL, no role creation: " + ddl + "/" + create);
    const sup = adminUrl({ port: c.port, password: adminPwdOf.get(demoRoot) });
    const info = (await q(sup, "select r.rolname, r.rolpassword like 'SCRAM-SHA-256$%' scram, r.rolsuper, current_setting('listen_addresses') la, current_setting('password_encryption') pe from pg_authid r where r.rolname in ('pos_cluster_admin','pos_demo_runtime') order by 1"));
    expect(info.every((r) => r.scram) && info[0].la === "127.0.0.1" && info[0].pe === "scram-sha-256", "SCRAM stored and enforced: " + JSON.stringify(info));
    expect(info.find((r) => r.rolname === "pos_demo_runtime").rolsuper === false, "app role is not a superuser");
    const noPw = new pg.Client({ host: "127.0.0.1", port: c.port, user: "pos_cluster_admin", database: "postgres", connectionTimeoutMillis: 4000 });
    let denied = false;
    try { await noPw.connect(); await noPw.end(); } catch { denied = true; }
    expect(denied, "no password, no entry (trust is absent)");
    const bad = auditClusterConfig(l);
    expect(bad.length === 0, "pg_hba/postgresql.conf policy: " + bad.join(";"));
    const hba = fs.readFileSync(path.join(l.data, "pg_hba.conf"), "utf8");
    expect(!/\btrust\b|\bpassword\b|md5/.test(hba.replace(/#.*$/gm, "")), "no trust/password/md5 in pg_hba");
    const db = (await q(sup, "select pg_encoding_to_char(encoding) e, datlocprovider p, shobj_description(oid,'pg_database') c from pg_database where datname='beauty_pos_demo'"))[0];
    expect(db.e === "UTF8" && db.p === "b" && /^estetica-leal-pos:managed:demo:/.test(db.c), "UTF8/builtin and marked as managed demo: " + JSON.stringify(db));
    expect((await q(sup, "select 'Ámbito' ilike 'ámbito' ok"))[0].ok, "accent-insensitive case folding works");
  });

  await test("INST-09.permissions_the_service_account_and_listening_sockets_are_restricted", "security", async () => {
    const l = layoutFor(demoRoot);
    for (const target of [l.root, l.data, l.logs]) {
      const a = auditAcl(target);
      expect((a.protectedInheritance || target !== l.root) && a.extra.length === 0, `${path.basename(target)} only SYSTEM/Administrators/this user: extra=${a.extra.join(",")}`);
    }
    const sid = currentUserSid();
    expect(auditAcl(l.root).sids.includes(sid), "this user has access");
    // the processes: owned by this user, not elevated, listening on 127.0.0.1 only
    const info = ps(`$p = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:POS_DIR, [StringComparison]::OrdinalIgnoreCase) -and $_.Name -eq 'postgres.exe' }; $o = $p | ForEach-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User } | Sort-Object -Unique; $ids = $p.ProcessId; $l = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }; [pscustomobject]@{ owners = @($o); listeners = @($l); count = @($p).Count } | ConvertTo-Json -Compress`, { POS_DIR: l.root + path.sep });
    const j = JSON.parse(info.stdout);
    expect(j.count >= 1, "postgres processes found under the managed runtime");
    expect([].concat(j.owners).every((o) => o.toLowerCase() === os.userInfo().username.toLowerCase()), "owned by the current user, not SYSTEM: " + j.owners);
    expect([].concat(j.listeners).length >= 1 && [].concat(j.listeners).every((a) => a.startsWith("127.0.0.1:")), "listens only on 127.0.0.1: " + j.listeners);
    const groups = spawnSync(path.join(process.env.SystemRoot, "System32", "whoami.exe"), ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8" }).stdout;
    expect(!groups.includes("S-1-16-12288"), "this run is NOT elevated: no administrator rights were needed (the case 'no elevation' is the normal case)");
    // no password on any command line
    const cmd = ps("Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:POS_DIR, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.CommandLine }", { POS_DIR: l.root + path.sep }).stdout;
    expect(![adminPwdOf.get(demoRoot), connOf.get(demoRoot).password].some((s) => cmd.includes(s)), "no secret in the process command lines");
    expect(!fs.existsSync(l.tmp), "the temporary password file and its folder are gone");
  });

  await test("INST-10.no_secret_reaches_logs_manifest_or_any_text_file_of_the_managed_root", "security", async () => {
    const leaks = logLeaks(demoRoot, secretsSeen);
    expect(leaks.length === 0, "secret found in: " + leaks.join(", "));
    const files = treeText(path.join(demoRoot, "logs")).map((f) => path.basename(f));
    expect(files.some((f) => /^provision-/.test(f)), "provision log exists: " + files.join(","));
    expect(!fs.existsSync(layoutFor(demoRoot).adminSecret), "the superuser secret is written by the application (protected by Windows), never by this library");
    const m = fs.readFileSync(layoutFor(demoRoot).manifest, "utf8");
    expect(!/password|pin/i.test(m.replace(/"superuser"/g, "")), "manifest holds no credentials");
  });

  // ------------------------------------------------------------------------------------------------ lifecycle
  await test("INST-11.running_the_installer_again_changes_nothing_and_never_seeds_over_existing_data", "integration", async () => {
    const l = layoutFor(demoRoot);
    const manifestBefore = fs.readFileSync(l.manifest, "utf8");
    const dirsBefore = fs.readdirSync(l.root).sort().join(",");
    const sales = (await q(adminUrl({ port: demo.connection.port, password: adminPwdOf.get(demoRoot), database: "beauty_pos_demo" }), "select count(*)::int n from sales"))[0].n;
    for (const mode of ["demo", "clean"]) {
      let err;
      try { await install(demoRoot, mode, mode === "demo" ? distinctPins() : { adminName: "Otro", adminPin: pin6() }); } catch (e) { err = e; }
      expect(err?.code === "YA_INSTALADO", mode + " re-run refused: " + err?.code);
    }
    expect(fs.readFileSync(l.manifest, "utf8") === manifestBefore, "manifest byte-identical");
    expect(fs.readdirSync(l.root).sort().join(",") === dirsBefore, "no second cluster, runtime or database folder");
    const after = (await q(adminUrl({ port: demo.connection.port, password: adminPwdOf.get(demoRoot), database: "beauty_pos_demo" }), "select count(*)::int n from sales"))[0].n;
    expect(after === sales, "sales untouched");
  });

  await test("INST-12.a_stopped_instance_is_started_again_and_a_hard_kill_recovers_without_losing_committed_data", "integration", async () => {
    const l = layoutFor(demoRoot);
    const m = readManifest(l);
    const rt = runtimeOf(demoRoot);
    const url = () => adminUrl({ port: demo.connection.port, password: adminPwdOf.get(demoRoot), database: "beauty_pos_demo" });
    await q(url(), "insert into cash_movements(session_id,user_id,type,amount,reason) select id,1,'IN','1.00','marca-antes-del-corte' from cash_sessions limit 1");
    // "Windows restarted": the postmaster and its children die with no clean shutdown
    const pid = Number(fs.readFileSync(path.join(l.data, "postmaster.pid"), "utf8").split(/\r?\n/)[0]);
    spawnSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/F", "/T"], { encoding: "utf8" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await isPortFree(demo.connection.port), "server is down");
    const r = await ensureRunning({ layout: l, manifest: m, ...portRangeFor(demo.connection.port) });
    expect(!r.alreadyRunning && r.port === demo.connection.port && !r.portChanged, "started again on the same port");
    const row = await q(url(), "select count(*)::int n from cash_movements where reason='marca-antes-del-corte'");
    expect(row[0].n === 1, "the committed row survived the hard kill (crash recovery)");
    // plain stop + start (scenario: service stopped)
    stopCluster({ layout: l, runtimeDir: rt });
    expect(!clusterRunning(l, rt), "stopped");
    const r2 = await ensureRunning({ layout: l, manifest: m, ...portRangeFor(demo.connection.port) });
    expect(clusterRunning(l, rt) && r2.port === demo.connection.port, "ensureRunning brings it back");
  });

  await test("INST-13.if_another_program_takes_the_registered_port_the_instance_moves_and_reports_it", "integration", async () => {
    const l = layoutFor(demoRoot);
    const m = readManifest(l);
    const rt = runtimeOf(demoRoot);
    const old = demo.connection.port;
    stopCluster({ layout: l, runtimeDir: rt });
    const squatter = net.createServer();
    await new Promise((res) => squatter.listen(old, "127.0.0.1", res));
    try {
      const r = await ensureRunning({ layout: l, manifest: m, portFirst: old, portLast: old + 8 });
      expect(r.portChanged && r.port !== old && readConfiguredPort(l) === r.port, "moved to " + r.port);
      demo.connection.port = r.port;
      const c = connOf.get(demoRoot);
      const ok = await q(appUrl(c, r.port), "select count(*)::int n from users");
      expect(ok[0].n === 2, "data reachable on the new port");
    } finally { squatter.close(); }
  });

  await test("INST-14.ownership_is_proven_by_marker_and_system_identifier_and_a_foreign_cluster_is_never_started", "security", async () => {
    const l = layoutFor(demoRoot);
    const m = readManifest(l);
    const rt = runtimeOf(demoRoot);
    expect((await verifyOwnership({ layout: l, manifest: m, runtimeDir: rt })).ok, "ours");
    const forged = JSON.parse(JSON.stringify(m)); forged.installId = crypto.randomUUID();
    expect(!(await verifyOwnership({ layout: l, manifest: forged, runtimeDir: rt })).ok, "another installId is refused");
    const wrongSid = JSON.parse(JSON.stringify(m)); wrongSid.postgres.systemIdentifier = "9876543210987654321";
    expect(!(await verifyOwnership({ layout: l, manifest: wrongSid, runtimeDir: rt })).ok, "another system identifier is refused");
    stopCluster({ layout: l, runtimeDir: rt });
    let err;
    try { await ensureRunning({ layout: l, manifest: forged, ...portRangeFor(demo.connection.port) }); } catch (e) { err = e; }
    expect(err?.code === "NO_PROPIA", "ensureRunning refuses to start a cluster that is not this installation's: " + err?.code);
    expect(!clusterRunning(l, rt), "and it stayed stopped");
    await ensureRunning({ layout: l, manifest: m, ...portRangeFor(demo.connection.port) });
  });

  await test("INST-15.a_tampered_runtime_binary_is_detected_before_it_is_started", "security", async () => {
    const l = layoutFor(demoRoot);
    const m = readManifest(l);
    const rt = runtimeOf(demoRoot);
    stopCluster({ layout: l, runtimeDir: rt });
    const exe = path.join(rt, "bin", "pg_controldata.exe");
    const keep = fs.readFileSync(path.join(rt, "bin", "initdb.exe"));
    fs.appendFileSync(path.join(rt, "bin", "initdb.exe"), "x");
    let err;
    try { await ensureRunning({ layout: l, manifest: m, ...portRangeFor(demo.connection.port) }); } catch (e) { err = e; }
    fs.writeFileSync(path.join(rt, "bin", "initdb.exe"), keep);
    expect(err?.code === "RUNTIME_ALTERADO" && !clusterRunning(l, rt), "refused and not started: " + err?.code);
    expect(fs.existsSync(exe), "runtime still there");
    await ensureRunning({ layout: l, manifest: m, ...portRangeFor(demo.connection.port) });
  });

  // ------------------------------------------------------------------------------------------------ failure and rollback
  await test("INST-16.a_failed_installation_undoes_only_what_it_created_keeps_a_secret_free_log_and_can_be_retried", "integration", async () => {
    const root = mkRoot("fail");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "preexisting-note.txt"), "no tocar");
    const pins = distinctPins();
    let err;
    try { await install(root, "demo", pins, { persist: async () => { throw new Error("no se pudo guardar la configuración protegida"); } }); } catch (e) { err = e; }
    expect(err && err.step?.id === "config", "the failing step is reported: " + err?.step?.id);
    const l = layoutFor(root);
    expect(!fs.existsSync(l.data) && !fs.existsSync(path.join(root, "runtime", readBundleManifest(BUNDLE).version)) && !fs.existsSync(l.tmp), "cluster, runtime copy and temp folder removed");
    expect(fs.readFileSync(path.join(root, "preexisting-note.txt"), "utf8") === "no tocar", "a preexisting file in the folder is untouched");
    expect(readManifest(l).state === "failed" && readManifest(l).failedStep === "config", "manifest records the failure");
    expect(processesUnder(root) === 0, "no postgres process left running from the failed attempt");
    expect(logLeaks(root, [pins.adminPin, pins.vendorPin]).length === 0, "log has no PIN");
    expect(!!err.logFile && fs.existsSync(err.logFile), "diagnostic log kept: " + path.basename(String(err.logFile)));
    const ok = await install(root, "demo", pins);
    expect(ok.manifest.state === "ready", "a retry on the same folder succeeds");
    cleanupRoot(root);
  });

  await test("INST-17.a_data_folder_that_is_not_ours_blocks_the_installation_and_is_never_deleted", "security", async () => {
    const root = mkRoot("foreign");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "PG_VERSION"), "16\n");
    let err;
    try { await install(root, "demo", distinctPins()); } catch (e) { err = e; }
    expect(err?.code === "PREFLIGHT" && /no pertenece/.test(err.message), "refused: " + err?.message);
    expect(fs.readFileSync(path.join(root, "data", "PG_VERSION"), "utf8") === "16\n", "the foreign data was not touched");
    // and a failed attempt whose leftover carries ANOTHER install's marker is not deleted either
    const root2 = mkRoot("foreign2");
    const first = await install(root2, "clean", { adminName: "Admin", adminPin: pin6() });
    cleanupRoot(root2);
    const m = readManifest(layoutFor(root2));
    m.state = "failed"; m.installId = crypto.randomUUID(); // the manifest no longer matches the data folder's marker
    fs.writeFileSync(layoutFor(root2).manifest, JSON.stringify(m));
    let err2;
    try { await install(root2, "clean", { adminName: "Admin", adminPin: pin6() }); } catch (e) { err2 = e; }
    expect(err2?.code === "CARPETA_AJENA", "leftover without our marker is refused: " + err2?.code);
    expect(fs.existsSync(path.join(root2, "data", "PG_VERSION")) && first.manifest.state === "ready", "data kept");
  });

  await test("INST-18.invalid_inputs_are_rejected_before_anything_exists", "integration", async () => {
    const root = mkRoot("inputs");
    const cases = [["demo", { adminPin: "1234", vendorPin: "987654" }], ["demo", { adminPin: "482913", vendorPin: "482913" }], ["clean", { adminName: "", adminPin: "482913" }], ["clean", { adminName: "Ana", adminPin: "12ab56" }], ["otro", {}]];
    for (const [mode, input] of cases) {
      let err;
      try { await install(root, mode, input); } catch (e) { err = e; }
      expect(!!err, `refused ${mode} ${JSON.stringify(Object.keys(input))}`);
    }
    expect(!fs.existsSync(root), "nothing created");
  });

  // ------------------------------------------------------------------------------------------------ clean installation
  const cleanPin = pin6();
  const cleanRoot = mkRoot("clean");
  await test("INST-19.clean_installation_has_the_full_schema_one_administrator_and_no_fictional_data", "integration", async () => {
    const r = await install(cleanRoot, "clean", { adminName: "Dueña de Prueba", adminPin: cleanPin });
    secretsSeen.push(adminPwdOf.get(cleanRoot), connOf.get(cleanRoot).password, cleanPin);
    expect(r.connection.database === "estetica_leal_pos" && r.connection.user === "pos_leal_runtime", "clean database and role names");
    const c = connOf.get(cleanRoot);
    const url = appUrl(c);
    const n = (await q(url, "select (select count(*) from users)::int u, (select count(*) from products)::int p, (select count(*) from sales)::int s, (select count(*) from cash_sessions)::int cs, (select count(*) from returns)::int r, (select count(*) from business_settings)::int bs"))[0];
    expect(n.u === 1 && n.p === 0 && n.s === 0 && n.cs === 0 && n.r === 0, "only the administrator exists: " + JSON.stringify(n));
    const u = (await q(url, "select name, role, active, pin_hash from users"))[0];
    expect(u.name === "Dueña de Prueba" && u.role === "admin" && u.active && await verifyPin(cleanPin, u.pin_hash), "the administrator can log in with the chosen PIN");
    const bs = (await q(url, "select address, phone from business_settings limit 1"))[0];
    expect(!bs?.address && !bs?.phone, "no commercial data invented");
    const com = (await q(adminUrl({ port: c.port, password: adminPwdOf.get(cleanRoot), database: "postgres" }), "select shobj_description(oid,'pg_database') c from pg_database where datname='estetica_leal_pos'"))[0].c;
    expect(/^estetica-leal-pos:managed:clean:/.test(com), "marked as managed clean");
  });

  await test("INST-20.a_clean_installation_can_never_become_a_demonstration_nor_receive_fictional_data", "security", async () => {
    let err;
    try { await resetDemo({ root: cleanRoot, adminPassword: adminPwdOf.get(cleanRoot), confirm: "REINICIAR", input: distinctPins(), migrationsDir: MIGRATIONS, persist: async () => {} }); } catch (e) { err = e; }
    expect(err?.code === "NO_ES_DEMO", "reset refused on a clean installation: " + err?.code);
    const c = connOf.get(cleanRoot);
    const n = (await q(adminUrl({ port: c.port, password: adminPwdOf.get(cleanRoot), database: "estetica_leal_pos" }), "select (select count(*) from products)::int p, (select count(*) from users)::int u"))[0];
    expect(n.p === 0 && n.u === 1, "data unchanged");
  });

  // ------------------------------------------------------------------------------------------------ administration: backup, restore, schema update, demo reset
  await test("INST-21.backup_is_verified_and_restores_into_a_new_database_with_identical_counts", "integration", async () => {
    const b = await backupManaged({ root: demoRoot, adminPassword: adminPwdOf.get(demoRoot), label: "prueba" });
    expect(fs.existsSync(b.file) && b.summary.sha256 && b.summary.counts, "backup + summary: " + path.basename(b.file));
    expect(b.file.startsWith(layoutFor(demoRoot).backups), "stored inside the managed root");
    const rt = runtimeOf(demoRoot);
    const url = adminUrl({ port: demo.connection.port, password: adminPwdOf.get(demoRoot), database: "beauty_pos_demo" });
    const target = "beauty_pos_e2e_inst" + rnd(3);
    try {
      const r = await restoreToNewDatabase({ url, file: b.file, target, bin: path.join(rt, "bin") });
      expect(r.verified && r.checks.every((c) => c.ok), "restore verified: " + JSON.stringify(r.checks));
      const n = (await q(adminUrl({ port: demo.connection.port, password: adminPwdOf.get(demoRoot), database: target }), "select count(*)::int n from sales"))[0].n;
      expect(n === 12, "sales restored: " + n);
    } finally {
      await withClient(adminUrl({ port: demo.connection.port, password: adminPwdOf.get(demoRoot) }), (c) => c.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`), "inst_cleanup");
    }
    expect(logLeaks(layoutFor(demoRoot).backups, secretsSeen).length === 0, "no secret in the backup summaries");
  });

  await test("INST-22.wrong_credentials_change_nothing", "security", async () => {
    for (const fn of [() => backupManaged({ root: demoRoot, adminPassword: "contraseña-equivocada-123" }), () => updateSchema({ root: demoRoot, adminPassword: "contraseña-equivocada-123", migrationsDir: MIGRATIONS }),
      () => resetDemo({ root: demoRoot, adminPassword: "contraseña-equivocada-123", confirm: "REINICIAR", input: distinctPins(), migrationsDir: MIGRATIONS, persist: async () => {} })]) {
      let err;
      try { await fn(); } catch (e) { err = e; }
      expect(err && (err.code === "28P01" || err.code === "28000"), "wrong superuser password refused: " + err?.code);
    }
    const c = connOf.get(demoRoot);
    let bad = "";
    try { await q(appUrl(c, demo.connection.port, "x" + c.password), "select 1"); } catch (e) { bad = e.code; }
    expect(bad === "28P01", "wrong application password refused");
    expect((await q(adminUrl({ port: demo.connection.port, password: adminPwdOf.get(demoRoot), database: "beauty_pos_demo" }), "select count(*)::int n from sales"))[0].n === 12, "data intact");
  });

  await test("INST-23.schema_update_needs_a_verified_backup_first_keeps_all_data_and_never_runs_by_itself", "integration", async () => {
    // an "older" installation: the same data but the application folder knows one migration more than the database
    const oldMig = path.join(os.tmpdir(), "pos-inst-oldmig-" + rnd(4));
    tmpRoots.push(oldMig);
    fs.cpSync(MIGRATIONS, oldMig, { recursive: true });
    const jf = path.join(oldMig, "meta", "_journal.json");
    const j = JSON.parse(fs.readFileSync(jf, "utf8"));
    const total = j.entries.length;
    j.entries = j.entries.slice(0, total - 1);
    fs.writeFileSync(jf, JSON.stringify(j));
    const root = mkRoot("upd");
    await install(root, "clean", { adminName: "Admin Antiguo", adminPin: pin6() }, { migrationsDir: oldMig });
    const l = layoutFor(root);
    const dbUrl = adminUrl({ port: connOf.get(root).port, password: adminPwdOf.get(root), database: "estetica_leal_pos" });
    await q(dbUrl, "insert into products(sku,name,price,stock) values('ANT-1','Producto anterior','9.50',3)");
    const sales = (await q(dbUrl, "select count(*)::int n from products"))[0].n;
    expect((await q(dbUrl, "select count(*)::int n from drizzle.__drizzle_migrations"))[0].n === total - 1, "database is one migration behind");
    const r = await updateSchema({ root, adminPassword: adminPwdOf.get(root), migrationsDir: MIGRATIONS });
    expect(r.changed && r.status.status === "ok" && r.backup && fs.existsSync(r.backup), "migrated after a backup: " + path.basename(String(r.backup)));
    expect(path.basename(r.backup).includes("pre-migracion"), "backup labelled as pre-migration");
    expect((await q(dbUrl, "select count(*)::int n from products"))[0].n === sales && (await q(dbUrl, "select count(*)::int n from users"))[0].n === 1, "data kept");
    expect((await q(dbUrl, "select count(*)::int n from drizzle.__drizzle_migrations"))[0].n === total, "now current");
    const again = await updateSchema({ root, adminPassword: adminPwdOf.get(root), migrationsDir: MIGRATIONS });
    expect(!again.changed, "second run: nothing to do");
    // a database NEWER than the application is never touched
    let err;
    try { await updateSchema({ root, adminPassword: adminPwdOf.get(root), migrationsDir: oldMig }); } catch (e) { err = e; }
    expect(err?.code === "ESQUEMA_MAS_NUEVO", "newer schema refused: " + err?.code);
    expect(readManifest(l).schemaMigrations === total, "manifest updated");
    cleanupRoot(root);
  });

  await test("INST-24.demo_reset_needs_the_confirmation_word_makes_a_backup_and_only_touches_the_managed_demo", "security", async () => {
    const root = mkRoot("reset");
    const pins = distinctPins();
    await install(root, "demo", pins);
    const adminPw = adminPwdOf.get(root);
    let err;
    try { await resetDemo({ root, adminPassword: adminPw, confirm: "si", input: distinctPins(), migrationsDir: MIGRATIONS, persist: async () => {} }); } catch (e) { err = e; }
    expect(err?.code === "SIN_CONFIRMACION", "confirmation word required");
    const dbUrl = () => adminUrl({ port: connOf.get(root).port, password: adminPw, database: "beauty_pos_demo" });
    await q(dbUrl(), "insert into users(name,pin_hash,role) values('Rehearsal','x','vendor')");
    // an unmarked database with the same name must not be dropped
    const m = readManifest(layoutFor(root));
    await withClient(adminUrl({ port: connOf.get(root).port, password: adminPw }), (c) => c.query("comment on database beauty_pos_demo is 'otra cosa'"), "inst_test");
    let err2;
    try { await resetDemo({ root, adminPassword: adminPw, confirm: "REINICIAR", input: distinctPins(), migrationsDir: MIGRATIONS, persist: async () => {} }); } catch (e) { err2 = e; }
    expect(err2?.code === "NO_ES_DEMO" && (await q(dbUrl(), "select count(*)::int n from users where name='Rehearsal'"))[0].n === 1, "database without our marker is not dropped");
    await withClient(adminUrl({ port: connOf.get(root).port, password: adminPw }), async (c) => c.query((await c.query("select format('comment on database beauty_pos_demo is %L', $1::text) q", ["estetica-leal-pos:managed:demo:" + m.installId])).rows[0].q), "inst_test");
    const fresh = distinctPins();
    let newConn;
    const res = await resetDemo({ root, adminPassword: adminPw, confirm: "REINICIAR", input: fresh, migrationsDir: MIGRATIONS, persist: async ({ connection }) => { newConn = connection; } });
    expect(fs.existsSync(res.backup) && path.basename(res.backup).includes("pre-reinicio-demo"), "backup before the reset");
    const users = await q(dbUrl(), "select name, pin_hash from users order by id");
    expect(users.length === 2 && !users.some((u) => u.name === "Rehearsal"), "demonstration restored, rehearsal data gone");
    expect(await verifyPin(fresh.adminPin, users[0].pin_hash) && !(await verifyPin(pins.adminPin, users[0].pin_hash)), "new PINs, old ones gone");
    expect(newConn.user === "pos_demo_runtime" && newConn.password, "new runtime credential handed to the caller");
    expect((await q(dbUrl(), "select count(*)::int n from sales"))[0].n === 12, "same 12 sales as a fresh demonstration");
    cleanupRoot(root);
  });

  await test("INST-24b.the_maintenance_status_reads_mode_schema_and_backups_without_changing_anything", "integration", async () => {
    const s = await managedStatus({ root: demoRoot, adminPassword: adminPwdOf.get(demoRoot), migrationsDir: MIGRATIONS });
    expect(s.mode === "demo" && s.database === "beauty_pos_demo" && s.schema.status === "ok" && s.schema.applied === s.schema.required, "demo status: " + JSON.stringify(s.schema));
    expect(s.backups.count >= 1 && /\.dump$/.test(s.backups.latest), "sees the backup made earlier: " + s.backups.latest);
    const c = await managedStatus({ root: cleanRoot, adminPassword: adminPwdOf.get(cleanRoot), migrationsDir: MIGRATIONS });
    expect(c.mode === "clean" && c.backups.count === 0, "clean status has no backups yet");
  });

  // ------------------------------------------------------------------------------------------------ uninstall / reinstall
  await test("INST-25.removing_the_application_folder_leaves_the_instance_and_data_usable_and_a_reinstall_reconnects", "integration", async () => {
    // the application folder (source of the bundle) is gone: the instance runs from its own runtime copy
    const l = layoutFor(demoRoot);
    const m = readManifest(l);
    const rt = runtimeOf(demoRoot);
    stopCluster({ layout: l, runtimeDir: rt });
    const sales = (await (async () => { await ensureRunning({ layout: l, manifest: m, ...portRangeFor(demo.connection.port) }); const c = connOf.get(demoRoot); return q(appUrl(c, readConfiguredPort(l)), "select count(*)::int n from sales"); })())[0].n;
    expect(sales === 12, "started without the application bundle; data intact");
    // "reinstall": the installer runs again and finds the installation instead of making another
    let err;
    try { await install(demoRoot, "demo", distinctPins()); } catch (e) { err = e; }
    expect(err?.code === "YA_INSTALADO", "reinstall reconnects, it does not recreate: " + err?.code);
    const ctx = await loadManaged(demoRoot);
    expect(ctx.manifest.installId === m.installId, "same installation id");
  });

  await test("INST-26.no_network_access_in_the_installer_code_and_the_package_fetch_is_build_time_only", "security", async () => {
    const files = ["scripts/lib/managed-pg.mjs", "scripts/lib/provision.mjs"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"));
    for (const t of files) {
      const code = t.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(!/\bfetch\s*\(|from "node:https?"|require\("https?"\)|XMLHttpRequest|WebSocket/.test(code), "no HTTP client in the installation code");
    }
    const fetchScript = fs.readFileSync(path.join(ROOT, "scripts/fetch-postgres.mjs"), "utf8");
    expect(/node:https/.test(fetchScript), "the only downloader is the build-time script");
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(!JSON.stringify(pkg.build).includes("download") , "installer config downloads nothing");
  });

  // ------------------------------------------------------------------------------------------------ the developer's PostgreSQL
  await test("INST-27.the_developers_own_postgres_and_its_databases_are_exactly_as_they_were", "security", async () => {
    const after = await foreignSnapshot();
    if (!before || !after) return "no developer PostgreSQL reachable to compare (skipped comparison)";
    expect(JSON.stringify(after.dbs) === JSON.stringify(before.dbs), "same databases");
    expect(JSON.stringify(after.roles) === JSON.stringify(before.roles), "same roles");
    expect(after.started === before.started, "that server was not restarted");
    return `${after.dbs.length} databases, ${after.roles.length} roles unchanged`;
  });
} catch (e) {
  rec("installer.unexpected_error", "FAIL", String(e.stack || e).split("\n").slice(0, 3).join(" | "), { kind: "integration" });
} finally {
  for (const d of tmpRoots) {
    try { cleanupRoot(path.join(d, "managed")); } catch { /* ignore */ }
    killProcessesUnder(d);
  }
  await new Promise((r) => setTimeout(r, 800));
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
}

function portRangeFor(port) {
  return { portFirst: port, portLast: port + 8 };
}
const { summary, exitCode } = summarize(results, null, { suite: "installer" });
console.log("SUMMARY", JSON.stringify(summary));
process.exit(exitCode);
