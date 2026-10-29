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
import { hashPin, registerAuthHandlers, secureHandle } from "./auth";
import type { Access, IpcContext } from "./auth";

// Access policy for every protected channel. A channel without an entry cannot
// be registered (deny by default). Public channels (auth:*) live in auth.ts.
const ACCESS: Record<string, Access> = {
  "products:getAll": "authenticated",
  "products:findBySkuOrBarcode": "authenticated",
  "products:create": "admin",
  "products:update": "admin",
  "products:softDelete": "admin",
  "cash:getActiveSession": "authenticated",
  "cash:openSession": "authenticated",
  "cash:closeSession": "authenticated",
  "cash:addMovement": "authenticated",
  "cash:getMovements": "authenticated",
  "sales:create": "authenticated",
  // PRODUCT DECISION PENDING: should vendors read the full sales history and process returns?
  // (sales:getAll, sales:getById, returns:create, returns:getAll are open to any authenticated user for now.)
  "sales:getAll": "authenticated",
  "sales:getById": "authenticated",
  "returns:create": "authenticated",
  "returns:getAll": "authenticated",
  "users:getAll": "admin",
  "users:create": "admin",
  "users:update": "admin",
  "users:delete": "admin",
  "inventory:getMovements": "admin",
  "inventory:addMovement": "admin",
  "priceChanges:create": "admin",
  "priceChanges:getAll": "admin",
  "reports:getSalesByDateRange": "admin",
  "reports:getDeletedProducts": "admin",
  "dashboard:getStats": "admin",
};

function handle<A extends unknown[], R>(
  channel: string,
  fn: (ctx: IpcContext, ...args: A) => Promise<R> | R
) {
  const access = ACCESS[channel];
  if (!access) throw new Error("Sin política de acceso para " + channel);
  secureHandle(channel, access, fn);
}

function assertRole(role: unknown): asserts role is "admin" | "vendor" {
  if (role !== "admin" && role !== "vendor") throw new Error("Rol inválido");
}

