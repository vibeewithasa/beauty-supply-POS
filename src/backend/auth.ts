import crypto from "crypto";
import path from "path";
import { app, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { users as usersTable } from "./schema";
import { SessionStore } from "./session-store";
import { isTrustedFrame, isTrustedUrl } from "./sender-guard";
import type { GuardOptions } from "./sender-guard";
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

export function hashPin(pin: string) {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

const guardOptions = (): GuardOptions => ({
  packaged: app.isPackaged,
  devOrigin: "http://localhost:5173",
  appIndexPath: path.join(app.getAppPath(), "dist", "renderer", "index.html"),
});
const trustedUrl = (url: string) => isTrustedUrl(url, guardOptions());

function assertTrustedSender(event: IpcMainInvokeEvent) {
  if (!isTrustedFrame(event.senderFrame, event.sender.mainFrame, guardOptions())) {
    throw new Error(FORBIDDEN);
  }
}

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
 * role is taken from the DB, never from the renderer.
 */
export function secureHandle<A extends unknown[], R>(
  channel: string,
  access: Access,
  fn: (ctx: IpcContext, ...args: A) => Promise<R> | R
) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    const user = await currentUser(event);
    if (!user) {
      console.warn(`[auth] no session for ${channel}`);
      throw new Error(NO_SESSION);
    }
    if (access === "admin" && user.role !== "admin") {
      console.warn(`[auth] denied ${channel} (user=${user.id})`);
      throw new Error(FORBIDDEN);
    }
    return fn({ event, user }, ...(args as A));
  });
}

/** Public channels: auth:login, auth:me, auth:logout. */
export function registerAuthHandlers() {
  ipcMain.handle("auth:login", async (event, pin: unknown) => {
    assertTrustedSender(event);
    if (typeof pin !== "string") return null;
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(
        and(eq(usersTable.pinHash, hashPin(pin)), eq(usersTable.active, true))
      );
    if (rows.length !== 1) return null;
    store.start(event.sender, rows[0].id, trustedUrl);
    return rows[0];
  });

  ipcMain.handle("auth:me", async (event) => {
    assertTrustedSender(event);
    return await currentUser(event);
  });

  ipcMain.handle("auth:logout", async (event) => {
    assertTrustedSender(event);
    store.end(event.sender.id);
    return true;
  });
}
