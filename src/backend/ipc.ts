import { ipcMain } from "electron";
import { db, pool } from "./db";
import { products as productsTable, users as usersTable } from "./schema";
import { eq, or } from "drizzle-orm";
import crypto from "crypto";

function hashPin(pin: string) {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

export function registerIpcHandlers() {
  ipcMain.handle("auth:login", async (_e, pin: string) => {
    const pinHash = hashPin(pin);
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(eq(usersTable.pinHash, pinHash));
    if (rows.length === 1) return rows[0];
    return null;
  });

  ipcMain.handle("products:findBySkuOrBarcode", async (_e, q: string) => {
    const rows = await db
      .select()
      .from(productsTable)
      .where(or(eq(productsTable.sku, q), eq(productsTable.barcode, q)))
      .limit(1);
    return rows[0] ?? null;
  });
}