export function registerIpcHandlers() {
  registerAuthHandlers();

  // ============= PRODUCTS =============
  handle("products:getAll", async () => {
    return await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.status, "active"))
      .orderBy(productsTable.name);
  });

  handle("products:findBySkuOrBarcode", async (ctx, q: string) => {
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

  handle("products:create", async (ctx, data: any) => {
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

  handle("products:update", async (ctx, id: number, data: any) => {
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

  handle(
    "products:softDelete",
    async (ctx, id: number, reason: string) => {
      const userId = ctx.user.id;
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
  handle("cash:getActiveSession", async () => {
    const [session] = await db
      .select()
      .from(cashSessionsTable)
      .where(isNull(cashSessionsTable.closedAt))
      .orderBy(desc(cashSessionsTable.openedAt))
      .limit(1);
    return session ?? null;
  });

  handle(
    "cash:openSession",
    async (ctx, initialAmount: number) => {
      const userId = ctx.user.id;
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

  handle(
    "cash:closeSession",
    async (ctx, sessionId: number, realTotal: number) => {
      const userId = ctx.user.id;
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

  handle("cash:addMovement", async (ctx, data: any) => {
    const { sessionId, type, amount, reason } = data;
    const userId = ctx.user.id;

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

  handle("cash:getMovements", async (ctx, sessionId: number) => {
    return await db
      .select({
        id: cashMovementsTable.id,
        sessionId: cashMovementsTable.sessionId,
        type: cashMovementsTable.type,
        amount: cashMovementsTable.amount,
        reason: cashMovementsTable.reason,
        userId: cashMovementsTable.userId,
        createdAt: cashMovementsTable.createdAt,
        userName: usersTable.name,
      })
      .from(cashMovementsTable)
      .leftJoin(usersTable, eq(cashMovementsTable.userId, usersTable.id))
      .where(eq(cashMovementsTable.sessionId, sessionId))
      .orderBy(desc(cashMovementsTable.createdAt));
  });

  // ============= SALES =============
  handle("sales:create", async (ctx, data: any) => {
    const { items, total, paymentMethod, sessionId } = data;
    const userId = ctx.user.id;

    const result = await db.transaction(async (tx) => {
      // Create sale
      const [sale] = await tx
        .insert(salesTable)
        .values({
          userId,
          cashSessionId: sessionId,
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

      // Update cash session and register movement
      if (sessionId) {
        if (paymentMethod === "cash") {
          // Update current amount for cash payments
          await tx
            .update(cashSessionsTable)
            .set({
              currentAmount: sql`${cashSessionsTable.currentAmount} + ${total}`,
            })
            .where(eq(cashSessionsTable.id, sessionId));

          // Register cash movement
          await tx.insert(cashMovementsTable).values({
            sessionId,
            type: "IN" as any,
            amount: total.toString(),
            reason: `Venta #${sale.id} - Efectivo`,
            userId,
          });
        } else {
          // Register card payment as informational movement (amount 0)
          await tx.insert(cashMovementsTable).values({
            sessionId,
            type: "IN" as any,
            amount: "0",
            reason: `Venta #${sale.id} - Tarjeta ($${total})`,
            userId,
          });
        }
      }

      return sale;
    });

    return result;
  });

  handle("sales:getAll", async () => {
    return await db
      .select()
      .from(salesTable)
      .orderBy(desc(salesTable.createdAt))
      .limit(100);
  });

  handle("sales:getById", async (ctx, id: number) => {
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
  handle("returns:create", async (ctx, data: any) => {
    const { saleId, items, reason } = data;
    const userId = ctx.user.id;

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

  handle("returns:getAll", async () => {
    return await db
      .select()
      .from(returnsTable)
      .orderBy(desc(returnsTable.createdAt))
      .limit(100);
  });

  // ============= USERS =============
  handle("users:getAll", async () => {
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

  handle("users:create", async (ctx, data: any) => {
    const { name, role, pin } = data;
    assertRole(role);
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

  handle("users:update", async (ctx, id: number, data: any) => {
    assertRole(data.role);
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

  handle("users:delete", async (ctx, id: number) => {
    if (id === ctx.user.id) throw new Error("No puedes eliminar tu propia cuenta");
    await db.delete(usersTable).where(eq(usersTable.id, id));
    return true;
  });

  // ============= INVENTORY =============
  handle("inventory:getMovements", async (ctx, productId?: number) => {
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

  handle("inventory:addMovement", async (ctx, data: any) => {
    const { productId, type, amount, reason } = data;
    const userId = ctx.user.id;

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
  handle("priceChanges:create", async (ctx, data: any) => {
    const { productId, oldPrice, newPrice, reason } = data;
    const userId = ctx.user.id;

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

  handle("priceChanges:getAll", async () => {
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
  handle(
    "reports:getSalesByDateRange",
    async (_ctx, startDate: string, endDate: string) => {
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

  handle("reports:getDeletedProducts", async () => {
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

  // ============= DASHBOARD STATS =============
  handle("dashboard:getStats", async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Ventas de hoy
    const todaySalesResult = await db
      .select({
        total: sql<string>`COALESCE(SUM(${salesTable.total}::numeric), 0)`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(salesTable)
      .where(
        and(
          gte(salesTable.createdAt, today),
          lte(salesTable.createdAt, tomorrow)
        )
      );

    const todaySales = todaySalesResult[0];

    // Ventas por método de pago hoy
    const paymentMethodsResult = await db
      .select({
        paymentMethod: salesTable.paymentMethod,
        total: sql<string>`COALESCE(SUM(${salesTable.total}::numeric), 0)`,
      })
      .from(salesTable)
      .where(
        and(
          gte(salesTable.createdAt, today),
          lte(salesTable.createdAt, tomorrow)
        )
      )
      .groupBy(salesTable.paymentMethod);

    // Productos totales activos
    const productsResult = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
      })
      .from(productsTable)
      .where(eq(productsTable.status, "active"));

    // Productos con stock bajo (menos de 10)
    const lowStockResult = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
      })
      .from(productsTable)
      .where(
        and(
          eq(productsTable.status, "active"),
          sql`${productsTable.stock} < 10`
        )
      );

    // Usuarios activos
    const usersResult = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
      })
      .from(usersTable)
      .where(eq(usersTable.active, true));

    // Devoluciones de hoy
    const returnsResult = await db
      .select({
        total: sql<string>`COALESCE(SUM(${returnsTable.totalRefund}::numeric), 0)`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(returnsTable)
      .where(
        and(
          gte(returnsTable.createdAt, today),
          lte(returnsTable.createdAt, tomorrow)
        )
      );

    // Stock total
    const stockResult = await db
      .select({
        total: sql<number>`COALESCE(SUM(${productsTable.stock}), 0)::int`,
      })
      .from(productsTable)
      .where(eq(productsTable.status, "active"));

    // Sesión de caja activa
    const activeSession = await db
      .select()
      .from(cashSessionsTable)
      .where(isNull(cashSessionsTable.closedAt))
      .orderBy(desc(cashSessionsTable.openedAt))
      .limit(1);

    // Última venta con tiempo relativo calculado en el servidor
    const lastSaleResult = await db
      .select({
        createdAt: salesTable.createdAt,
      })
      .from(salesTable)
      .orderBy(desc(salesTable.createdAt))
      .limit(1);

    let lastSaleText = "N/A";
    if (lastSaleResult[0]) {
      const now = new Date();
      const saleTime = new Date(lastSaleResult[0].createdAt);
      const diffMs = now.getTime() - saleTime.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 1) {
        lastSaleText = "Justo ahora";
      } else if (diffMins < 60) {
        lastSaleText = `Hace ${diffMins} min`;
      } else {
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) {
          lastSaleText = `Hace ${diffHours}h`;
        } else {
          const diffDays = Math.floor(diffHours / 24);
          lastSaleText = `Hace ${diffDays} ${diffDays === 1 ? "día" : "días"}`;
        }
      }
    }

    // Ventas de la semana
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const weekSalesResult = await db
      .select({
        total: sql<string>`COALESCE(SUM(${salesTable.total}::numeric), 0)`,
      })
      .from(salesTable)
      .where(gte(salesTable.createdAt, weekAgo));

    return {
      todaySales: {
        total: todaySales?.total || "0",
        count: todaySales?.count || 0,
      },
      paymentMethods: paymentMethodsResult.map((pm) => ({
        method: pm.paymentMethod,
        total: pm.total,
      })),
      products: {
        total: productsResult[0]?.total || 0,
        lowStock: lowStockResult[0]?.total || 0,
      },
      users: {
        total: usersResult[0]?.total || 0,
      },
      returns: {
        total: returnsResult[0]?.total || "0",
        count: returnsResult[0]?.count || 0,
      },
      stock: {
        total: stockResult[0]?.total || 0,
      },
      cashSession: activeSession[0] || null,
      lastSale: lastSaleText,
      weekSales: {
        total: weekSalesResult[0]?.total || "0",
      },
    };
  });
}
