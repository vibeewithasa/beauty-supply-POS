-- Migration 0005: returns integrity + explicit refund settlement state (Sprint 01, block A).
-- BEFORE applying to an existing database: pg_dump backup + `node scripts/precheck-integrity.mjs [--database=<name>]`
-- (read-only). Blockers (this whole migration would roll back): returns/return_items orphans, quantity <= 0,
-- negative amounts, duplicate (return_id, sale_item_id).
--
-- Refund state: a registered return is NOT a paid refund. Rows that already exist are backfilled as
-- 'legacy_unspecified' (never 'paid', never silently 'pending'); the column default is then switched to
-- 'pending' so every NEW return starts as owed-but-unpaid. Nothing in the app sets 'paid' yet.
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'paid', 'legacy_unspecified');--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "refund_status" "refund_status" DEFAULT 'legacy_unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE "returns" ALTER COLUMN "refund_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_sale_item_id_sale_items_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "return_items_return_sale_item_unique" ON "return_items" USING btree ("return_id","sale_item_id");--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_quantity_positive" CHECK ("return_items"."quantity" > 0);--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_refund_non_negative" CHECK ("return_items"."refund_amount" >= 0);--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_total_refund_non_negative" CHECK ("returns"."total_refund" is null or "returns"."total_refund" >= 0);