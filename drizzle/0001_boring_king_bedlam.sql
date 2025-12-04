ALTER TABLE "sales" ALTER COLUMN "cash_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "session_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "current_amount" numeric(12, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "final_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "deleted_products_log" ADD COLUMN "sku" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "deleted_products_log" ADD COLUMN "name" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "price_changes" ADD COLUMN "changed_by" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "return_items" ADD COLUMN "sale_item_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "return_items" ADD COLUMN "refund_amount" numeric(12, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "total_refund" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "processed_by" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "user_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "subtotal" numeric(12, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "tax" numeric(12, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" DROP COLUMN IF EXISTS "cash_session_id";--> statement-breakpoint
ALTER TABLE "cash_sessions" DROP COLUMN IF EXISTS "expected_total";--> statement-breakpoint
ALTER TABLE "cash_sessions" DROP COLUMN IF EXISTS "real_total";--> statement-breakpoint
ALTER TABLE "price_changes" DROP COLUMN IF EXISTS "user_id";--> statement-breakpoint
ALTER TABLE "return_items" DROP COLUMN IF EXISTS "unit_price";--> statement-breakpoint
ALTER TABLE "returns" DROP COLUMN IF EXISTS "user_id";--> statement-breakpoint
ALTER TABLE "returns" DROP COLUMN IF EXISTS "amount";--> statement-breakpoint
ALTER TABLE "sales" DROP COLUMN IF EXISTS "cashier_id";--> statement-breakpoint
ALTER TABLE "sales" DROP COLUMN IF EXISTS "card_auth_code";