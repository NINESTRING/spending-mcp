CREATE TABLE "merchant_categories" (
	"owner_id" text,
	"merchant_key" text,
	"category" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_categories_pkey" PRIMARY KEY("owner_id","merchant_key")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_id" text NOT NULL,
	"spent_on" date NOT NULL,
	"merchant" text NOT NULL,
	"merchant_key" text NOT NULL,
	"amount" integer NOT NULL,
	"category" text NOT NULL,
	"card" text,
	"approval_no" text,
	"memo" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_owner_id_dedupe_key_unique" UNIQUE("owner_id","dedupe_key")
);
--> statement-breakpoint
CREATE INDEX "transactions_owner_id_spent_on_idx" ON "transactions" ("owner_id","spent_on");--> statement-breakpoint
CREATE INDEX "transactions_owner_id_merchant_key_idx" ON "transactions" ("owner_id","merchant_key");