-- 0006: tenant isolation, relationship integrity and check-in duplicate protection.
--
-- Additive only: no rows are deleted or merged. Every new constraint is checked against existing
-- rows. If existing data breaks a rule, this migration stops, rolls back and names the problem.
-- Run `npm run db:preflight` before migrating: it lists the affected rows so they can be
-- resolved deliberately (see docs/operations/deployment-and-recovery.md).

-- ───────────── 1. Stop early, with a readable message, on the conflicts most likely in real data ─────────────
DO $$
DECLARE n int; problems text := '';
BEGIN
  SELECT count(*) INTO n FROM (SELECT 1 FROM members GROUP BY hmo_org_id, upper(member_number) HAVING count(*) > 1) x;
  IF n > 0 THEN problems := problems || format(E'\n  - %s member number(s) exist twice in one HMO, differing only by letter case', n); END IF;
  SELECT count(*) INTO n FROM (SELECT 1 FROM organization_memberships WHERE status = 'ACTIVE' GROUP BY user_id HAVING count(*) > 1) x;
  IF n > 0 THEN problems := problems || format(E'\n  - %s login(s) are active in more than one organization', n); END IF;
  SELECT count(*) INTO n FROM (SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) x;
  IF n > 0 THEN problems := problems || format(E'\n  - %s email address(es) exist twice with different letter case', n); END IF;
  SELECT count(*) INTO n FROM (SELECT 1 FROM organizations GROUP BY lower(slug) HAVING count(*) > 1) x;
  IF n > 0 THEN problems := problems || format(E'\n  - %s organization slug(s) differ only by letter case', n); END IF;
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM visit_intents WHERE status IN ('PENDING_CONFIRMATION','CONFIRMED') AND expires_at > now()
    GROUP BY member_id, benefit_id, location_id HAVING count(*) > 1) x;
  IF n > 0 THEN problems := problems || format(E'\n  - %s member(s) have several unexpired check-ins open at one branch (wait 15 minutes and retry)', n); END IF;
  IF problems <> '' THEN
    RAISE EXCEPTION E'Migration 0006 stopped; existing data conflicts with the new integrity rules:%\nRun "npm run db:preflight" to list the rows. No data was changed.', problems;
  END IF;
END $$;--> statement-breakpoint

