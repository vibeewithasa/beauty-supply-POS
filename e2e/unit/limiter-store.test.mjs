import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIMITER_FILE, loadLimiterState, saveLimiterState } from "../../src/backend/limiter-store.ts";
import { LoginLimiter } from "../../src/backend/login-limiter.ts";

const cfg = { maxAttempts: 3, baseLockMs: 1000, maxLockMs: 8000, resetAfterMs: 60_000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "limiter-store-"));

test("a state survives a restart through the file", () => {
  const dir = tmp();
  const file = path.join(dir, "nested", LIMITER_FILE);
  const t = 1_000_000;
  const a = new LoginLimiter(cfg, () => t, (s) => saveLimiterState(file, s));
  for (let i = 0; i < 3; i++) a.fail();
  const b = new LoginLimiter(cfg, () => t + 100);
  b.restore(loadLimiterState(file, t + 100, cfg));
  assert.equal(b.check().locked, true);
  assert.equal(b.check().retryAfterMs, 900);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the file holds three numbers and nothing else (no PIN, hash or user)", () => {
  const dir = tmp();
  const file = path.join(dir, LIMITER_FILE);
  const l = new LoginLimiter(cfg, () => 5000, (s) => saveLimiterState(file, s));
  l.fail();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort(), ["failures", "lastFailureAt", "lockedUntil"]);
  assert.deepEqual(fs.readdirSync(dir), [LIMITER_FILE], "no temporary file is left behind");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing, empty, corrupt or foreign file means 'no state', never an error and never a lock", () => {
  const dir = tmp();
  const file = path.join(dir, LIMITER_FILE);
  assert.equal(loadLimiterState(file, 1000, cfg), null, "missing");
  for (const content of ["", "{", "null", "[]", "42", '{"failures":"x"}', '{"failures":0,"lastFailureAt":0,"lockedUntil":0}']) {
    fs.writeFileSync(file, content);
    assert.equal(loadLimiterState(file, 1000, cfg), null, JSON.stringify(content));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unwritable location never throws", () => {
  const dir = tmp();
  const blocker = path.join(dir, "file-not-folder");
  fs.writeFileSync(blocker, "x");
  assert.doesNotThrow(() => saveLimiterState(path.join(blocker, "inside", LIMITER_FILE), { failures: 1, lastFailureAt: 1, lockedUntil: 0 }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hand-edited file cannot create a permanent lock", () => {
  const dir = tmp();
  const file = path.join(dir, LIMITER_FILE);
  const now = 2_000_000;
  fs.writeFileSync(file, JSON.stringify({ failures: 1000000, lastFailureAt: now * 9, lockedUntil: now * 9 }));
  const l = new LoginLimiter(cfg, () => now);
  l.restore(loadLimiterState(file, now, cfg));
  assert.ok(l.check().retryAfterMs <= cfg.maxLockMs);
  const later = new LoginLimiter(cfg, () => now + cfg.maxLockMs + cfg.resetAfterMs + 1);
  later.restore(loadLimiterState(file, now, cfg));
  assert.equal(later.check().locked, false, "it ends by itself");
  fs.rmSync(dir, { recursive: true, force: true });
});
