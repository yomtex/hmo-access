-- Integrity rules enforced by the database, not only by application code.

-- Money and quantities
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "pba_tariff_nonneg" CHECK ("tariff_minor" >= 0);--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "auth_amounts_valid" CHECK ("quantity" > 0 AND "tariff_minor" >= 0 AND "copay_minor" >= 0 AND "payable_minor" >= 0 AND "payable_minor" = GREATEST("tariff_minor" * "quantity" - "copay_minor", 0));--> statement-breakpoint
ALTER TABLE "benefit_usage" ADD CONSTRAINT "usage_amounts_valid" CHECK ("quantity" > 0 AND "amount_minor" >= 0);--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_amounts_valid" CHECK ("claimed_amount_minor" >= 0 AND ("approved_amount_minor" IS NULL OR "approved_amount_minor" >= 0));--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_amount_nonneg" CHECK ("amount_minor" >= 0);--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_total_nonneg" CHECK ("total_minor" >= 0);--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_quantity_pos" CHECK ("quantity" > 0);--> statement-breakpoint

-- A settlement can only be PAID / RECONCILED with a verifiable payment reference and amount.
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_paid_has_reference" CHECK (
  "status" NOT IN ('PAID','RECONCILED','RECONCILIATION_MISMATCH')
  OR ("payment_reference" IS NOT NULL AND length(trim("payment_reference")) > 0 AND "paid_amount_minor" IS NOT NULL AND "paid_at" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_reconciled_has_statement" CHECK (
  "status" <> 'RECONCILED' OR ("statement_reference" IS NOT NULL AND "reconciled_at" IS NOT NULL AND "confirmed_amount_minor" = "total_minor")
);--> statement-breakpoint

-- Claims: approved/settled claims carry an approved amount; settled claims belong to a settlement.
ALTER TABLE "claims" ADD CONSTRAINT "claims_approved_amount_present" CHECK (
  "status" NOT IN ('APPROVED','SETTLED') OR "approved_amount_minor" IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_settled_has_settlement" CHECK ("status" <> 'SETTLED' OR "settlement_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_settlement_fk" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id");--> statement-breakpoint

-- Date ranges
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_range" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");--> statement-breakpoint
ALTER TABLE "benefit_versions" ADD CONSTRAINT "benefit_versions_range" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");--> statement-breakpoint
ALTER TABLE "plan_memberships" ADD CONSTRAINT "plan_memberships_range" CHECK ("coverage_end" IS NULL OR "coverage_end" > "coverage_start");--> statement-breakpoint
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "pba_range" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");--> statement-breakpoint

-- At most one ACTIVE tariff per (hmo, provider, benefit, location-or-all).
CREATE UNIQUE INDEX "pba_one_active_uq" ON "provider_benefit_assignments"
  ("hmo_org_id", "provider_org_id", "benefit_id", COALESCE("location_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "status" = 'ACTIVE';--> statement-breakpoint

-- Only one published version may be "open-ended" per plan / benefit.
CREATE UNIQUE INDEX "plan_versions_one_open_published_uq" ON "plan_versions" ("plan_id") WHERE "status" = 'PUBLISHED' AND "effective_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_versions_one_open_published_uq" ON "benefit_versions" ("benefit_id") WHERE "status" = 'PUBLISHED' AND "effective_to" IS NULL;--> statement-breakpoint

-- Published versions are immutable except for closing them (effective_to / status -> RETIRED).
CREATE OR REPLACE FUNCTION forbid_published_plan_version_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' AND (NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.version IS DISTINCT FROM OLD.version OR NEW.plan_id IS DISTINCT FROM OLD.plan_id) THEN
    RAISE EXCEPTION 'published plan version % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_published_benefit_version_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' AND (NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.version IS DISTINCT FROM OLD.version OR NEW.benefit_id IS DISTINCT FROM OLD.benefit_id OR NEW.rules::text IS DISTINCT FROM OLD.rules::text) THEN
    RAISE EXCEPTION 'published benefit version % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER benefit_versions_immutable BEFORE UPDATE ON "benefit_versions" FOR EACH ROW EXECUTE FUNCTION forbid_published_benefit_version_edit();--> statement-breakpoint
CREATE TRIGGER plan_versions_immutable BEFORE UPDATE ON "plan_versions" FOR EACH ROW EXECUTE FUNCTION forbid_published_plan_version_edit();--> statement-breakpoint
-- Plan-version benefit links are frozen once the version is published.
CREATE OR REPLACE FUNCTION forbid_published_plan_benefit_edit() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM plan_versions WHERE id = COALESCE(OLD.plan_version_id, NEW.plan_version_id);
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'benefits of a published plan version are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER plan_version_benefits_immutable BEFORE INSERT OR UPDATE OR DELETE ON "plan_version_benefits" FOR EACH ROW EXECUTE FUNCTION forbid_published_plan_benefit_edit();--> statement-breakpoint

-- Tariffs: only status/effective_to may change.
CREATE OR REPLACE FUNCTION forbid_tariff_edit() RETURNS trigger AS $$
BEGIN
  IF NEW.tariff_minor IS DISTINCT FROM OLD.tariff_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.benefit_id IS DISTINCT FROM OLD.benefit_id
     OR NEW.provider_org_id IS DISTINCT FROM OLD.provider_org_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'provider tariffs are immutable; end the assignment and create a new one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER provider_benefit_assignments_immutable BEFORE UPDATE ON "provider_benefit_assignments" FOR EACH ROW EXECUTE FUNCTION forbid_tariff_edit();--> statement-breakpoint

-- Audit trail is append-only.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();--> statement-breakpoint

-- Claim adjustments are append-only too (corrections are new adjustments).
CREATE TRIGGER claim_adjustments_append_only BEFORE UPDATE OR DELETE ON "claim_adjustments" FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
