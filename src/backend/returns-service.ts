/**
 * Transactional returns.
 *
 * Locking order (deterministic, shared with the other flows): sale row -> its sale_items rows (ascending id)
 * -> product rows (ascending id). Every return of a sale takes the sale row first, so concurrent returns of
 * the same sale are serialized and the "already returned" total is computed under that lock (no over-return
 * under concurrency). Sales lock cash session -> products ascending and never touch these rows, so the
 * flows cannot deadlock.
 *
 * Financial policy (provisional): a registered return is NOT a paid refund. The return is stored with
 * refund_status = 'pending'; the cash session and cash movements are NOT touched. Nothing here marks a
 * refund as paid.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import {
  sales as salesTable,
  saleItems as saleItemsTable,
  products as productsTable,
  returns as returnsTable,
  returnItems as returnItemsTable,
  inventoryMovements as inventoryMovementsTable,
} from "./schema";
import { BusinessError } from "./errors";
import { centsFromDb, centsToDb } from "./money";
import { parseReturnInput } from "./returns-validation";

export async function createReturn(userId: number, data: unknown) {
  const input = parseReturnInput(data);

  return await db.transaction(async (tx) => {
    const [sale] = await tx.select().from(salesTable).where(eq(salesTable.id, input.saleId)).for("update");
    if (!sale) throw new BusinessError("VENTA_NO_ENCONTRADA", "La venta no existe");

    const requested = [...input.items].sort((a, b) => a.saleItemId - b.saleItemId);
    const lineRows = await tx
      .select()
      .from(saleItemsTable)
      .where(inArray(saleItemsTable.id, requested.map((r) => r.saleItemId)))
      .orderBy(saleItemsTable.id)
      .for("update");
    const lines = new Map(lineRows.map((l) => [l.id, l]));

    for (const r of requested) {
      const line = lines.get(r.saleItemId);
      if (!line) throw new BusinessError("ITEM_NO_ENCONTRADO", `La línea de venta ${r.saleItemId} no existe`);
      if (line.saleId !== input.saleId) {
        throw new BusinessError("ITEM_AJENO_A_VENTA", `La línea ${r.saleItemId} no pertenece a la venta ${input.saleId}`);
      }
    }

    // everything already returned for these lines (computed while holding the sale lock)
    const returnedRows = await tx
      .select({ saleItemId: returnItemsTable.saleItemId, qty: sql<number>`sum(${returnItemsTable.quantity})::int` })
      .from(returnItemsTable)
      .where(inArray(returnItemsTable.saleItemId, requested.map((r) => r.saleItemId)))
      .groupBy(returnItemsTable.saleItemId);
    const alreadyReturned = new Map(returnedRows.map((r) => [r.saleItemId, r.qty]));

    const productIds = [...new Set(requested.map((r) => lines.get(r.saleItemId)!.productId))].sort((a, b) => a - b);
    const productRows = await tx
      .select()
      .from(productsTable)
      .where(inArray(productsTable.id, productIds))
      .orderBy(productsTable.id)
      .for("update");
    const products = new Map(productRows.map((p) => [p.id, p]));

    // validate everything BEFORE writing anything; amounts come from sale_items, never from the client
    let totalCents = 0;
    const priced = requested.map((r) => {
      const line = lines.get(r.saleItemId)!;
      const unitCents = centsFromDb(line.unitPrice);
      if (r.claimedProductId !== null && r.claimedProductId !== line.productId) {
        throw new BusinessError("PRODUCTO_NO_COINCIDE", `La línea ${line.id} corresponde a otro producto`);
      }
      if (r.claimedUnitPriceCents !== null && r.claimedUnitPriceCents !== unitCents) {
        throw new BusinessError("PRECIO_NO_COINCIDE", `El precio de la línea ${line.id} es $${centsToDb(unitCents)}`);
      }
      const remaining = line.quantity - (alreadyReturned.get(line.id) ?? 0);
      if (r.quantity > remaining) {
        throw new BusinessError("DEVOLUCION_EXCEDE", `Solo quedan ${remaining} unidad(es) por devolver de la línea ${line.id}`);
      }
      const product = products.get(line.productId);
      if (!product) throw new BusinessError("PRODUCTO_NO_ENCONTRADO", "El producto de la línea ya no existe");
      if (product.status === "deleted") {
        // no recovery policy exists for deleted products: stock is not put back into them
        throw new BusinessError("PRODUCTO_ELIMINADO", `"${product.name}" está eliminado; no se puede reingresar su stock`);
      }
      const refund = unitCents * r.quantity;
      totalCents += refund;
      return { r, line, refund };
    });

    const [ret] = await tx
      .insert(returnsTable)
      .values({
        saleId: input.saleId,
        reason: input.reason,
        processedBy: userId,
        totalRefund: centsToDb(totalCents),
        refundStatus: "pending", // owed, NOT paid; cash is untouched
      })
      .returning();

    for (const { r, line, refund } of priced) {
      await tx.insert(returnItemsTable).values({
        returnId: ret.id,
        saleItemId: line.id,
        productId: line.productId,
        quantity: r.quantity,
        refundAmount: centsToDb(refund),
      });
      await tx
        .update(productsTable)
        .set({ stock: sql`${productsTable.stock} + ${r.quantity}`, updatedAt: new Date() })
        .where(eq(productsTable.id, line.productId));
      await tx.insert(inventoryMovementsTable).values({
        productId: line.productId,
        type: "IN",
        amount: r.quantity,
        reason: `Devolución #${ret.id} de Venta #${input.saleId}`,
        userId,
      });
    }
    return ret;
  });
}
