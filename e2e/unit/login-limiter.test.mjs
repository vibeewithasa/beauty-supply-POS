import test from "node:test";
import assert from "node:assert/strict";
import { LoginLimiter, loadLimiterConfig, DEFAULT_LIMITER } from "../../src/backend/login-limiter.ts";

const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };
const cfg = { maxAttempts: 3, baseLockMs: 1000, maxLockMs: 8000, resetAfterMs: 60_000 };

test("production defaults", () => {
  assert.deepEqual(loadLimiterConfig({}), DEFAULT_LIMITER);
  assert.deepEqual([DEFAULT_LIMITER.maxAttempts, DEFAULT_LIMITER.baseLockMs, DEFAULT_LIMITER.maxLockMs], [5, 30_000, 900_000]);
});

test("env overrides are parsed defensively", () => {
  assert.equal(loadLimiterConfig({ POS_LOGIN_MAX_ATTEMPTS: "3" }).maxAttempts, 3);
  for (const bad of ["0", "-1", "abc", "1.5", "", "3 "]) assert.equal(loadLimiterConfig({ POS_LOGIN_MAX_ATTEMPTS: bad }).maxAttempts, 5, bad);
  assert.equal(loadLimiterConfig({ POS_LOGIN_LOCK_MS: "2000", POS_LOGIN_MAX_LOCK_MS: "10" }).maxLockMs, 2000, "max lock is never below the base lock");
});

test("not locked until maxAttempts consecutive failures", () => {
  const c = clock(); const l = new LoginLimiter(cfg, c.now);
  l.fail(); l.fail();
  assert.equal(l.check().locked, false);
  l.fail();
  const s = l.check();
  assert.equal(s.locked, true);
  assert.equal(s.retryAfterMs, 1000);
});

test("the lock expires and the next failure doubles it, up to the maximum", () => {
  const c = clock(); const l = new LoginLimiter(cfg, c.now);
  for (let i = 0; i < 3; i++) l.fail();
  c.advance(1001);
  assert.equal(l.check().locked, false, "recovered after the lock period");
  l.fail();
  assert.equal(l.check().retryAfterMs, 2000);
  c.advance(2001); l.fail();
  assert.equal(l.check().retryAfterMs, 4000);
  c.advance(4001); l.fail();
  assert.equal(l.check().retryAfterMs, 8000);
  c.advance(8001); l.fail();
  assert.equal(l.check().retryAfterMs, 8000, "capped at maxLockMs");
});

test("a success resets everything", () => {
  const c = clock(); const l = new LoginLimiter(cfg, c.now);
  l.fail(); l.fail(); l.succeed(); l.fail(); l.fail();
  assert.equal(l.check().locked, false);
  for (let i = 0; i < 3; i++) l.fail();
  c.advance(1001); l.succeed();
  l.fail();
  assert.equal(l.check().locked, false);
});

test("a long quiet period forgets old failures", () => {
  const c = clock(); const l = new LoginLimiter(cfg, c.now);
  l.fail(); l.fail();
  c.advance(60_001);
  l.check();
  l.fail();
  assert.equal(l.check().locked, false, "the earlier two failures no longer count");
});

test("attempts made while locked do not extend the lock (checked by the caller before fail())", () => {
  const c = clock(); const l = new LoginLimiter(cfg, c.now);
  for (let i = 0; i < 3; i++) l.fail();
  const first = l.check().retryAfterMs;
  c.advance(300);
  assert.equal(l.check().retryAfterMs, first - 300);
});
