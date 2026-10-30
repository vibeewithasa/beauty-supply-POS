import path from "path";
import { app, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { users as usersTable } from "./schema";
import { SessionStore } from "./session-store";
import { isTrustedFrame, isTrustedUrl } from "./sender-guard";
import { resolveDevOrigin } from "./dev-origin";
import type { GuardOptions } from "./sender-guard";
import { AuthError, BusinessError } from "./errors";
import { describeUnexpected, guarded } from "./ipc-errors";
import { PIN_LOGIN_RE, hashPin, isLegacyHash, verifyPin } from "./pin-hash";
import { LoginLimiter, loadLimiterConfig } from "./login-limiter";
import { Gate, authorizeAdminPin } from "./admin-authorization";
import type { Role } from "../common/types";

export type SessionUser = { id: number; name: string; role: Role };
export type Access = "authenticated" | "admin";
export type IpcContext = { event: IpcMainInvokeEvent; user: SessionUser };

// Two distinct rejections (the renderer relies on the second text to send the user back to the login):
//  - FORBIDDEN: authenticated but not allowed (role, untrusted origin/frame)
//  - NO_SESSION: no session, or it was revoked (logout, deactivated/deleted user)
// Keep "Sesión no válida" in sync with src/preload/preload.ts.
const FORBIDDEN = "No autorizado";
const NO_SESSION = "Sesión no válida";
const store = new SessionStore();

// One limiter for the whole installation (the PIN space is tiny): another window cannot reset it.
// POS_LOGIN_* overrides are honored only in development builds, never in a packaged app.
const limiter = new LoginLimiter(loadLimiterConfig(app.isPackaged ? {} : process.env));
// PIN attempts (login and administrator authorization) are checked one at a time: a burst of parallel requests must not
// all pass the "not locked" check before the first failure has been counted.
const attemptGate = new Gate();

const guardOptions = (): GuardOptions => ({
  packaged: app.isPackaged,
  devOrigin: resolveDevOrigin(process.env, app.isPackaged),
  appIndexPath: path.join(app.getAppPath(), "dist", "renderer", "index.html"),
});
export const trustedUrl = (url: string) => isTrustedUrl(url, guardOptions());

function assertTrustedSender(event: IpcMainInvokeEvent) {
  if (!isTrustedFrame(event.senderFrame, event.sender.mainFrame, guardOptions())) {
    throw new AuthError(FORBIDDEN);
  }
}

// Secrets that must never reach a log line or the renderer.
function secrets(): string[] {
  const url = process.env.DATABASE_URL ?? "";
  let password = "";
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    /* not a URL */
  }
  return [url, password];
}
const logError = (line: string) => console.error(line);

/** Resolves the session of the calling window, re-checking the DB on every call. */
async function currentUser(event: IpcMainInvokeEvent): Promise<SessionUser | null> {
  const userId = store.get(event.sender.id);
  if (userId === undefined) return null;
  const [row] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      role: usersTable.role,
      active: usersTable.active,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!row || !row.active) {
    store.end(event.sender.id); // revoked: deleted or deactivated
    return null;
  }
  return { id: row.id, name: row.name, role: row.role };
}

/**
 * Registers a protected IPC handler. Access is mandatory (deny by default):
 * the caller must be a trusted sender with a live, active session, and the
 * role is taken from the DB, never from the renderer. Unexpected errors never
 * reach the renderer: they are logged (redacted) and replaced by [ERROR_INTERNO].
 */
export function secureHandle<A extends unknown[], R>(
  channel: string,
  access: Access,
  fn: (ctx: IpcContext, ...args: A) => Promise<R> | R
) {
  ipcMain.handle(channel, (event, ...args) =>
    guarded(
      channel,
      async () => {
        assertTrustedSender(event);
        const user = await currentUser(event);
        if (!user) {
          console.warn(`[auth] no session for ${channel}`);
          throw new AuthError(NO_SESSION);
        }
        if (access === "admin" && user.role !== "admin") {
          console.warn(`[auth] denied ${channel} (user=${user.id})`);
          throw new AuthError(FORBIDDEN);
        }
        return fn({ event, user }, ...(args as A));
      },
      logError,
      secrets()
    )
  );
}

