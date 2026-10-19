ALTER TYPE "public"."settlement_status" ADD VALUE IF NOT EXISTS 'AWAITING_PAYMENT' BEFORE 'PAID';--> statement-breakpoint
CREATE TABLE "collection_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"payout_account_id" uuid NOT NULL,
	"partner" text NOT NULL,
	"partner_account_ref" text NOT NULL,
	"partner_customer_ref" text,
	"account_number" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner" text NOT NULL,
	"partner_event_id" text NOT NULL,
	"transaction_ref" text NOT NULL,
	"session_id" text,
	"collection_account_id" uuid,
	"hmo_org_id" uuid,
	"provider_org_id" uuid,
	"account_number" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"narration" text,
	"sender_name" text,
	"sender_bank" text,
	"sender_account_last4" text,
	"paid_at" timestamp with time zone,
	"verification" text DEFAULT 'PENDING' NOT NULL,
	"verification_note" text,
	"verified_at" timestamp with time zone,
	"match_status" text DEFAULT 'PENDING' NOT NULL,
	"match_rule" text,
	"settlement_id" uuid,
	"exception_reason" text,
	"matched_by_id" uuid,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" uuid,
	"payload_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_sim_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_sim_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"session_id" text NOT NULL,
	"account_number" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"narration" text,
	"sender_name" text,
	"sender_bank" text,
	"status" text DEFAULT 'success' NOT NULL,
	"tamper" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_sim_transfers_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"partner" text NOT NULL,
	"bank_code" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_number_enc" text NOT NULL,
	"account_number_hash" text NOT NULL,
	"account_last4" text NOT NULL,
	"resolved_name" text NOT NULL,
	"name_match_score" integer NOT NULL,
	"status" text NOT NULL,
	"active_from" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"partner_recipient_ref" text,
	"created_by_id" uuid NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "verification" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "received_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "collection_account_id" uuid;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "payment_instructions_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "exception_reason" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "exception_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "exception_resolution" text;--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_payout_account_id_payout_accounts_id_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."payout_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_collection_account_id_collection_accounts_id_fk" FOREIGN KEY ("collection_account_id") REFERENCES "public"."collection_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_matched_by_id_users_id_fk" FOREIGN KEY ("matched_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_accounts_partner_number_uq" ON "collection_accounts" USING btree ("partner","account_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_credits_partner_txn_uq" ON "payment_credits" USING btree ("partner","transaction_ref");--> statement-breakpoint
CREATE INDEX "payment_credits_hmo_idx" ON "payment_credits" USING btree ("hmo_org_id","received_at");--> statement-breakpoint
CREATE INDEX "payment_credits_provider_idx" ON "payment_credits" USING btree ("provider_org_id","received_at");--> statement-breakpoint
CREATE INDEX "payment_credits_settlement_idx" ON "payment_credits" USING btree ("settlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_sim_accounts_uq" ON "payment_sim_accounts" USING btree ("bank_code","account_number");--> statement-breakpoint
CREATE INDEX "payout_accounts_provider_idx" ON "payout_accounts" USING btree ("provider_org_id","created_at");--> statement-breakpoint
-- ───────────── Integrity rules for verified payments (hand-written) ─────────────
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_values_valid" CHECK (
  "status" IN ('PENDING_REVIEW','SCHEDULED','ACTIVE','REPLACED','CANCELLED','REJECTED')
  AND "name_match_score" BETWEEN 0 AND 100 AND "account_last4" ~ '^[0-9]{4}$'
  AND ("status" <> 'SCHEDULED' OR "active_from" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "payout_accounts_one_active_uq" ON "payout_accounts" ("provider_org_id") WHERE "status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_accounts_one_pending_uq" ON "payout_accounts" ("provider_org_id") WHERE "status" IN ('PENDING_REVIEW','SCHEDULED');--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_id_provider_uq" UNIQUE ("id", "provider_org_id");--> statement-breakpoint
CREATE TRIGGER payout_accounts_org_type BEFORE INSERT OR UPDATE ON "payout_accounts" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('provider_org_id', 'PROVIDER');--> statement-breakpoint

ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_status_valid" CHECK ("status" IN ('ACTIVE','CLOSED'));--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_contract_fk" FOREIGN KEY ("hmo_org_id", "provider_org_id") REFERENCES "hmo_provider_contracts" ("hmo_org_id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_payout_owner_fk" FOREIGN KEY ("payout_account_id", "provider_org_id") REFERENCES "payout_accounts" ("id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_id_pair_uq" UNIQUE ("id", "hmo_org_id", "provider_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_accounts_one_active_uq" ON "collection_accounts" ("hmo_org_id", "provider_org_id", "partner") WHERE "status" = 'ACTIVE';--> statement-breakpoint

ALTER TABLE "settlements" ADD CONSTRAINT "settlements_id_pair_uq" UNIQUE ("id", "hmo_org_id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_collection_owner_fk" FOREIGN KEY ("collection_account_id", "hmo_org_id", "provider_org_id") REFERENCES "collection_accounts" ("id", "hmo_org_id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_verification_valid" CHECK (
  "verification" IN ('NONE','BANK_VERIFIED','MANUAL_UNVERIFIED') AND "received_minor" >= 0
  AND ("verification" <> 'BANK_VERIFIED' OR "received_minor" >= "total_minor")
  AND ("status"::text <> 'AWAITING_PAYMENT' OR "collection_account_id" IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_values_valid" CHECK (
  "amount_minor" > 0
  AND "verification" IN ('PENDING','VERIFIED','REJECTED')
  AND "match_status" IN ('PENDING','MATCHED','UNMATCHED','EXCEPTION','DUPLICATE','REJECTED')
  AND ("match_status" <> 'MATCHED' OR ("settlement_id" IS NOT NULL AND "verification" = 'VERIFIED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "payment_credits_session_uq" ON "payment_credits" ("partner", "session_id") WHERE "session_id" IS NOT NULL AND "match_status" <> 'DUPLICATE';--> statement-breakpoint
ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_collection_owner_fk" FOREIGN KEY ("collection_account_id", "hmo_org_id", "provider_org_id") REFERENCES "collection_accounts" ("id", "hmo_org_id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "payment_credits" ADD CONSTRAINT "payment_credits_settlement_owner_fk" FOREIGN KEY ("settlement_id", "hmo_org_id", "provider_org_id") REFERENCES "settlements" ("id", "hmo_org_id", "provider_org_id");--> statement-breakpoint
-- Verified credits are evidence: once verified, their amount, account and references never change.
CREATE OR REPLACE FUNCTION forbid_verified_credit_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.verification = 'VERIFIED' AND (NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.transaction_ref IS DISTINCT FROM OLD.transaction_ref
     OR NEW.account_number IS DISTINCT FROM OLD.account_number OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.verification IS DISTINCT FROM OLD.verification) THEN
    RAISE EXCEPTION 'verified payment credit % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER payment_credits_immutable BEFORE UPDATE ON "payment_credits" FOR EACH ROW EXECUTE FUNCTION forbid_verified_credit_edit();--> statement-breakpoint
CREATE TRIGGER payment_credits_no_delete BEFORE DELETE ON "payment_credits" FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
