CREATE TABLE "refund_settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"return_id" integer NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"authorized_by" integer NOT NULL,
	"processed_by" integer NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cash_session_id" integer,
	"cash_movement_id" integer,
	"external_reference" varchar(64),
	"operation_id" text,
	CONSTRAINT "refund_settlements_amount_non_negative" CHECK ("refund_settlements"."amount" >= 0),
	CONSTRAINT "refund_settlements_method_coherent" CHECK (("refund_settlements"."payment_method" = 'cash' and "refund_settlements"."cash_session_id" is not null and "refund_settlements"."cash_movement_id" is not null and "refund_settlements"."external_reference" is null) or ("refund_settlements"."payment_method" = 'card' and "refund_settlements"."cash_movement_id" is null))
);
--> statement-breakpoint
ALTER TABLE "refund_settlements" ADD CONSTRAINT "refund_settlements_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_settlements" ADD CONSTRAINT "refund_settlements_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_settlements" ADD CONSTRAINT "refund_settlements_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_settlements" ADD CONSTRAINT "refund_settlements_cash_session_id_cash_sessions_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_settlements" ADD CONSTRAINT "refund_settlements_cash_movement_id_cash_movements_id_fk" FOREIGN KEY ("cash_movement_id") REFERENCES "public"."cash_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_settlements_return_unique" ON "refund_settlements" USING btree ("return_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_settlements_operation_id_unique" ON "refund_settlements" USING btree ("operation_id") WHERE "refund_settlements"."operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_settlements_cash_movement_unique" ON "refund_settlements" USING btree ("cash_movement_id") WHERE "refund_settlements"."cash_movement_id" is not null;--> statement-breakpoint
CREATE INDEX "refund_settlements_paid_at_idx" ON "refund_settlements" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX "refund_settlements_session_idx" ON "refund_settlements" USING btree ("cash_session_id");