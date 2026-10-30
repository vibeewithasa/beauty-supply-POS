/**
 * Brute-force limiter for the PIN login (pure, injectable clock, unit tested).
 *
 * The PIN space is tiny, so the counter is GLOBAL to the installation (held by the main process): it
 * cannot be reset by opening another window and it does not depend on which user is being guessed.
 * After `maxAttempts` consecutive failures the login is locked; each further failure doubles the lock
 * (up to `maxLockMs`). A success resets everything; so does a long quiet period.
 */
export type LimiterConfig = { maxAttempts: number; baseLockMs: number; maxLockMs: number; resetAfterMs: number };

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
    resetAfterMs: DEFAULT_LIMITER.resetAfterMs,
  };
}

export class LoginLimiter {
  private failures = 0;
  private lastFailureAt = 0;
  private lockedUntil = 0;

  private cfg: LimiterConfig;
  private now: () => number;

  // (no constructor parameter properties: the unit tests load this file with Node type stripping)
  constructor(cfg: LimiterConfig = DEFAULT_LIMITER, now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
  }

  /** Is a login attempt allowed right now? */
  check(): { locked: boolean; retryAfterMs: number } {
    const t = this.now();
    if (this.failures > 0 && t - this.lastFailureAt > this.cfg.resetAfterMs) this.reset();
    return t < this.lockedUntil ? { locked: true, retryAfterMs: this.lockedUntil - t } : { locked: false, retryAfterMs: 0 };
  }

  fail(): void {
    const t = this.now();
    this.failures += 1;
    this.lastFailureAt = t;
    if (this.failures >= this.cfg.maxAttempts) {
      const factor = 2 ** Math.min(this.failures - this.cfg.maxAttempts, 20);
      this.lockedUntil = t + Math.min(this.cfg.baseLockMs * factor, this.cfg.maxLockMs);
    }
  }

  succeed(): void {
    this.reset();
  }

  private reset() {
    this.failures = 0;
    this.lastFailureAt = 0;
    this.lockedUntil = 0;
  }
}
