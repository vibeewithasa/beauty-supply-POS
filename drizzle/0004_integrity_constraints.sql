-- Migration 0004: integrity constraints for sales / cash / inventory (Phase 1B).
-- BEFORE applying to an existing database: take a pg_dump backup and run
--   node scripts/precheck-integrity.mjs [--database=<name>]
-- (read-only). Any BLOCKER row means a constraint below would be violated and this whole migration
-- rolls back (drizzle applies pending migrations in one transaction); nothing is forced.
-- Requires PostgreSQL >= 12 (ALTER TYPE ... ADD VALUE inside a transaction; the new value is not used here).
--
-- Reconciliation (data fix, runs BEFORE the state constraint): sessions closed by the old code kept
-- status='open' although closed_at/closed_by/final_amount were set.
ALTER TYPE "public"."product_status" ADD VALUE 'deleted';--> statement-breakpoint
UPDATE "cash_sessions" SET "status" = 'closed' WHERE "closed_at" IS NOT NULL AND "status" = 'open';--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_session_id_cash_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_products_log" ADD CONSTRAINT "deleted_products_log_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cash_session_id_cash_sessions_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_single_open" ON "cash_sessions" USING btree ((1)) WHERE "cash_sessions"."closed_at" is null;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_amount_non_negative" CHECK ("cash_movements"."amount" >= 0);--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_initial_non_negative" CHECK ("cash_sessions"."initial_amount" >= 0);--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_current_non_negative" CHECK ("cash_sessions"."current_amount" >= 0);--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_final_non_negative" CHECK ("cash_sessions"."final_amount" is null or "cash_sessions"."final_amount" >= 0);--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_state_coherent" CHECK (("cash_sessions"."status" = 'open' and "cash_sessions"."closed_at" is null and "cash_sessions"."closed_by" is null and "cash_sessions"."final_amount" is null) or ("cash_sessions"."status" = 'closed' and "cash_sessions"."closed_at" is not null and "cash_sessions"."closed_by" is not null and "cash_sessions"."final_amount" is not null));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_stock_non_negative" CHECK ("products"."stock" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_price_non_negative" CHECK ("products"."price" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_deleted_has_no_stock" CHECK ("products"."status"::text <> 'deleted' or "products"."stock" = 0);--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_quantity_positive" CHECK ("sale_items"."quantity" > 0);--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_amounts_non_negative" CHECK ("sale_items"."unit_price" >= 0 and "sale_items"."subtotal" >= 0);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_total_non_negative" CHECK ("sales"."total" >= 0);