// Result recording semantics (dependency free so it can be unit tested).
//
// Statuses: PASS | FAIL | KNOWN_FAIL | UNEXPECTED_PASS | SKIP | WARN
//  - A test tagged `knownBug: { id, symptom }` asserts the DESIRED behaviour of a documented open bug.
//    It is KNOWN_FAIL only when it fails with an ExpectationError whose message matches the documented
//    symptom. Any other failure (setup error, timeout, TypeError, a different symptom) is a real FAIL.
//  - A known-bug test that passes is UNEXPECTED_PASS (the bug seems fixed: remove the tag). It makes the
//    run exit non-zero so it cannot be ignored silently.
import path from "node:path";

export class ExpectationError extends Error {}
export function expect(cond, msg) { if (!cond) throw new ExpectationError("expectation failed: " + msg); }

export function createRecorder(suite, artifacts, getPage, { log = console.log } = {}) {
  const results = [];
  const rec = (id, status, detail = "", extra = {}) => {
    results.push({ suite, id, status, detail, ...extra });
    log(`[${status}] ${suite}/${id}${detail ? " :: " + detail : ""}`);
  };
  const shoot = async (id) => {
    try { const p = getPage && getPage(); if (p) await p.screenshot({ path: path.join(artifacts, `${suite}_${id.replace(/\W+/g, "_")}.png`) }); } catch {}
  };
  /** kind: "e2e" (real window interaction) | "integration" (IPC + DB) | "security" */
  const test = async (id, kind, fn, { knownBug } = {}) => {
    try {
      const d = await fn();
      rec(id, knownBug ? "UNEXPECTED_PASS" : "PASS", d || "", { kind, knownBug: knownBug?.id });
    } catch (e) {
      const msg = String(e.message).split("\n")[0].slice(0, 400);
      if (!knownBug) { rec(id, "FAIL", msg, { kind }); await shoot(id); return; }
      const documented = e instanceof ExpectationError && knownBug.symptom.test(msg);
      if (documented) rec(id, "KNOWN_FAIL", msg, { kind, knownBug: knownBug.id });
      else { rec(id, "FAIL", `not the documented ${knownBug.id} symptom (${e.constructor.name}): ${msg}`, { kind, knownBug: knownBug.id }); await shoot(id); }
    }
  };
  const skip = (id, kind, reason) => rec(id, "SKIP", reason, { kind });
  return { results, rec, test, skip };
}

/** Final verdict. FAIL or a fatal error -> exit 1; UNEXPECTED_PASS -> exit 3; otherwise 0. */
export function summarize(results, fatal = null, meta = {}) {
  const c = (s) => results.filter((r) => r.status === s).length;
  const infra = results.filter((r) => /^(isolation|renderer)\./.test(r.id)).length; // environment checks, not product tests
  const summary = { ...meta, total: results.length, tests: results.length - infra, infraChecks: infra, PASS: c("PASS"), FAIL: c("FAIL"), KNOWN_FAIL: c("KNOWN_FAIL"), UNEXPECTED_PASS: c("UNEXPECTED_PASS"), SKIP: c("SKIP"), WARN: c("WARN"), fatal: fatal ? String(fatal.message || fatal).slice(0, 300) : null };
  const exitCode = summary.FAIL > 0 || summary.fatal ? 1 : summary.UNEXPECTED_PASS > 0 ? 3 : 0;
  return { summary, exitCode };
}
