import test from "node:test";
import assert from "node:assert/strict";
import { createRecorder, summarize, expect } from "../lib/recorder.mjs";

const mk = () => createRecorder("t", ".", () => null, { log: () => {} });
const status = (r, id) => r.results.find((x) => x.id === id)?.status;
const bug = { id: "BUG-X", symptom: /status is 'open'/ };

test("plain tests: PASS and FAIL", async () => {
  const r = mk();
  await r.test("ok", "e2e", async () => {});
  await r.test("bad", "e2e", async () => { expect(false, "nope"); });
  assert.equal(status(r, "ok"), "PASS");
  assert.equal(status(r, "bad"), "FAIL");
});
test("known bug failing with its documented symptom is KNOWN_FAIL", async () => {
  const r = mk();
  await r.test("b", "integration", async () => { expect(false, "status is 'open' after closing"); }, { knownBug: bug });
  assert.equal(status(r, "b"), "KNOWN_FAIL");
});
test("known bug that starts passing is UNEXPECTED_PASS and makes the run non-zero", async () => {
  const r = mk();
  await r.test("b", "integration", async () => {}, { knownBug: bug });
  assert.equal(status(r, "b"), "UNEXPECTED_PASS");
  assert.equal(summarize(r.results).exitCode, 3);
});
test("a different failure disguised as a known bug is a real FAIL", async () => {
  const r = mk();
  await r.test("wrongsymptom", "integration", async () => { expect(false, "something else broke"); }, { knownBug: bug });
  await r.test("setup", "integration", async () => { const x = undefined; return x.id; }, { knownBug: bug });
  await r.test("timeout", "integration", async () => { throw new Error("Timeout 30000ms exceeded status is 'open'"); }, { knownBug: bug });
  assert.deepEqual(["wrongsymptom", "setup", "timeout"].map((i) => status(r, i)), ["FAIL", "FAIL", "FAIL"]);
});
test("skip is recorded as SKIP and does not fail the run", () => {
  const r = mk();
  r.skip("packaged", "e2e", "not implemented");
  assert.equal(status(r, "packaged"), "SKIP");
  assert.equal(summarize(r.results).exitCode, 0);
});
test("exit codes: fatal or FAIL -> 1, UNEXPECTED_PASS -> 3, PASS/KNOWN_FAIL/SKIP/WARN -> 0", () => {
  const row = (s) => ({ status: s });
  assert.equal(summarize([row("PASS"), row("KNOWN_FAIL"), row("SKIP"), row("WARN")]).exitCode, 0);
  assert.equal(summarize([row("PASS"), row("FAIL")]).exitCode, 1);
  assert.equal(summarize([row("PASS")], new Error("setup exploded")).exitCode, 1, "setup/fatal errors are real failures");
  assert.equal(summarize([row("UNEXPECTED_PASS")]).exitCode, 3);
  assert.equal(summarize([row("FAIL"), row("UNEXPECTED_PASS")]).exitCode, 1);
});

test("summary totals add up: every result is counted exactly once", () => {
  const rows = ["PASS", "PASS", "FAIL", "KNOWN_FAIL", "SKIP", "WARN", "UNEXPECTED_PASS"].map((status, i) => ({ status, id: i === 5 ? "renderer.console_errors" : "t" + i }));
  const { summary } = summarize(rows);
  assert.equal(summary.total, 7);
  assert.equal(summary.PASS + summary.FAIL + summary.KNOWN_FAIL + summary.SKIP + summary.WARN + summary.UNEXPECTED_PASS, summary.total);
  assert.equal(summary.tests + summary.infraChecks, summary.total);
  assert.equal(summary.infraChecks, 1);
});
