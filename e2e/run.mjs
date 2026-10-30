// Usage: node e2e/run.mjs [security|ui|integration|catalog|all]   (default: all)
// Artifacts (logs, screenshots, results.json) go to e2e-artifacts/<run>/ which is git-ignored.
// Exit codes: 0 ok | 1 failure or fatal error | 2 bad usage | 3 a KNOWN_FAIL started passing (UNEXPECTED_PASS).
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  ROOT, ensureVite, buildMain, createRunDb, dropRunDb, connectRunDb, launchApp, startConnMonitor,
  makeData, createRecorder, summarize, scrub, sleep,
} from "./lib/harness.mjs";

const SUITES = { security: "./suites/security.mjs", ui: "./suites/ui.mjs", integration: "./suites/integration.mjs", catalog: "./suites/catalog.mjs", returns: "./suites/returns.mjs", hardening: "./suites/hardening.mjs", pin: "./suites/pin.mjs", screens: "./suites/screens.mjs", cart: "./suites/cart.mjs" };
const arg = process.argv[2] || "all";
const selected = arg === "all" ? ["security", "ui", "integration", "catalog", "returns", "hardening", "pin", "screens", "cart"] : [arg];
if (!selected.every((s) => SUITES[s])) {
  console.error("Unknown suite. Use: security | ui | integration | catalog | returns | hardening | pin | screens | cart | all");
  process.exit(2);
}

const runId = Date.now().toString(36) + crypto.randomBytes(1).toString("hex");
const artifacts = path.join(ROOT, "e2e-artifacts", runId);
fs.mkdirSync(artifacts, { recursive: true });
const all = [];
let vite, runDb, fatal, currentApp;
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? scrub(x) : x)));

// Only things this run created are ever cleaned up.
async function cleanup() {
  try { await currentApp?.close(); } catch {}
  currentApp = null;
  vite?.stop();
  vite = null;
  if (runDb) {
    const name = runDb; runDb = null;
    if (process.env.E2E_KEEP_DB === "1") log(`database kept for inspection: ${name}`);
    else { try { await dropRunDb(name); log(`isolated database dropped: ${name}`); } catch (e) { log(`could not drop ${name}: ${e.message}`); } }
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await cleanup(); process.exit(1); });

try {
  log(`E2E run ${runId} :: suites=${selected.join(",")}`);
  buildMain();
  vite = await ensureVite();
  runDb = await createRunDb();
  log(`isolated database created: ${runDb} (existing databases are not touched)`);

  for (const name of selected) {
    const mod = await import(SUITES[name]);
    const db = await connectRunDb(runDb);
    const monitor = await startConnMonitor();
    let page;
    const { results, rec, test, skip } = createRecorder(name, artifacts, () => page, { log });
    let launched;
    try {
      launched = await launchApp(runDb, db, artifacts, mod.env);
      currentApp = launched.app;
      page = launched.page;
      const ctx = {
        runId: `${runId}${name[0]}`, runDb, db, page, app: launched.app, artifacts,
        data: makeData(db, `${runId}${name[0]}`), rec, test, skip,
        mainLog: launched.mainLog, consoleErrors: launched.consoleErrors, watch: launched.watch,
      };
      const conn = (await db.query("select current_database() d")).rows[0].d;
      rec("isolation.current_database", conn === runDb ? "PASS" : "FAIL", `current_database()=${conn}`, { kind: "integration" });
      if (conn !== runDb) throw new Error("isolation not proven");
      await mod.run(ctx);
      const errs = [...new Set(launched.consoleErrors.filter((e) => !/Autofill/.test(e)))];
      rec("renderer.console_errors", errs.length ? "WARN" : "PASS", JSON.stringify(errs.slice(0, 5)), { kind: "e2e" });
    } catch (e) {
      // Setup or suite-level exceptions are real failures, never masked.
      rec("suite.unexpected_error", "FAIL", scrub(String(e.stack || e)).split("\n").slice(0, 3).join(" | ").slice(0, 400), { kind: "integration" });
      fatal = fatal || e;
    } finally {
      try { await launched?.app.close(); } catch {}
      if (launched?.userData) { await sleep(300); try { fs.rmSync(launched.userData, { recursive: true, force: true }); } catch {} }
      currentApp = null;
      await sleep(300);
      await monitor.stop();
      const dbs = [...monitor.seen.keys()];
      rec("isolation.app_connections_reach_only_run_db", dbs.length && dbs.every((d) => d === runDb) ? "PASS" : "FAIL", `app connections observed on: ${dbs.join(",") || "none"}`, { kind: "integration" });
      if (launched) fs.writeFileSync(path.join(artifacts, `${name}.main.log`), scrub(launched.mainLog.join("\n")));
      all.push(...results);
      await db.end().catch(() => {});
    }
  }
} catch (e) {
  fatal = e;
  console.error("FATAL:", scrub(String(e.stack || e)).slice(0, 1200));
} finally {
  await cleanup();
}

const { summary, exitCode } = summarize(all, fatal, { runId, suites: selected });
fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({ summary, results: all }, null, 1));
log("SUMMARY", JSON.stringify(summary));
log(`artifacts: ${artifacts}`);
process.exit(exitCode);
