ALTER TABLE "cash_movements" ADD COLUMN "sale_id" integer;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movements_sale_idx" ON "cash_movements" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "cash_movements_session_idx" ON "cash_movements" USING btree ("session_id");
--> statement-breakpoint
-- Link the movements that sales created BEFORE this column existed, so summaries can tell them from manual ones.
-- Only when everything agrees: the sale exists, belongs to the same register, and the amount matches its payment method
-- (cash: the sale total; card: the informational 0.00). Anything else stays NULL, i.e. it is treated as manual.
UPDATE "cash_movements" m
SET "sale_id" = s."id"
FROM "sales" s
WHERE m."sale_id" IS NULL
  AND m."type" = 'IN'
  AND m."reason" ~ '^Venta #[0-9]{1,9} - (Efectivo|Tarjeta)'
  AND s."id" = substring(m."reason" from '^Venta #([0-9]{1,9}) - ')::integer
  AND s."cash_session_id" = m."session_id"
  AND (
    (m."reason" LIKE '% - Efectivo' AND s."payment_method" = 'cash' AND m."amount" = s."total")
    OR (m."reason" LIKE '% - Tarjeta%' AND s."payment_method" = 'card' AND m."amount" = 0)
  );
