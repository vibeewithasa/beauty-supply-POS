/**
 * One-off authorization of a sensitive operation (refund payment) with the PIN of an active administrator.
 *
 * Pure (no Electron, no DB): everything that touches the outside world is injected, so it is unit tested.
 *
 * Design:
 *  - The PIN travels WITH the operation it authorizes, in the same IPC call, and is checked here in the main process.
 *    There is no token, no cache and no session change: nothing reusable exists after the call returns, so there is
 *    nothing to expire, steal or replay. The operator's own session is never touched (auth:login is not involved).
 *  - The administrator is never named by the renderer: the PIN is verified against every active user (same cost and
 *    shape as the login) and exactly one match, who must be an administrator, authorizes. A wrong PIN, a seller's PIN, a
 *    deactivated administrator's PIN and an unknown PIN produce the very same error (no enumeration).
 *  - Attempts go through the installation-wide limiter (shared with the login: a bounded guessing budget for the whole
 *    PIN space, not one per window) and through a gate that serializes check -> verify -> record. Without the gate, a burst
 *    of parallel requests would all pass the "not locked" check before the first failure was counted.
 *  - The PIN is never stored, logged or returned. Only the administrator id is handed back.
 */
import { BusinessError } from "./errors.ts";

export const ADMIN_PIN_RE = /^\d{4,8}$/;

export interface AttemptLimiter {
  check(): { locked: boolean; retryAfterMs: number };
  fail(): void;
  succeed(): void;
}
export type PinUser = { id: number; role: "admin" | "vendor"; pinHash: string };

export interface AdminAuthorizationDeps {
  limiter: AttemptLimiter;
  gate: Gate;
  /** Active users only (an inactive administrator can never authorize). */
  loadActiveUsers: () => Promise<PinUser[]>;
  verify: (pin: string, stored: string) => Promise<boolean>;
  /** Called after a successful authorization (e.g. to upgrade a legacy hash); failures here never reject the PIN. */
  onAuthorized?: (admin: PinUser, pin: string) => Promise<void>;
  /** Called with the operator id when a PIN is rejected (the PIN itself is never passed). */
  onRejected?: () => void;
}

/** Runs tasks one at a time, in arrival order. */
export class Gate {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const INVALID = () => new BusinessError("AUTORIZACION_INVALIDA", "PIN de administrador inválido");

export async function authorizeAdminPin(deps: AdminAuthorizationDeps, pin: unknown): Promise<{ adminId: number }> {
  return deps.gate.run(async () => {
    const state = deps.limiter.check();
    if (state.locked) {
      // explicit about the lock, silent about users; even a correct PIN is refused while locked
      throw new BusinessError("AUTORIZACION_BLOQUEADA", `Demasiados intentos fallidos. Espera ${Math.ceil(state.retryAfterMs / 1000)} s.`);
    }
    const reject = (): never => {
      deps.limiter.fail();
      deps.onRejected?.();
      throw INVALID();
    };
    if (typeof pin !== "string" || !ADMIN_PIN_RE.test(pin)) return reject();

    const users = await deps.loadActiveUsers();
    const matches = (await Promise.all(users.map(async (u) => ((await deps.verify(pin, u.pinHash)) ? u : null)))).filter(
      (u): u is PinUser => u !== null
    );
    // none, several (never expected) or a match that is not an administrator: indistinguishable from a wrong PIN
    if (matches.length !== 1 || matches[0].role !== "admin") return reject();

    deps.limiter.succeed();
    const admin = matches[0];
    try {
      await deps.onAuthorized?.(admin, pin);
    } catch {
      /* a failed hash upgrade must not undo a valid authorization */
    }
    return { adminId: admin.id };
  });
}
