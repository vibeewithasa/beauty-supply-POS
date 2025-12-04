import { ipcMain } from "electron";
import { db, pool } from "./db";
import {
  products as productsTable,
  users as usersTable,
  sales as salesTable,
  saleItems as saleItemsTable,
  cashSessions as cashSessionsTable,
  cashMovements as cashMovementsTable,
  inventoryMovements as inventoryMovementsTable,
  returns as returnsTable,
  returnItems as returnItemsTable,
  deletedProductsLog as deletedProductsLogTable,
  priceChanges as priceChangesTable,
} from "./schema";
import { eq, or, and, desc, sql, gte, lte, isNull } from "drizzle-orm";
import crypto from "crypto";

function hashPin(pin: string) {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

export function registerIpcHandlers() {
  // ============= AUTH =============
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

  // ============= PRODUCTS =============
  ipcMain.handle("products:getAll", async () => {
    return await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.status, "active"))
      .orderBy(productsTable.name);
  });

  ipcMain.handle("products:findBySkuOrBarcode", async (_e, q: string) => {
    const rows = await db
      .select()
      .from(productsTable)
      .where(
        and(
          or(eq(productsTable.sku, q), eq(productsTable.barcode, q)),
          eq(productsTable.status, "active")
        )
      )
      .limit(1);
    return rows[0] ?? null;
  });

  ipcMain.handle("products:create", async (_e, data: any) => {
    const processedData = {
      ...data,
      price:
        typeof data.price === "string" ? data.price : data.price?.toString(),
    };
    const [product] = await db
      .insert(productsTable)
      .values(processedData)
      .returning();
    return product;
  });

  ipcMain.handle("products:update", async (_e, id: number, data: any) => {
    const processedData = {
      ...data,
      ...(data.price && {
        price:
          typeof data.price === "string" ? data.price : data.price.toString(),
      }),
    };
    const [product] = await db
      .update(productsTable)
      .set({ ...processedData, updatedAt: new Date() })
      .where(eq(productsTable.id, id))
      .returning();
    return product;
  });

  ipcMain.handle(
    "products:softDelete",
    async (_e, id: number, reason: string, userId: number) => {
      const [product] = await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, id));

      if (!product) return null;

      await db.transaction(async (tx) => {
        // Mark as deleted
        await tx
          .update(productsTable)
          .set({ status: "deleted" as any, updatedAt: new Date() })
          .where(eq(productsTable.id, id));

        // Log deletion
        await tx.insert(deletedProductsLogTable).values({
          productId: id,
          sku: product.sku,
          name: product.name,
          reason,
          deletedBy: userId,
        });

        // Record inventory movement
        if (product.stock > 0) {
          await tx.insert(inventoryMovementsTable).values({
            productId: id,
            type: "DELETE" as any,
            amount: -product.stock,
            reason: `Producto eliminado: ${reason}`,
            userId,
          });
        }
      });

      return true;
    }
  );

  // ============= CASH SESSIONS =============
  ipcMain.handle("cash:getActiveSession", async () => {
    const [session] = await db
      .select()
      .from(cashSessionsTable)
      .where(isNull(cashSessionsTable.closedAt))
      .orderBy(desc(cashSessionsTable.openedAt))
      .limit(1);
    return session ?? null;
  });

  ipcMain.handle(
    "cash:openSession",
    async (_e, initialAmount: number, userId: number) => {
      const [session] = await db
        .insert(cashSessionsTable)
        .values({
          openedBy: userId,
          initialAmount: initialAmount.toString(),
          currentAmount: initialAmount.toString(),
        })
        .returning();
      return session;
    }
  );

  ipcMain.handle(
    "cash:closeSession",
    async (_e, sessionId: number, realTotal: number, userId: number) => {
      const [session] = await db
        .update(cashSessionsTable)
        .set({
          closedAt: new Date(),
          closedBy: userId,
          finalAmount: realTotal.toString(),
        })
        .where(eq(cashSessionsTable.id, sessionId))
        .returning();
      return session;
    }
  );

  ipcMain.handle("cash:addMovement", async (_e, data: any) => {
    const { sessionId, type, amount, reason, userId } = data;

    const [movement] = await db
      .insert(cashMovementsTable)
      .values({ sessionId, type, amount: amount.toString(), reason, userId })
      .returning();

    // Update session current amount
    if (type === "IN") {
      await db
        .update(cashSessionsTable)
        .set({
          currentAmount: sql`${cashSessionsTable.currentAmount} + ${amount}`,
        })
        .where(eq(cashSessionsTable.id, sessionId));
    } else {
      await db
        .update(cashSessionsTable)
        .set({
          currentAmount: sql`${cashSessionsTable.currentAmount} - ${amount}`,
        })
        .where(eq(cashSessionsTable.id, sessionId));
    }

    return movement;
  });

  ipcMain.handle("cash:getMovements", async (_e, sessionId: number) => {
    return await db
      .select()
      .from(cashMovementsTable)
      .where(eq(cashMovementsTable.sessionId, sessionId))
      .orderBy(desc(cashMovementsTable.createdAt));
  });

  // ============= SALES =============
  ipcMain.handle("sales:create", async (_e, data: any) => {
    const { items, subtotal, tax, total, paymentMethod, userId, sessionId } =
      data;

    const result = await db.transaction(async (tx) => {
      // Create sale
      const [sale] = await tx
        .insert(salesTable)
        .values({
          userId,
          cashSessionId: sessionId,
          subtotal: subtotal.toString(),
          tax: tax.toString(),
          total: total.toString(),
          paymentMethod,
        })
        .returning();

      // Create sale items and update stock
      for (const item of items) {
        await tx.insert(saleItemsTable).values({
          saleId: sale.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          subtotal: item.subtotal.toString(),
        });

        // Decrease stock
        await tx
          .update(productsTable)
          .set({ stock: sql`${productsTable.stock} - ${item.quantity}` })
          .where(eq(productsTable.id, item.productId));

        // Record inventory movement
        await tx.insert(inventoryMovementsTable).values({
          productId: item.productId,
          type: "OUT" as any,
          amount: -item.quantity,
          reason: `Venta #${sale.id}`,
          userId,
        });
      }

      // Update cash session if payment is cash
      if (paymentMethod === "cash" && sessionId) {
        await tx
          .update(cashSessionsTable)
          .set({
            currentAmount: sql`${cashSessionsTable.currentAmount} + ${total}`,
          })
          .where(eq(cashSessionsTable.id, sessionId));
      }

      return sale;
    });

    return result;
  });

  ipcMain.handle("sales:getAll", async () => {
    return await db
      .select()
      .from(salesTable)
      .orderBy(desc(salesTable.createdAt))
      .limit(100);
  });

  ipcMain.handle("sales:getById", async (_e, id: number) => {
    const [sale] = await db
      .select()
      .from(salesTable)
      .where(eq(salesTable.id, id));

    if (!sale) return null;

    const items = await db
      .select({
        id: saleItemsTable.id,
        productId: saleItemsTable.productId,
        quantity: saleItemsTable.quantity,
        unitPrice: saleItemsTable.unitPrice,
        subtotal: saleItemsTable.subtotal,
        productName: productsTable.name,
        productSku: productsTable.sku,
      })
      .from(saleItemsTable)
      .leftJoin(productsTable, eq(saleItemsTable.productId, productsTable.id))
      .where(eq(saleItemsTable.saleId, id));

    return { ...sale, items };
  });

  // ============= RETURNS =============
  ipcMain.handle("returns:create", async (_e, data: any) => {
    const { saleId, items, reason, userId } = data;

    const result = await db.transaction(async (tx) => {
      const [returnRecord] = await tx
        .insert(returnsTable)
        .values({
          saleId,
          reason,
          processedBy: userId,
        })
        .returning();

      let totalRefund = 0;

      for (const item of items) {
        const itemPrice =
          typeof item.unitPrice === "string"
            ? parseFloat(item.unitPrice)
            : item.unitPrice;
        const refundAmount = item.quantity * itemPrice;
        totalRefund += refundAmount;

        await tx.insert(returnItemsTable).values({
          returnId: returnRecord.id,
          saleItemId: item.saleItemId,
          productId: item.productId,
          quantity: item.quantity,
          refundAmount: refundAmount.toString(),
        });

        // Increase stock
        await tx
          .update(productsTable)
          .set({ stock: sql`${productsTable.stock} + ${item.quantity}` })
          .where(eq(productsTable.id, item.productId));

        // Record inventory movement
        await tx.insert(inventoryMovementsTable).values({
          productId: item.productId,
          type: "IN" as any,
          amount: item.quantity,
          reason: `Devolución #${returnRecord.id} de Venta #${saleId}`,
          userId,
        });
      }

      // Update return with total refund
      await tx
        .update(returnsTable)
        .set({ totalRefund: totalRefund.toString() })
        .where(eq(returnsTable.id, returnRecord.id));

      return { ...returnRecord, totalRefund };
    });

    return result;
  });

  ipcMain.handle("returns:getAll", async () => {
    return await db
      .select()
      .from(returnsTable)
      .orderBy(desc(returnsTable.createdAt))
      .limit(100);
  });

  // ============= USERS =============
  ipcMain.handle("users:getAll", async () => {
    return await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        role: usersTable.role,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .orderBy(usersTable.name);
  });

  ipcMain.handle("users:create", async (_e, data: any) => {
    const { name, role, pin } = data;
    const pinHash = hashPin(pin);
    const [user] = await db
      .insert(usersTable)
      .values({ name, role, pinHash })
      .returning({
        id: usersTable.id,
        name: usersTable.name,
        role: usersTable.role,
      });
    return user;
  });

  ipcMain.handle("users:update", async (_e, id: number, data: any) => {
    const updateData: any = { name: data.name, role: data.role };
    if (data.pin) {
      updateData.pinHash = hashPin(data.pin);
    }
    const [user] = await db
      .update(usersTable)
      .set(updateData)
      .where(eq(usersTable.id, id))
      .returning({
        id: usersTable.id,
        name: usersTable.name,
        role: usersTable.role,
      });
    return user;
  });

  ipcMain.handle("users:delete", async (_e, id: number) => {
    await db.delete(usersTable).where(eq(usersTable.id, id));
    return true;
  });

  // ============= INVENTORY =============
  ipcMain.handle("inventory:getMovements", async (_e, productId?: number) => {
    const query = db
      .select({
        id: inventoryMovementsTable.id,
        productId: inventoryMovementsTable.productId,
        type: inventoryMovementsTable.type,
        amount: inventoryMovementsTable.amount,
        reason: inventoryMovementsTable.reason,
        createdAt: inventoryMovementsTable.createdAt,
        userName: usersTable.name,
        productName: productsTable.name,
        productSku: productsTable.sku,
      })
      .from(inventoryMovementsTable)
      .leftJoin(usersTable, eq(inventoryMovementsTable.userId, usersTable.id))
      .leftJoin(
        productsTable,
        eq(inventoryMovementsTable.productId, productsTable.id)
      )
      .orderBy(desc(inventoryMovementsTable.createdAt))
      .limit(100);

    if (productId) {
      return await query.where(
        eq(inventoryMovementsTable.productId, productId)
      );
    }

    return await query;
  });

  ipcMain.handle("inventory:addMovement", async (_e, data: any) => {
    const { productId, type, amount, reason, userId } = data;

    await db.transaction(async (tx) => {
      await tx.insert(inventoryMovementsTable).values({
        productId,
        type,
        amount,
        reason,
        userId,
      });

      // Update stock
      await tx
        .update(productsTable)
        .set({ stock: sql`${productsTable.stock} + ${amount}` })
        .where(eq(productsTable.id, productId));
    });

    return true;
  });

  // ============= PRICE CHANGES =============
  ipcMain.handle("priceChanges:create", async (_e, data: any) => {
    const { productId, oldPrice, newPrice, reason, userId } = data;

    await db.transaction(async (tx) => {
      await tx.insert(priceChangesTable).values({
        productId,
        oldPrice: oldPrice.toString(),
        newPrice: newPrice.toString(),
        reason,
        changedBy: userId,
      });

      await tx
        .update(productsTable)
        .set({ price: newPrice.toString(), updatedAt: new Date() })
        .where(eq(productsTable.id, productId));
    });

    return true;
  });

  ipcMain.handle("priceChanges:getAll", async () => {
    return await db
      .select({
        id: priceChangesTable.id,
        productId: priceChangesTable.productId,
        oldPrice: priceChangesTable.oldPrice,
        newPrice: priceChangesTable.newPrice,
        reason: priceChangesTable.reason,
        createdAt: priceChangesTable.createdAt,
        userName: usersTable.name,
        productName: productsTable.name,
        productSku: productsTable.sku,
      })
      .from(priceChangesTable)
      .leftJoin(usersTable, eq(priceChangesTable.changedBy, usersTable.id))
      .leftJoin(
        productsTable,
        eq(priceChangesTable.productId, productsTable.id)
      )
      .orderBy(desc(priceChangesTable.createdAt))
      .limit(100);
  });

  // ============= REPORTS =============
  ipcMain.handle(
    "reports:getSalesByDateRange",
    async (_e, startDate: string, endDate: string) => {
      return await db
        .select()
        .from(salesTable)
        .where(
          and(
            gte(salesTable.createdAt, new Date(startDate)),
            lte(salesTable.createdAt, new Date(endDate))
          )
        )
        .orderBy(desc(salesTable.createdAt));
    }
  );

  ipcMain.handle("reports:getDeletedProducts", async () => {
    return await db
      .select({
        id: deletedProductsLogTable.id,
        productId: deletedProductsLogTable.productId,
        sku: deletedProductsLogTable.sku,
        name: deletedProductsLogTable.name,
        reason: deletedProductsLogTable.reason,
        deletedAt: deletedProductsLogTable.deletedAt,
        deletedByName: usersTable.name,
      })
      .from(deletedProductsLogTable)
      .leftJoin(
        usersTable,
        eq(deletedProductsLogTable.deletedBy, usersTable.id)
      )
      .orderBy(desc(deletedProductsLogTable.deletedAt));
  });
}