/**
 * Transitional upgrade: a legacy SHA-256 hash is replaced by a salted scrypt hash right after a successful login.
 * Compare-and-swap on the old hash, so a concurrent PIN change is never overwritten; a failure never blocks the
 * login (it is logged redacted and retried at the next login).
 */
async function upgradeLegacyHash(userId: number, oldHash: string, pin: string) {
  try {
    const modern = await hashPin(pin);
    await db.update(usersTable).set({ pinHash: modern }).where(and(eq(usersTable.id, userId), eq(usersTable.pinHash, oldHash)));
  } catch (e) {
    logError(describeUnexpected("auth:login (hash upgrade)", e, secrets()));
  }
}

/**
 * Authorizes ONE operation with the PIN of an active administrator (the operator's session is not touched).
 * The PIN is checked here, in main, against the users table; the renderer never names the administrator.
 * Returns only the administrator's id. Shares the installation-wide attempt limiter with the login.
 */
export async function authorizeAdmin(pin: unknown, operatorId: number): Promise<{ adminId: number }> {
  return authorizeAdminPin(
    {
      limiter,
      gate: attemptGate,
      loadActiveUsers: () =>
        db
          .select({ id: usersTable.id, role: usersTable.role, pinHash: usersTable.pinHash })
          .from(usersTable)
          .where(eq(usersTable.active, true)),
      verify: verifyPin,
      onAuthorized: async (admin, p) => {
        if (isLegacyHash(admin.pinHash)) await upgradeLegacyHash(admin.id, admin.pinHash, p);
      },
      onRejected: () => console.warn(`[auth] administrator authorization rejected (operator=${operatorId})`),
    },
    pin
  );
}

/** Public channels: auth:login, auth:me, auth:logout (same error boundary as the protected ones). */
export function registerAuthHandlers() {
  const publicHandle = <R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<R> | R) =>
    ipcMain.handle(channel, (event, ...args) =>
      guarded(channel, () => fn(event, ...args), logError, secrets())
    );

  publicHandle("auth:login", async (event, pin) => {
    assertTrustedSender(event);
    return attemptGate.run(() => attemptLogin(event, pin));
  });

  const attemptLogin = async (event: IpcMainInvokeEvent, pin: unknown) => {
    const state = limiter.check();
    if (state.locked) {
      // generic about users, explicit about the lock; even a correct PIN is refused while locked
      throw new BusinessError("LOGIN_BLOQUEADO", `Demasiados intentos fallidos. Espera ${Math.ceil(state.retryAfterMs / 1000)} s.`);
    }
    if (typeof pin !== "string" || !PIN_LOGIN_RE.test(pin)) {
      limiter.fail();
      return null;
    }
    // The PIN is the only identifier, and salted hashes cannot be looked up: verify against every active user
    // (in parallel on the libuv pool). Exactly one match logs in; none or several (never expected) fail.
    const candidates = await db
      .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, pinHash: usersTable.pinHash })
      .from(usersTable)
      .where(eq(usersTable.active, true));
    const matches = (await Promise.all(candidates.map(async (u) => ((await verifyPin(pin, u.pinHash)) ? u : null)))).filter(
      (u): u is (typeof candidates)[number] => u !== null
    );
    if (matches.length !== 1) {
      limiter.fail(); // unknown PIN, wrong PIN and inactive user are indistinguishable
      return null;
    }
    const user = matches[0];
    limiter.succeed();
    if (isLegacyHash(user.pinHash)) await upgradeLegacyHash(user.id, user.pinHash, pin);
    store.start(event.sender, user.id, trustedUrl);
    return { id: user.id, name: user.name, role: user.role };
  };

  publicHandle("auth:me", async (event) => {
    assertTrustedSender(event);
    return await currentUser(event);
  });

  publicHandle("auth:logout", async (event) => {
    assertTrustedSender(event);
    store.end(event.sender.id);
    return true;
  });
}
