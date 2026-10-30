CREATE TABLE "business_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" varchar(120) DEFAULT 'Estética Leal' NOT NULL,
	"address" varchar(300),
	"phone" varchar(40),
	"whatsapp" varchar(40),
	"tax_info" varchar(300),
	"footer_message" varchar(300),
	"return_policy" varchar(600),
	"contact_info" varchar(300),
	"logo_data" text,
	"paper_width" varchar(2) DEFAULT '80' NOT NULL,
	"printer_name" varchar(200),
	"silent_print" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "business_settings_singleton" CHECK ("business_settings"."id" = 1),
	CONSTRAINT "business_settings_paper_width" CHECK ("business_settings"."paper_width" in ('80', '58')),
	CONSTRAINT "business_settings_logo_size" CHECK ("business_settings"."logo_data" is null or length("business_settings"."logo_data") <= 400000)
);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "product_sku" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "operation_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_operation_id_unique" ON "sales" USING btree ("operation_id") WHERE "sales"."operation_id" is not null;--> statement-breakpoint
CREATE INDEX "sales_created_at_idx" ON "sales" USING btree ("created_at");
--> statement-breakpoint
INSERT INTO "business_settings" ("id", "name") VALUES (1, 'Estética Leal') ON CONFLICT ("id") DO NOTHING;
