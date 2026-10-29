import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  timestamp,
  boolean,
  pgEnum,
  numeric,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["admin", "vendor"]);
// 'deleted' = logical deletion (products:softDelete); 'inactive' stays "not for sale, not deleted".
export const productStatusEnum = pgEnum("product_status", [
  "active",
  "inactive",
  "deleted",
]);
export const invTypeEnum = pgEnum("inventory_type", [
  "IN",
  "OUT",
  "ADJUST",
  "DELETE",
]);
export const cashMovementEnum = pgEnum("cash_movement_type", ["IN", "OUT"]);
export const paymentMethodEnum = pgEnum("payment_method", ["cash", "card"]);
// Refund settlement: a registered return is NOT a paid refund. 'pending' = owed, not yet paid out;
// 'paid' is reserved for a future real settlement operation (nothing sets it today);
// 'legacy_unspecified' marks returns registered before this state existed (never reinterpreted as paid).
export const refundStatusEnum = pgEnum("refund_status", ["pending", "paid", "legacy_unspecified"]);
export const cashSessionStatusEnum = pgEnum("cash_session_status", [
  "open",
  "closed",
]);

export const users = pgTable(
  "users",
  {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  pinHash: text("pin_hash").notNull(),
  role: roleEnum("role").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
  },
  // two users can never share a PIN (login identifies the user by PIN alone)
  (t) => [uniqueIndex("users_pin_hash_unique").on(t.pinHash)]
);

export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    sku: varchar("sku", { length: 64 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    price: numeric("price", { precision: 12, scale: 2 }).notNull(),
    stock: integer("stock").notNull().default(0),
    barcode: varchar("barcode", { length: 128 }),
    category: varchar("category", { length: 128 }),
    status: productStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check("products_stock_non_negative", sql`${t.stock} >= 0`),
    check("products_price_non_negative", sql`${t.price} >= 0`),
    // Invariant of the logical deletion: a deleted product holds no stock, whatever handler touches it.
    // Compared as text: the new enum value cannot be used as a literal in the migration that adds it.
    check("products_deleted_has_no_stock", sql`${t.status}::text <> 'deleted' or ${t.stock} = 0`),
  ]
);

export const inventoryMovements = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id),
  userId: integer("user_id").notNull(),
  type: invTypeEnum("type").notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export const deletedProductsLog = pgTable("deleted_products_log", {
  id: serial("id").primaryKey(),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id),
  sku: varchar("sku", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  deletedBy: integer("deleted_by").notNull(),
  reason: text("reason").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export const priceChanges = pgTable("price_changes", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  oldPrice: numeric("old_price", { precision: 12, scale: 2 }).notNull(),
  newPrice: numeric("new_price", { precision: 12, scale: 2 }).notNull(),
  changedBy: integer("changed_by").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export const cashSessions = pgTable(
  "cash_sessions",
  {
    id: serial("id").primaryKey(),
    openedBy: integer("opened_by").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    initialAmount: numeric("initial_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    currentAmount: numeric("current_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    finalAmount: numeric("final_amount", { precision: 12, scale: 2 }),
    status: cashSessionStatusEnum("status").notNull().default("open"),
    closedBy: integer("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    // The installation has ONE shared cash register: at most one session without closed_at.
    uniqueIndex("cash_sessions_single_open")
      .on(sql`(1)`)
      .where(sql`${t.closedAt} is null`),
    check("cash_sessions_initial_non_negative", sql`${t.initialAmount} >= 0`),
    check("cash_sessions_current_non_negative", sql`${t.currentAmount} >= 0`),
    check(
      "cash_sessions_final_non_negative",
      sql`${t.finalAmount} is null or ${t.finalAmount} >= 0`
    ),
    check(
      "cash_sessions_state_coherent",
      sql`(${t.status} = 'open' and ${t.closedAt} is null and ${t.closedBy} is null and ${t.finalAmount} is null) or (${t.status} = 'closed' and ${t.closedAt} is not null and ${t.closedBy} is not null and ${t.finalAmount} is not null)`
    ),
  ]
);

export const cashMovements = pgTable(
  "cash_movements",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => cashSessions.id),
    userId: integer("user_id").notNull(),
    type: cashMovementEnum("type").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  // 0 is allowed: card sales are recorded as informational movements of amount 0.
  (t) => [check("cash_movements_amount_non_negative", sql`${t.amount} >= 0`)]
);

export const sales = pgTable(
  "sales",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    cashSessionId: integer("cash_session_id").references(() => cashSessions.id),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (t) => [check("sales_total_non_negative", sql`${t.total} >= 0`)]
);

export const saleItems = pgTable(
  "sale_items",
  {
    id: serial("id").primaryKey(),
    saleId: integer("sale_id")
      .notNull()
      .references(() => sales.id),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
  },
  (t) => [
    check("sale_items_quantity_positive", sql`${t.quantity} > 0`),
    check(
      "sale_items_amounts_non_negative",
      sql`${t.unitPrice} >= 0 and ${t.subtotal} >= 0`
    ),
  ]
);

export const returns = pgTable(
  "returns",
  {
    id: serial("id").primaryKey(),
    saleId: integer("sale_id")
      .notNull()
      .references(() => sales.id),
    totalRefund: numeric("total_refund", { precision: 12, scale: 2 }),
    refundStatus: refundStatusEnum("refund_status").notNull().default("pending"),
    reason: text("reason").notNull(),
    processedBy: integer("processed_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check("returns_total_refund_non_negative", sql`${t.totalRefund} is null or ${t.totalRefund} >= 0`),
  ]
);

export const returnItems = pgTable(
  "return_items",
  {
    id: serial("id").primaryKey(),
    returnId: integer("return_id")
      .notNull()
      .references(() => returns.id),
    saleItemId: integer("sale_item_id")
      .notNull()
      .references(() => saleItems.id),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    refundAmount: numeric("refund_amount", { precision: 12, scale: 2 }).notNull(),
  },
  (t) => [
    check("return_items_quantity_positive", sql`${t.quantity} > 0`),
    check("return_items_refund_non_negative", sql`${t.refundAmount} >= 0`),
    // one line per sale item inside a return
    uniqueIndex("return_items_return_sale_item_unique").on(t.returnId, t.saleItemId),
  ]
);
