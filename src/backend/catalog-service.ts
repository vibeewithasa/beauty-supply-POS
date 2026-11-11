/**
 * Transactional administrative operations on the catalog: product create/update, inventory movements
 * and price changes. Same rules as pos-service.ts:
 *  - everything validated in the main process (catalog-validation.ts), user taken from the session;
 *  - the product row is locked (`SELECT ... FOR UPDATE`) before any decision, so a concurrent sale,
 *    soft delete, adjustment or price change cannot act on a stale state; each operation locks ONE
 *    product, and sales lock products in ascending id order, so these paths cannot deadlock;
 *  - stock changes only through inventory movements (never through products:update) and every
 *    movement is written together with the stock change in one transaction.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "./db";
import {
  products as productsTable,
  inventoryMovements as inventoryMovementsTable,
  priceChanges as priceChangesTable,
} from "./schema";
import { BusinessError, pgErrorCode } from "./errors";
import { centsFromDb, centsToDb } from "./money";
import { parseId } from "./validation";
import { formatSku } from "./sku";
import { parseInventoryMovement, parsePriceChange, parseProductCreate, parseProductUpdate } from "./catalog-validation";

const duplicateSku = () => new BusinessError("SKU_DUPLICADO", "Ya existe un producto con ese SKU");

// How many sequence values are skipped because an old, manually typed SKU already holds that text (one pass is the norm).
const MAX_SKU_SKIPS = 50;
// A concurrent writer taking the same text between the check and the insert is only possible through direct SQL: retry the whole transaction.
const MAX_SKU_ATTEMPTS = 5;

/**
 * Creates a product with a system-generated SKU. The number is the product's own id, drawn from PostgreSQL's sequence
 * (nextval is atomic across connections: two concurrent creations can never get the same one; MAX(id) + 1 would race).
 * An existing SKU is never reused or changed: if its text is already taken the sequence simply moves on.
 */
export async function createProduct(userId: number, data: unknown) {
  const p = parseProductCreate(data);
  for (let attempt = 1; ; attempt++) {
    try {
      return await insertProduct(userId, p);
    } catch (e) {
      if (pgErrorCode(e) !== "23505") throw e;
      if (attempt >= MAX_SKU_ATTEMPTS) throw new BusinessError("SKU_NO_DISPONIBLE", "No se pudo generar un SKU único; inténtalo de nuevo");
    }
  }
}

async function insertProduct(userId: number, p: ReturnType<typeof parseProductCreate>) {
  return await db.transaction(async (tx) => {
    let id = 0;
    let sku = "";
    for (let skipped = 0; ; skipped++) {
      if (skipped > MAX_SKU_SKIPS) throw new BusinessError("SKU_NO_DISPONIBLE", "No se pudo generar un SKU único; inténtalo de nuevo");
      const { rows } = await tx.execute(sql`select nextval(pg_get_serial_sequence('products', 'id'))::int as id`);
      id = Number((rows[0] as { id: number }).id);
      sku = formatSku(id);
      const [taken] = await tx.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.sku, sku)).limit(1);
      if (!taken) break;
    }
    const [product] = await tx
      .insert(productsTable)
      .values({
        id,
        sku,
        name: p.name,
        price: centsToDb(p.priceCents),
        stock: p.stock,
        barcode: p.barcode,
        category: p.category,
        status: p.status,
      })
      .returning();
    if (p.stock > 0) {
      // initial stock is history too, attributed to the authenticated user
      await tx.insert(inventoryMovementsTable).values({
        productId: product.id,
        userId,
        type: "IN",
        amount: p.stock,
        reason: "Stock inicial",
      });
    }
    return product;
  });
}

