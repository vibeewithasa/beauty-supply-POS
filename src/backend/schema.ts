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
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["admin", "vendor"]);
export const productStatusEnum = pgEnum("product_status", [
  "active",
  "inactive",
]);
export const invTypeEnum = pgEnum("inventory_type", [
  "IN",
  "OUT",
  "ADJUST",
  "DELETE",
]);
export const cashMovementEnum = pgEnum("cash_movement_type", ["IN", "OUT"]);
export const paymentMethodEnum = pgEnum("payment_method", ["cash", "card"]);
export const cashSessionStatusEnum = pgEnum("cash_session_status", [
  "open",
  "closed",
]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  pinHash: text("pin_hash").notNull(),
  role: roleEnum("role").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  sku: varchar("sku", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  stock: integer("stock").notNull().default(0),
  barcode: varchar("barcode", { length: 128 }),
  category: varchar("category", { length: 128 }),
  status: productStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const inventoryMovements = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  userId: integer("user_id").notNull(),
  type: invTypeEnum("type").notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const deletedProductsLog = pgTable("deleted_products_log", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  sku: varchar("sku", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  deletedBy: integer("deleted_by").notNull(),
  reason: text("reason").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const priceChanges = pgTable("price_changes", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  oldPrice: numeric("old_price", { precision: 12, scale: 2 }).notNull(),
  newPrice: numeric("new_price", { precision: 12, scale: 2 }).notNull(),
  changedBy: integer("changed_by").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const cashSessions = pgTable("cash_sessions", {
  id: serial("id").primaryKey(),
  openedBy: integer("opened_by").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
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
});

export const cashMovements = pgTable("cash_movements", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  userId: integer("user_id").notNull(),
  type: cashMovementEnum("type").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const sales = pgTable("sales", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  cashSessionId: integer("cash_session_id"),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  paymentMethod: paymentMethodEnum("payment_method").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const saleItems = pgTable("sale_items", {
  id: serial("id").primaryKey(),
  saleId: integer("sale_id").notNull(),
  productId: integer("product_id").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
});

export const returns = pgTable("returns", {
  id: serial("id").primaryKey(),
  saleId: integer("sale_id").notNull(),
  totalRefund: numeric("total_refund", { precision: 12, scale: 2 }),
  reason: text("reason").notNull(),
  processedBy: integer("processed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const returnItems = pgTable("return_items", {
  id: serial("id").primaryKey(),
  returnId: integer("return_id").notNull(),
  saleItemId: integer("sale_item_id").notNull(),
  productId: integer("product_id").notNull(),
  quantity: integer("quantity").notNull(),
  refundAmount: numeric("refund_amount", { precision: 12, scale: 2 }).notNull(),
});