-- ───────────── 2. Stable, unique identities ─────────────
CREATE UNIQUE INDEX "organizations_slug_ci_uq" ON "organizations" (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_ci_uq" ON "users" (lower("email"));--> statement-breakpoint
-- Member numbers are unique per HMO ignoring letter case ("abc1" = "ABC1").
CREATE UNIQUE INDEX "members_hmo_number_ci_uq" ON "members" ("hmo_org_id", upper("member_number"));--> statement-breakpoint
-- Lookup for "looks like the same number" checks (HM-001 vs HM001); flagged for review, never merged.
CREATE INDEX "members_hmo_number_loose_idx" ON "members" ("hmo_org_id", regexp_replace(upper("member_number"), '[^A-Z0-9]', '', 'g'));--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_number_trimmed" CHECK ("member_number" = btrim("member_number") AND length("member_number") BETWEEN 1 AND 64);--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_names_present" CHECK (length(btrim("first_name")) > 0 AND length(btrim("last_name")) > 0);--> statement-breakpoint

-- An organization's type never changes (an HMO cannot become a provider or the reverse).
CREATE OR REPLACE FUNCTION forbid_org_type_change() RETURNS trigger AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'organization % type is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER organizations_type_immutable BEFORE UPDATE ON "organizations" FOR EACH ROW EXECUTE FUNCTION forbid_org_type_change();--> statement-breakpoint

-- Columns that point at an organization must point at the right KIND of organization.
-- Usage: enforce_org_type('<column>', '<HMO|PROVIDER>', ['<column>', '<type>' ...])
CREATE OR REPLACE FUNCTION enforce_org_type() RETURNS trigger AS $$
DECLARE i int := 0; org uuid; actual org_type;
BEGIN
  WHILE i < TG_NARGS LOOP
    EXECUTE format('SELECT ($1).%I', TG_ARGV[i]) USING NEW INTO org;
    IF org IS NOT NULL THEN
      SELECT type INTO actual FROM organizations WHERE id = org;
      IF actual IS DISTINCT FROM TG_ARGV[i + 1]::org_type THEN
        RAISE EXCEPTION '%.% must reference a % organization', TG_TABLE_NAME, TG_ARGV[i], TG_ARGV[i + 1] USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER hmo_profiles_org_type BEFORE INSERT OR UPDATE ON "hmo_profiles" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('org_id', 'HMO');--> statement-breakpoint
CREATE TRIGGER provider_profiles_org_type BEFORE INSERT OR UPDATE ON "provider_profiles" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('org_id', 'PROVIDER');--> statement-breakpoint
CREATE TRIGGER provider_locations_org_type BEFORE INSERT OR UPDATE ON "provider_locations" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('provider_org_id', 'PROVIDER');--> statement-breakpoint
CREATE TRIGGER hmo_provider_contracts_org_type BEFORE INSERT OR UPDATE ON "hmo_provider_contracts" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('hmo_org_id', 'HMO', 'provider_org_id', 'PROVIDER');--> statement-breakpoint
CREATE TRIGGER members_org_type BEFORE INSERT OR UPDATE ON "members" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('hmo_org_id', 'HMO');--> statement-breakpoint
CREATE TRIGGER plans_org_type BEFORE INSERT OR UPDATE ON "plans" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('hmo_org_id', 'HMO');--> statement-breakpoint
CREATE TRIGGER benefits_org_type BEFORE INSERT OR UPDATE ON "benefits" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('hmo_org_id', 'HMO');--> statement-breakpoint
CREATE TRIGGER import_jobs_org_type BEFORE INSERT OR UPDATE ON "import_jobs" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('hmo_org_id', 'HMO');--> statement-breakpoint
CREATE TRIGGER integration_configs_org_type BEFORE INSERT OR UPDATE ON "integration_configs" FOR EACH ROW EXECUTE FUNCTION enforce_org_type('hmo_org_id', 'HMO');--> statement-breakpoint

-- ───────────── 3. Logins: one active organization per login, role matches organization type ─────────────
-- Stops one credential from being reused to act for an HMO and a provider (or two providers).
CREATE UNIQUE INDEX "org_membership_one_active_per_user_uq" ON "organization_memberships" ("user_id") WHERE "status" = 'ACTIVE';--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_membership_role_type() RETURNS trigger AS $$
DECLARE role_type org_type; org_t org_type;
BEGIN
  SELECT org_type INTO role_type FROM roles WHERE key = NEW.role_key;
  SELECT type INTO org_t FROM organizations WHERE id = NEW.org_id;
  IF role_type IS DISTINCT FROM org_t THEN
    RAISE EXCEPTION 'role % cannot be held in a % organization', NEW.role_key, org_t USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER organization_memberships_role_type BEFORE INSERT OR UPDATE ON "organization_memberships" FOR EACH ROW EXECUTE FUNCTION enforce_membership_role_type();--> statement-breakpoint
-- Front-desk branch assignments must be branches of the staff member's own provider.
CREATE OR REPLACE FUNCTION enforce_staff_location_owner() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships m JOIN provider_locations l ON l.provider_org_id = m.org_id
    WHERE m.id = NEW.membership_id AND l.id = NEW.location_id
  ) THEN
    RAISE EXCEPTION 'branch % does not belong to the staff member''s organization', NEW.location_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER provider_staff_locations_owner BEFORE INSERT OR UPDATE ON "provider_staff_locations" FOR EACH ROW EXECUTE FUNCTION enforce_staff_location_owner();--> statement-breakpoint

