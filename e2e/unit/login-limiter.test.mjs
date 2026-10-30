import test from "node:test";
import assert from "node:assert/strict";
import { LoginLimiter, loadLimiterConfig, sanitizeState, DEFAULT_LIMITER } from "../../src/backend/login-limiter.ts";

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

test("a success gives NOTHING back: signing in between guesses recovers no attempts", () => {
  const c = clock(); const l = new LoginLimiter(cfg, c.now);
  l.fail(); l.fail(); l.succeed(); // two wrong guesses, then a login with the guesser's own valid PIN
  assert.equal(l.check().locked, false);
  l.fail();
  assert.equal(l.check().locked, true, "the third failure locks although a success happened in between");
  // the "alternate guesses and own logins" attack never gets more than maxAttempts guesses per quiet period
  const a = new LoginLimiter(cfg, c.now);
  let guesses = 0;
  for (let round = 0; round < 50; round++) {
    if (a.check().locked) break;
    a.fail(); guesses++;
    a.succeed();
  }
  assert.equal(guesses, cfg.maxAttempts, "exactly the allowed number of guesses, not one per login");
});

test("a lock ends by itself and the failures that remain are forgotten after a quiet period", () => {
  const c = clock(); const l = new LoginLimiter(cfg, c.now);
  for (let i = 0; i < 3; i++) l.fail();
  c.advance(1001);
  assert.equal(l.check().locked, false, "the lock expired on its own");
  l.succeed();
  l.fail();
  assert.equal(l.check().locked, true, "but the failures were not forgotten yet: the next one locks again, for longer");
  assert.equal(l.check().retryAfterMs, 2000);
  c.advance(60_001 + 2000);
  assert.equal(l.check().locked, false);
  l.fail(); l.fail();
  assert.equal(l.check().locked, false, "after a quiet period the counter starts from zero");
});

test("the quiet period can be configured for development builds only through POS_LOGIN_RESET_MS", () => {
  assert.equal(loadLimiterConfig({}).resetAfterMs, DEFAULT_LIMITER.resetAfterMs);
  assert.equal(loadLimiterConfig({ POS_LOGIN_RESET_MS: "2500" }).resetAfterMs, 2500);
  for (const bad of ["0", "-5", "abc", "1.5", ""]) assert.equal(loadLimiterConfig({ POS_LOGIN_RESET_MS: bad }).resetAfterMs, DEFAULT_LIMITER.resetAfterMs, bad);
});

test("state changes are reported for persistence and a failing store never breaks the limiter", () => {
  const c = clock(); const seen = [];
  const l = new LoginLimiter(cfg, c.now, (s) => seen.push(s));
  l.fail(); l.fail();
  assert.deepEqual(seen.map((s) => s.failures), [1, 2]);
  const broken = new LoginLimiter(cfg, c.now, () => { throw new Error("disk full"); });
  broken.fail(); broken.fail(); broken.fail();
  assert.equal(broken.check().locked, true, "still counts and locks");
});

test("restoring a state (an application restart) keeps the lock and the failures", () => {
  const c = clock(); const a = new LoginLimiter(cfg, c.now);
  for (let i = 0; i < 3; i++) a.fail();
  const saved = JSON.parse(JSON.stringify(a.snapshot()));
  c.advance(300);
  const b = new LoginLimiter(cfg, c.now);
  b.restore(sanitizeState(saved, c.now(), cfg));
  assert.equal(b.check().locked, true, "restarting does not unlock");
  assert.equal(b.check().retryAfterMs, 700);
  c.advance(701);
  assert.equal(b.check().locked, false, "and the lock still ends by itself");
});

test("a tampered or clock-skewed stored state can never lock for longer than the maximum", () => {
  const c = clock();
  const far = sanitizeState({ failures: 9, lastFailureAt: c.now() + 10 ** 12, lockedUntil: c.now() + 10 ** 12 }, c.now(), cfg);
  assert.ok(far.lockedUntil <= c.now() + cfg.maxLockMs && far.lastFailureAt <= c.now());
  const l = new LoginLimiter(cfg, c.now);
  l.restore(far);
  assert.ok(l.check().retryAfterMs <= cfg.maxLockMs);
  // the clock moving backwards while locked does not stretch the lock either
  const m = new LoginLimiter(cfg, c.now);
  for (let i = 0; i < 6; i++) m.fail();
  c.advance(-3_600_000);
  assert.ok(m.check().retryAfterMs <= cfg.maxLockMs, "clamped to the maximum");
  for (const junk of [null, undefined, 5, "x", [], {}, { failures: -1, lastFailureAt: 0, lockedUntil: 0 }, { failures: "3", lastFailureAt: 1, lockedUntil: 1 }, { failures: NaN, lastFailureAt: 1, lockedUntil: 1 }, { failures: 0, lastFailureAt: 0, lockedUntil: 0 }]) {
    assert.equal(sanitizeState(junk, c.now(), cfg), null, JSON.stringify(junk));
  }
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
