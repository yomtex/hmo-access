CREATE TABLE "sms_simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_e164" text NOT NULL,
	"body" text NOT NULL,
	"template" text,
	"would_use_provider" text NOT NULL,
	"live_configured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sms_simulations_to_idx" ON "sms_simulations" USING btree ("to_e164","created_at");