export async function updateProduct(idRaw: unknown, data: unknown) {
  const id = parseId(idRaw, "PRODUCTO_INVALIDO", "El producto");
  const changes = parseProductUpdate(data);
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx.select().from(productsTable).where(eq(productsTable.id, id)).for("update");
      if (!current) throw new BusinessError("PRODUCTO_NO_ENCONTRADO", "El producto no existe");
      if (current.status === "deleted") {
        throw new BusinessError("PRODUCTO_ELIMINADO", "El producto está eliminado y no puede modificarse");
      }
      const [row] = await tx
        .update(productsTable)
        .set({ ...changes, updatedAt: new Date() })
        .where(and(eq(productsTable.id, id), ne(productsTable.status, "deleted"))) // belt and braces
        .returning();
      if (!row) throw new BusinessError("PRODUCTO_ELIMINADO", "El producto está eliminado y no puede modificarse");
      return row;
    });
  } catch (e) {
    if (pgErrorCode(e) === "23505") throw duplicateSku();
    throw e;
  }
}

export async function addInventoryMovement(userId: number, data: unknown) {
  const m = parseInventoryMovement(data);
  return await db.transaction(async (tx) => {
    const [product] = await tx.select().from(productsTable).where(eq(productsTable.id, m.productId)).for("update");
    if (!product) throw new BusinessError("PRODUCTO_NO_ENCONTRADO", "El producto no existe");
    if (product.status === "deleted") {
      throw new BusinessError("PRODUCTO_ELIMINADO", "El producto está eliminado; no admite movimientos de inventario");
    }
    if (product.stock + m.amount < 0) {
      throw new BusinessError("STOCK_INSUFICIENTE", `Stock insuficiente: hay ${product.stock} y el movimiento es ${m.amount}`);
    }
    const updated = await tx
      .update(productsTable)
      .set({ stock: sql`${productsTable.stock} + ${m.amount}`, updatedAt: new Date() })
      .where(sql`${productsTable.id} = ${m.productId} and ${productsTable.stock} + ${m.amount} >= 0`)
      .returning({ id: productsTable.id });
    if (updated.length !== 1) throw new BusinessError("STOCK_INSUFICIENTE", "Stock insuficiente para el movimiento");
    await tx.insert(inventoryMovementsTable).values({
      productId: m.productId,
      userId,
      type: m.type,
      amount: m.amount,
      reason: m.reason,
    });
    return true;
  });
}

export async function createPriceChange(userId: number, data: unknown) {
  const c = parsePriceChange(data);
  return await db.transaction(async (tx) => {
    const [product] = await tx.select().from(productsTable).where(eq(productsTable.id, c.productId)).for("update");
    if (!product) throw new BusinessError("PRODUCTO_NO_ENCONTRADO", "El producto no existe");
    if (product.status === "deleted") {
      throw new BusinessError("PRODUCTO_ELIMINADO", "El producto está eliminado; no admite cambios de precio");
    }
    // The old price is whatever PostgreSQL holds right now, never what the client says.
    const currentCents = centsFromDb(product.price);
    if (c.claimedOldPriceCents !== null && c.claimedOldPriceCents !== currentCents) {
      throw new BusinessError("PRECIO_DESACTUALIZADO", `El precio actual es $${centsToDb(currentCents)}; actualiza antes de cambiarlo`);
    }
    if (c.newPriceCents === currentCents) {
      throw new BusinessError("SIN_CAMBIO", "El precio nuevo es igual al actual");
    }
    await tx.insert(priceChangesTable).values({
      productId: c.productId,
      oldPrice: centsToDb(currentCents),
      newPrice: centsToDb(c.newPriceCents),
      reason: c.reason,
      changedBy: userId,
    });
    const updated = await tx
      .update(productsTable)
      .set({ price: centsToDb(c.newPriceCents), updatedAt: new Date() })
      .where(and(eq(productsTable.id, c.productId), ne(productsTable.status, "deleted")))
      .returning({ id: productsTable.id });
    if (updated.length !== 1) throw new BusinessError("PRODUCTO_ELIMINADO", "El producto está eliminado; no admite cambios de precio");
    return true;
  });
}
