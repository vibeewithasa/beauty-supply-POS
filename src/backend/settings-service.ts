/** Single-row commercial configuration (business_settings, id = 1) used by receipts. */
import { eq } from "drizzle-orm";
import { db } from "./db";
import { businessSettings as settingsTable } from "./schema";
import { parseBusinessSettings } from "./settings-validation";

export type BusinessSettings = typeof settingsTable.$inferSelect;

/** The row is created by migration 0007; this also repairs a database where it was removed. */
export async function getBusinessSettings(): Promise<BusinessSettings> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  if (row) return row;
  const [created] = await db.insert(settingsTable).values({ id: 1 }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  return again;
}

export async function updateBusinessSettings(userId: number, data: unknown): Promise<BusinessSettings> {
  const input = parseBusinessSettings(data);
  const { logoData, ...rest } = input;
  const values = { ...rest, ...(logoData === undefined ? {} : { logoData }), updatedAt: new Date(), updatedBy: userId };
  const [row] = await db
    .insert(settingsTable)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: settingsTable.id, set: values })
    .returning();
  return row;
}