-- ───────────── 4. Relationships cannot be cross-wired between tenants (composite foreign keys) ─────────────
ALTER TABLE "provider_locations" ADD CONSTRAINT "provider_locations_id_provider_uq" UNIQUE ("id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_id_hmo_uq" UNIQUE ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_id_hmo_uq" UNIQUE ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "benefits" ADD CONSTRAINT "benefits_id_hmo_uq" UNIQUE ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_id_hmo_provider_uq" UNIQUE ("id", "hmo_org_id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_id_hmo_uq" UNIQUE ("id", "hmo_org_id");--> statement-breakpoint

-- An HMO approves a branch only of a provider it has a contract with, and the branch must belong to that provider.
ALTER TABLE "network_locations" ADD CONSTRAINT "network_locations_location_owner_fk" FOREIGN KEY ("location_id", "provider_org_id") REFERENCES "provider_locations" ("id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "network_locations" ADD CONSTRAINT "network_locations_contract_fk" FOREIGN KEY ("hmo_org_id", "provider_org_id") REFERENCES "hmo_provider_contracts" ("hmo_org_id", "provider_org_id");--> statement-breakpoint
-- Tariffs: contract exists, branch belongs to the provider, benefit belongs to the HMO.
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "pba_contract_fk" FOREIGN KEY ("hmo_org_id", "provider_org_id") REFERENCES "hmo_provider_contracts" ("hmo_org_id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "pba_location_owner_fk" FOREIGN KEY ("location_id", "provider_org_id") REFERENCES "provider_locations" ("id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "pba_benefit_owner_fk" FOREIGN KEY ("benefit_id", "hmo_org_id") REFERENCES "benefits" ("id", "hmo_org_id");--> statement-breakpoint
-- Memberships, credentials, approvals: member, plan and benefit all belong to the same HMO.
ALTER TABLE "plan_memberships" ADD CONSTRAINT "plan_memberships_member_owner_fk" FOREIGN KEY ("member_id", "hmo_org_id") REFERENCES "members" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "plan_memberships" ADD CONSTRAINT "plan_memberships_plan_owner_fk" FOREIGN KEY ("plan_id", "hmo_org_id") REFERENCES "plans" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_owner_fk" FOREIGN KEY ("plan_id", "hmo_org_id") REFERENCES "plans" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "benefit_versions" ADD CONSTRAINT "benefit_versions_benefit_owner_fk" FOREIGN KEY ("benefit_id", "hmo_org_id") REFERENCES "benefits" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "plan_version_benefits" ADD CONSTRAINT "plan_version_benefits_benefit_owner_fk" FOREIGN KEY ("benefit_id", "hmo_org_id") REFERENCES "benefits" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "member_credentials" ADD CONSTRAINT "member_credentials_member_owner_fk" FOREIGN KEY ("member_id", "hmo_org_id") REFERENCES "members" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_member_owner_fk" FOREIGN KEY ("member_id", "hmo_org_id") REFERENCES "members" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_benefit_owner_fk" FOREIGN KEY ("benefit_id", "hmo_org_id") REFERENCES "benefits" ("id", "hmo_org_id");--> statement-breakpoint
-- Verification flow: branch belongs to the provider; member and benefit belong to the HMO; a contract exists.
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_location_owner_fk" FOREIGN KEY ("location_id", "provider_org_id") REFERENCES "provider_locations" ("id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_location_owner_fk" FOREIGN KEY ("location_id", "provider_org_id") REFERENCES "provider_locations" ("id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_member_owner_fk" FOREIGN KEY ("member_id", "hmo_org_id") REFERENCES "members" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_benefit_owner_fk" FOREIGN KEY ("benefit_id", "hmo_org_id") REFERENCES "benefits" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_location_owner_fk" FOREIGN KEY ("location_id", "provider_org_id") REFERENCES "provider_locations" ("id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_member_owner_fk" FOREIGN KEY ("member_id", "hmo_org_id") REFERENCES "members" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_benefit_owner_fk" FOREIGN KEY ("benefit_id", "hmo_org_id") REFERENCES "benefits" ("id", "hmo_org_id");--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_contract_fk" FOREIGN KEY ("hmo_org_id", "provider_org_id") REFERENCES "hmo_provider_contracts" ("hmo_org_id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "benefit_usage" ADD CONSTRAINT "benefit_usage_member_owner_fk" FOREIGN KEY ("member_id", "hmo_org_id") REFERENCES "members" ("id", "hmo_org_id");--> statement-breakpoint
-- Claims and settlements stay with the HMO-provider pair of the visit.
ALTER TABLE "claims" ADD CONSTRAINT "claims_authorization_owner_fk" FOREIGN KEY ("authorization_id", "hmo_org_id", "provider_org_id") REFERENCES "authorizations" ("id", "hmo_org_id", "provider_org_id");--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_contract_fk" FOREIGN KEY ("hmo_org_id", "provider_org_id") REFERENCES "hmo_provider_contracts" ("hmo_org_id", "provider_org_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_settlement_item_owner() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM settlements s JOIN claims c ON c.hmo_org_id = s.hmo_org_id AND c.provider_org_id = s.provider_org_id
    WHERE s.id = NEW.settlement_id AND c.id = NEW.claim_id
  ) THEN
    RAISE EXCEPTION 'claim % does not belong to the settlement''s HMO and provider', NEW.claim_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER settlement_items_owner BEFORE INSERT OR UPDATE ON "settlement_items" FOR EACH ROW EXECUTE FUNCTION enforce_settlement_item_owner();--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_owner_fk" FOREIGN KEY ("import_job_id", "hmo_org_id") REFERENCES "import_jobs" ("id", "hmo_org_id");--> statement-breakpoint

-- ───────────── 5. HMO-provider relationships: never deleted, every change recorded by the database ─────────────
-- Ending a relationship = status SUSPENDED (contract / branch) or ENDED (tariff), which keeps history.
CREATE OR REPLACE FUNCTION audit_relationship_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows cannot be deleted; suspend or end them instead', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit_events (org_id, actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    NEW.hmo_org_id, NULL, 'db.' || TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME, NEW.id::text,
    jsonb_build_object(
      'providerOrgId', NEW.provider_org_id,
      'status', NEW.status,
      'previousStatus', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> 'status' END,
      'source', 'database-trigger'
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER hmo_provider_contracts_audit AFTER INSERT OR UPDATE ON "hmo_provider_contracts" FOR EACH ROW EXECUTE FUNCTION audit_relationship_change();--> statement-breakpoint
CREATE TRIGGER hmo_provider_contracts_no_delete BEFORE DELETE ON "hmo_provider_contracts" FOR EACH ROW EXECUTE FUNCTION audit_relationship_change();--> statement-breakpoint
CREATE TRIGGER network_locations_audit AFTER INSERT OR UPDATE ON "network_locations" FOR EACH ROW EXECUTE FUNCTION audit_relationship_change();--> statement-breakpoint
CREATE TRIGGER network_locations_no_delete BEFORE DELETE ON "network_locations" FOR EACH ROW EXECUTE FUNCTION audit_relationship_change();--> statement-breakpoint
CREATE TRIGGER provider_benefit_assignments_audit AFTER INSERT OR UPDATE ON "provider_benefit_assignments" FOR EACH ROW EXECUTE FUNCTION audit_relationship_change();--> statement-breakpoint
CREATE TRIGGER provider_benefit_assignments_no_delete BEFORE DELETE ON "provider_benefit_assignments" FOR EACH ROW EXECUTE FUNCTION audit_relationship_change();--> statement-breakpoint

-- ───────────── 6. Check-ins: one in-progress check-in per member + benefit + branch ─────────────
-- Open intents whose time already ran out are closed first (exactly what housekeeping does), and
-- the count is recorded, so the index below only sees live check-ins.
WITH closed AS (
  UPDATE visit_intents SET status = 'EXPIRED'
  WHERE status IN ('PENDING_CONFIRMATION','CONFIRMED') AND expires_at <= now()
  RETURNING id
)
INSERT INTO audit_events (org_id, actor_user_id, action, entity_type, entity_id, metadata)
SELECT NULL, NULL, 'migration.0006.expired_stale_visit_intents', 'visit_intent', NULL, jsonb_build_object('count', count(*))
FROM closed HAVING count(*) > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_intents_one_open_uq" ON "visit_intents" ("member_id", "benefit_id", "location_id") WHERE "status" IN ('PENDING_CONFIRMATION', 'CONFIRMED');--> statement-breakpoint
CREATE INDEX "authorizations_member_benefit_time_idx" ON "authorizations" ("member_id", "benefit_id", "authorized_at");--> statement-breakpoint

-- ───────────── 7. Queue and import staging values ─────────────
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_status_valid" CHECK ("status" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED') AND "attempts" >= 0 AND "max_attempts" > 0);--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_values_valid" CHECK (
  "status" IN ('PENDING','APPLIED','HELD','FAILED')
  AND "classification" IN ('NEW','UPDATE','UNCHANGED','CONFLICT')
  AND "row_number" >= 1
);--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_counts_valid" CHECK (
  "total_rows" >= 0 AND "valid_rows" >= 0 AND "error_rows" >= 0 AND "processed_rows" >= 0
  AND "applied_rows" >= 0 AND "failed_rows" >= 0 AND "held_rows" >= 0
);
