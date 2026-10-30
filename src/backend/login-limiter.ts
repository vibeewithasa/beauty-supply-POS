/**
 * Brute-force limiter for PIN attempts (pure: injectable clock and store, unit tested).
 *
 * The PIN space is tiny and the PIN is the only identifier, so ONE counter protects the whole installation. It is held by
 * the main process (every window shares it), serialized by the callers (a burst of parallel guesses cannot beat it) and
 * persisted so that restarting the application does not give the attempts back.
 *
 * Rules:
 *  - After `maxAttempts` consecutive failures the PIN checks are locked; each further failure doubles the lock, up to
 *    `maxLockMs` (a lock is never longer than that, even if the stored state or the clock is tampered with).
 *  - A SUCCESS DOES NOT GIVE ATTEMPTS BACK. Whoever knows one valid PIN (their own, or an administrator's) cannot recover
 *    attempts against the other PINs by signing in between guesses. Failures are forgotten only after a quiet period
 *    (`resetAfterMs` without any failure), so a lock always ends by itself: nothing here is permanent.
 *  - Wrong, unknown, inactive and malformed PINs are all the same failure (the caller decides nothing about users).
 */
export type LimiterConfig = { maxAttempts: number; baseLockMs: number; maxLockMs: number; resetAfterMs: number };
export type LimiterState = { failures: number; lastFailureAt: number; lockedUntil: number };

export const DEFAULT_LIMITER: LimiterConfig = {
  maxAttempts: 5,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
  resetAfterMs: 15 * 60_000,
};

/** Defaults, optionally overridden by POS_LOGIN_* variables (the caller only passes env in development builds). */
export function loadLimiterConfig(env: Record<string, string | undefined> = {}): LimiterConfig {
  const num = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : d);
  const base = num(env.POS_LOGIN_LOCK_MS, DEFAULT_LIMITER.baseLockMs);
  return {
    maxAttempts: num(env.POS_LOGIN_MAX_ATTEMPTS, DEFAULT_LIMITER.maxAttempts),
    baseLockMs: base,
    maxLockMs: Math.max(base, num(env.POS_LOGIN_MAX_LOCK_MS, DEFAULT_LIMITER.maxLockMs)),
    resetAfterMs: num(env.POS_LOGIN_RESET_MS, DEFAULT_LIMITER.resetAfterMs),
  };
}

const MAX_STORED_FAILURES = 1000;

/**
 * Turns whatever was read from disk into a state that can never lock anybody out for longer than the limits allow:
 * unknown shapes are ignored, the lock is clamped to now + maxLockMs and timestamps from the future are not trusted.
 */
export function sanitizeState(raw: unknown, now: number, cfg: LimiterConfig): LimiterState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!ok(o.failures) || !ok(o.lastFailureAt) || !ok(o.lockedUntil)) return null;
  const failures = Math.min(Math.floor(o.failures), MAX_STORED_FAILURES);
  if (failures === 0) return null;
  return {
    failures,
    lastFailureAt: Math.min(o.lastFailureAt, now),
    lockedUntil: Math.min(o.lockedUntil, now + cfg.maxLockMs),
  };
}

export class LoginLimiter {
  private failures = 0;
  private lastFailureAt = 0;
  private lockedUntil = 0;

  private cfg: LimiterConfig;
  private now: () => number;
  private onChange: ((state: LimiterState) => void) | null;

  // (no constructor parameter properties: the unit tests load this file with Node type stripping)
  constructor(cfg: LimiterConfig = DEFAULT_LIMITER, now: () => number = Date.now, onChange: ((state: LimiterState) => void) | null = null) {
    this.cfg = cfg;
    this.now = now;
    this.onChange = onChange;
  }

  /** Restores a persisted state (already sanitized by the caller with sanitizeState). */
  restore(state: LimiterState | null): void {
    if (!state) return;
    this.failures = state.failures;
    this.lastFailureAt = state.lastFailureAt;
    this.lockedUntil = state.lockedUntil;
  }

  snapshot(): LimiterState {
    return { failures: this.failures, lastFailureAt: this.lastFailureAt, lockedUntil: this.lockedUntil };
  }

  /** Is an attempt allowed right now? */
  check(): { locked: boolean; retryAfterMs: number } {
    const t = this.now();
    if (this.failures > 0 && t - this.lastFailureAt > this.cfg.resetAfterMs) this.reset();
    // a lock can never outlast the maximum, whatever the clock did in the meantime
    if (this.lockedUntil - t > this.cfg.maxLockMs) {
      this.lockedUntil = t + this.cfg.maxLockMs;
      this.changed();
    }
    return t < this.lockedUntil ? { locked: true, retryAfterMs: this.lockedUntil - t } : { locked: false, retryAfterMs: 0 };
  }

  fail(): void {
    const t = this.now();
    this.failures = Math.min(this.failures + 1, MAX_STORED_FAILURES);
    this.lastFailureAt = t;
    if (this.failures >= this.cfg.maxAttempts) {
      const factor = 2 ** Math.min(this.failures - this.cfg.maxAttempts, 20);
      this.lockedUntil = t + Math.min(this.cfg.baseLockMs * factor, this.cfg.maxLockMs);
    }
    this.changed();
  }

  /**
   * A correct PIN. It deliberately changes nothing: it must not give attempts back to somebody who is guessing other PINs
   * (see the class comment). The quiet period is what forgets failures.
   */
  succeed(): void {
    /* intentionally empty */
  }

  private reset() {
    this.failures = 0;
    this.lastFailureAt = 0;
    this.lockedUntil = 0;
    this.changed();
  }

  private changed() {
    try {
      this.onChange?.(this.snapshot());
    } catch {
      /* persisting is best effort: it must never break a login */
    }
  }
}
