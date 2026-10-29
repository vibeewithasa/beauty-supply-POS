/**
 * User administration.
 *
 * Every mutation runs in one transaction that first takes a transaction-level advisory lock, so
 * administrative operations are serialized (no race can remove the last active administrator).
 * users:delete is a LOGICAL deactivation: users are referenced by sales, cash, inventory and returns
 * history, so rows are never physically removed. PIN uniqueness is enforced by the database
 * (unique index on pin_hash), not only by a check.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "./db";
import { users as usersTable } from "./schema";
import { BusinessError, pgErrorCode } from "./errors";
import { hashPin, verifyPin } from "./pin-hash";
import { parseUserCreate, parseUserId, parseUserUpdate } from "./users-validation";

// Keep in sync with e2e/suites/hardening.mjs (it holds this lock to force real races).
export const USER_ADMIN_LOCK_KEY = 7_481_201;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inAdminTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${USER_ADMIN_LOCK_KEY})`);
      return fn(tx);
    });
  } catch (e) {
    if (pgErrorCode(e) === "23505") throw new BusinessError("PIN_EN_USO", "Ese PIN no está disponible; elige otro");
    throw e;
  }
}

/**
 * Logical PIN uniqueness. Salted hashes of the same PIN differ, so the unique index on pin_hash can no longer
 * detect duplicates: the candidate PIN is verified against EVERY existing user, active or not (an inactive
 * account's PIN stays reserved, so reactivating it can never create a duplicate). Callers hold the admin
 * advisory lock, which serializes creations and PIN changes.
 */
async function assertPinAvailable(tx: Tx, pin: string, excludingId?: number) {
  const all = await tx.select({ id: usersTable.id, pinHash: usersTable.pinHash }).from(usersTable);
  const clashes = await Promise.all(
    all.filter((u) => u.id !== excludingId).map((u) => verifyPin(pin, u.pinHash))
  );
  if (clashes.some(Boolean)) throw new BusinessError("PIN_EN_USO", "Ese PIN no está disponible; elige otro");
}

async function assertAnotherActiveAdmin(tx: Tx, excludingId: number) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(and(eq(usersTable.role, "admin"), eq(usersTable.active, true), ne(usersTable.id, excludingId)));
  if (!row || row.n < 1) {
    throw new BusinessError("ULTIMO_ADMIN", "No se puede quitar al último administrador activo");
  }
}

const publicUser = { id: usersTable.id, name: usersTable.name, role: usersTable.role };

export async function listActiveUsers() {
  return await db
    .select({ ...publicUser, createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(eq(usersTable.active, true))
    .orderBy(usersTable.name);
}

export async function createUser(data: unknown) {
  const u = parseUserCreate(data);
  return await inAdminTransaction(async (tx) => {
    await assertPinAvailable(tx, u.pin);
    const [user] = await tx.insert(usersTable).values({ name: u.name, role: u.role, pinHash: await hashPin(u.pin) }).returning(publicUser);
    return user;
  });
}

export async function updateUser(idRaw: unknown, data: unknown) {
  const id = parseUserId(idRaw);
  const u = parseUserUpdate(data);
  return await inAdminTransaction(async (tx) => {
    const [target] = await tx.select().from(usersTable).where(eq(usersTable.id, id)).for("update");
    if (!target) throw new BusinessError("USUARIO_NO_ENCONTRADO", "El usuario no existe");
    if (target.role === "admin" && u.role !== "admin" && target.active) await assertAnotherActiveAdmin(tx, id);
    const set: { name: string; role: "admin" | "vendor"; pinHash?: string } = { name: u.name, role: u.role };
    if (u.pin !== null) {
      await assertPinAvailable(tx, u.pin, id);
      set.pinHash = await hashPin(u.pin);
    }
    const [user] = await tx.update(usersTable).set(set).where(eq(usersTable.id, id)).returning(publicUser);
    return user;
  });
}

/** users:delete -> logical deactivation (history is preserved, the account can no longer log in). */
export async function deactivateUser(actorId: number, idRaw: unknown) {
  const id = parseUserId(idRaw);
  if (id === actorId) throw new BusinessError("AUTOELIMINACION", "No puedes eliminar tu propia cuenta");
  return await inAdminTransaction(async (tx) => {
    const [target] = await tx.select().from(usersTable).where(eq(usersTable.id, id)).for("update");
    if (!target) throw new BusinessError("USUARIO_NO_ENCONTRADO", "El usuario no existe");
    if (!target.active) throw new BusinessError("USUARIO_YA_INACTIVO", "El usuario ya está desactivado");
    if (target.role === "admin") await assertAnotherActiveAdmin(tx, id);
    await tx.update(usersTable).set({ active: false }).where(eq(usersTable.id, id));
    return true;
  });
}
