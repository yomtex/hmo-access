CREATE TYPE "public"."active_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('ACTIVE', 'ENDED');--> statement-breakpoint
CREATE TYPE "public"."authorization_status" AS ENUM('AUTHORIZED', 'COMPLETED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'DISPUTED', 'SETTLED');--> statement-breakpoint
CREATE TYPE "public"."coverage_status" AS ENUM('ACTIVE', 'SUSPENDED', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('CARD', 'EPHEMERAL');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."eligibility_decision" AS ENUM('ELIGIBLE', 'INELIGIBLE', 'UNVERIFIABLE');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('PREVIEWED', 'APPLIED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."integration_kind" AS ENUM('CSV_UPLOAD', 'REST_API', 'WEBHOOK', 'FHIR', 'SCHEDULED_FILE');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('ACTIVE', 'DISABLED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."lookup_method" AS ENUM('QR', 'MEMBER_REF', 'MEMBER_NUMBER');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('ACTIVE', 'SUSPENDED', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."network_status" AS ENUM('PENDING', 'APPROVED', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."org_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('PLATFORM', 'HMO', 'PROVIDER');--> statement-breakpoint
CREATE TYPE "public"."otp_purpose" AS ENUM('VISIT_CONFIRMATION', 'MEMBER_ACCESS');--> statement-breakpoint
CREATE TYPE "public"."otp_status" AS ENUM('PENDING', 'SENT', 'SEND_FAILED', 'VERIFIED', 'EXPIRED', 'LOCKED');--> statement-breakpoint
CREATE TYPE "public"."service_approval_status" AS ENUM('APPROVED', 'USED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."service_approval_type" AS ENUM('REFERRAL', 'PREAUTHORIZATION');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('DRAFT', 'APPROVED', 'PAID', 'RECONCILED', 'RECONCILIATION_MISMATCH', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."usage_status" AS ENUM('CONSUMED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('DRAFT', 'PUBLISHED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."visit_intent_status" AS ENUM('PENDING_CONFIRMATION', 'CONFIRMED', 'AUTHORIZED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"benefit_id" uuid NOT NULL,
	"benefit_version_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"plan_membership_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"visit_intent_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "authorization_status" DEFAULT 'AUTHORIZED' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"tariff_minor" integer NOT NULL,
	"copay_minor" integer NOT NULL,
	"payable_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"evaluation" jsonb NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"authorized_by_id" uuid NOT NULL,
	CONSTRAINT "authorizations_reference_unique" UNIQUE("reference"),
	CONSTRAINT "authorizations_visit_intent_id_unique" UNIQUE("visit_intent_id")
);
--> statement-breakpoint
CREATE TABLE "benefit_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"benefit_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"used_at" timestamp with time zone NOT NULL,
	"status" "usage_status" DEFAULT 'CONSUMED' NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	CONSTRAINT "benefit_usage_authorization_id_unique" UNIQUE("authorization_id")
);
--> statement-breakpoint
CREATE TABLE "benefit_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"benefit_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "version_status" DEFAULT 'DRAFT' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"rules" jsonb NOT NULL,
	"terms" text,
	"published_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benefits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"delta_minor" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"benefit_version_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"service_date" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"tariff_minor" integer NOT NULL,
	"copay_minor" integer NOT NULL,
	"claimed_amount_minor" integer NOT NULL,
	"approved_amount_minor" integer,
	"status" "claim_status" DEFAULT 'SUBMITTED' NOT NULL,
	"evidence" jsonb,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"rejection_reason" text,
	"dispute_reason" text,
	"disputed_at" timestamp with time zone,
	"settlement_id" uuid,
	CONSTRAINT "claims_reference_unique" UNIQUE("reference"),
	CONSTRAINT "claims_authorization_id_unique" UNIQUE("authorization_id")
);
--> statement-breakpoint
CREATE TABLE "eligibility_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid,
	"provider_org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"member_id" uuid,
	"benefit_id" uuid,
	"benefit_version_id" uuid,
	"plan_version_id" uuid,
	"lookup_method" "lookup_method" NOT NULL,
	"decision" "eligibility_decision" NOT NULL,
	"reason_codes" text[] DEFAULT '{}' NOT NULL,
	"remaining" jsonb,
	"duration_ms" integer,
	"requested_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hmo_profiles" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"contact_email" text,
	"stale_data_threshold_hours" integer DEFAULT 168 NOT NULL,
	"unverifiable_policy" text DEFAULT 'DENY' NOT NULL,
	"last_member_data_refresh_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hmo_provider_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"status" "network_status" DEFAULT 'PENDING' NOT NULL,
	"settlement_terms_days" integer DEFAULT 30 NOT NULL,
	"settlement_terms_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"applied_file_sha" text,
	"status" "import_status" DEFAULT 'PREVIEWED' NOT NULL,
	"mapping" jsonb NOT NULL,
	"total_rows" integer NOT NULL,
	"valid_rows" integer NOT NULL,
	"error_rows" integer NOT NULL,
	"errors" jsonb NOT NULL,
	"staged_rows" jsonb,
	"summary" jsonb,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"kind" "integration_kind" NOT NULL,
	"name" text NOT NULL,
	"status" "integration_status" DEFAULT 'DISABLED' NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ref" text,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"status" "credential_status" DEFAULT 'ACTIVE' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "member_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"member_number" text NOT NULL,
	"short_ref" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone_enc" text,
	"phone_hash" text,
	"phone_last4" text,
	"status" "member_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"source_import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_short_ref_unique" UNIQUE("short_ref")
);
--> statement-breakpoint
CREATE TABLE "network_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" "network_status" DEFAULT 'APPROVED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid,
	"member_id" uuid,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"status" "active_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "org_type" NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "org_status" DEFAULT 'ACTIVE' NOT NULL,
	"timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "otp_purpose" NOT NULL,
	"member_id" uuid NOT NULL,
	"visit_intent_id" uuid,
	"provider_org_id" uuid,
	"code_hash" text NOT NULL,
	"status" "otp_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"send_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"coverage_start" timestamp with time zone NOT NULL,
	"coverage_end" timestamp with time zone,
	"status" "coverage_status" DEFAULT 'ACTIVE' NOT NULL,
	"member_group" text,
	"source_import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_version_benefits" (
	"plan_version_id" uuid NOT NULL,
	"benefit_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"member_groups" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "plan_version_benefits_plan_version_id_benefit_id_pk" PRIMARY KEY("plan_version_id","benefit_id")
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "version_status" DEFAULT 'DRAFT' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"notes" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_benefit_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"benefit_id" uuid NOT NULL,
	"location_id" uuid,
	"tariff_minor" integer NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"status" "assignment_status" DEFAULT 'ACTIVE' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"status" "active_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_profiles" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"provider_type" text NOT NULL,
	"contact_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_staff_locations" (
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "provider_staff_locations_membership_id_location_id_pk" PRIMARY KEY("membership_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_key" text NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_key_permission_key_pk" PRIMARY KEY("role_key","permission_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"key" text PRIMARY KEY NOT NULL,
	"org_type" "org_type" NOT NULL,
	"name" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "service_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"benefit_id" uuid NOT NULL,
	"provider_org_id" uuid,
	"type" "service_approval_type" NOT NULL,
	"reference" text NOT NULL,
	"status" "service_approval_status" DEFAULT 'APPROVED' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"active_org_id" uuid,
	"active_location_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settlement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	CONSTRAINT "settlement_items_claim_id_unique" UNIQUE("claim_id")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"status" "settlement_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" text NOT NULL,
	"total_minor" integer NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"due_date" timestamp with time zone,
	"payment_reference" text,
	"payment_method" text,
	"paid_amount_minor" integer,
	"paid_at" timestamp with time zone,
	"payment_recorded_by_id" uuid,
	"statement_reference" text,
	"confirmed_amount_minor" integer,
	"reconciled_at" timestamp with time zone,
	"reconciled_by_id" uuid,
	"provider_confirmed_at" timestamp with time zone,
	"notes" text,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "active_status" DEFAULT 'ACTIVE' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "visit_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"benefit_id" uuid NOT NULL,
	"eligibility_check_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"confirmation_method" text NOT NULL,
	"status" "visit_intent_status" DEFAULT 'PENDING_CONFIRMATION' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_intents_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_location_id_provider_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."provider_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_benefit_id_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_benefit_version_id_benefit_versions_id_fk" FOREIGN KEY ("benefit_version_id") REFERENCES "public"."benefit_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_plan_membership_id_plan_memberships_id_fk" FOREIGN KEY ("plan_membership_id") REFERENCES "public"."plan_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_assignment_id_provider_benefit_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."provider_benefit_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_visit_intent_id_visit_intents_id_fk" FOREIGN KEY ("visit_intent_id") REFERENCES "public"."visit_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_authorized_by_id_users_id_fk" FOREIGN KEY ("authorized_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_usage" ADD CONSTRAINT "benefit_usage_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_usage" ADD CONSTRAINT "benefit_usage_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_usage" ADD CONSTRAINT "benefit_usage_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_usage" ADD CONSTRAINT "benefit_usage_benefit_id_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_versions" ADD CONSTRAINT "benefit_versions_benefit_id_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_versions" ADD CONSTRAINT "benefit_versions_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefits" ADD CONSTRAINT "benefits_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_adjustments" ADD CONSTRAINT "claim_adjustments_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_adjustments" ADD CONSTRAINT "claim_adjustments_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_adjustments" ADD CONSTRAINT "claim_adjustments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_benefit_version_id_benefit_versions_id_fk" FOREIGN KEY ("benefit_version_id") REFERENCES "public"."benefit_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_location_id_provider_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."provider_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_benefit_id_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_benefit_version_id_benefit_versions_id_fk" FOREIGN KEY ("benefit_version_id") REFERENCES "public"."benefit_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmo_profiles" ADD CONSTRAINT "hmo_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmo_provider_contracts" ADD CONSTRAINT "hmo_provider_contracts_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmo_provider_contracts" ADD CONSTRAINT "hmo_provider_contracts_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_configs" ADD CONSTRAINT "integration_configs_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_credentials" ADD CONSTRAINT "member_credentials_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_credentials" ADD CONSTRAINT "member_credentials_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_locations" ADD CONSTRAINT "network_locations_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_locations" ADD CONSTRAINT "network_locations_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_locations" ADD CONSTRAINT "network_locations_location_id_provider_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."provider_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_visit_intent_id_visit_intents_id_fk" FOREIGN KEY ("visit_intent_id") REFERENCES "public"."visit_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_memberships" ADD CONSTRAINT "plan_memberships_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_memberships" ADD CONSTRAINT "plan_memberships_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_memberships" ADD CONSTRAINT "plan_memberships_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version_benefits" ADD CONSTRAINT "plan_version_benefits_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version_benefits" ADD CONSTRAINT "plan_version_benefits_benefit_id_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version_benefits" ADD CONSTRAINT "plan_version_benefits_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "provider_benefit_assignments_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "provider_benefit_assignments_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "provider_benefit_assignments_benefit_id_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_benefit_assignments" ADD CONSTRAINT "provider_benefit_assignments_location_id_provider_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."provider_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_locations" ADD CONSTRAINT "provider_locations_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_staff_locations" ADD CONSTRAINT "provider_staff_locations_membership_id_organization_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."organization_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_staff_locations" ADD CONSTRAINT "provider_staff_locations_location_id_provider_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."provider_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_benefit_id_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_org_id_organizations_id_fk" FOREIGN KEY ("active_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_location_id_provider_locations_id_fk" FOREIGN KEY ("active_location_id") REFERENCES "public"."provider_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payment_recorded_by_id_users_id_fk" FOREIGN KEY ("payment_recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_reconciled_by_id_users_id_fk" FOREIGN KEY ("reconciled_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_location_id_provider_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."provider_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_benefit_id_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_eligibility_check_id_eligibility_checks_id_fk" FOREIGN KEY ("eligibility_check_id") REFERENCES "public"."eligibility_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_intents" ADD CONSTRAINT "visit_intents_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_integration_id_integration_configs_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_org_idx" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "authorizations_provider_idem_uq" ON "authorizations" USING btree ("provider_org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "authorizations_hmo_idx" ON "authorizations" USING btree ("hmo_org_id","authorized_at");--> statement-breakpoint
CREATE INDEX "authorizations_member_benefit_idx" ON "authorizations" USING btree ("member_id","benefit_id");--> statement-breakpoint
CREATE INDEX "benefit_usage_member_benefit_idx" ON "benefit_usage" USING btree ("member_id","benefit_id","used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_versions_benefit_version_uq" ON "benefit_versions" USING btree ("benefit_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "benefits_hmo_code_uq" ON "benefits" USING btree ("hmo_org_id","code");--> statement-breakpoint
CREATE INDEX "claim_adjustments_claim_idx" ON "claim_adjustments" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "claims_hmo_status_idx" ON "claims" USING btree ("hmo_org_id","status");--> statement-breakpoint
CREATE INDEX "claims_provider_status_idx" ON "claims" USING btree ("provider_org_id","status");--> statement-breakpoint
CREATE INDEX "eligibility_checks_provider_idx" ON "eligibility_checks" USING btree ("provider_org_id","created_at");--> statement-breakpoint
CREATE INDEX "eligibility_checks_hmo_idx" ON "eligibility_checks" USING btree ("hmo_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hmo_provider_contracts_uq" ON "hmo_provider_contracts" USING btree ("hmo_org_id","provider_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_jobs_hmo_applied_sha_uq" ON "import_jobs" USING btree ("hmo_org_id","applied_file_sha");--> statement-breakpoint
CREATE INDEX "import_jobs_hmo_idx" ON "import_jobs" USING btree ("hmo_org_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_configs_hmo_idx" ON "integration_configs" USING btree ("hmo_org_id");--> statement-breakpoint
CREATE INDEX "member_credentials_member_idx" ON "member_credentials" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_hmo_number_uq" ON "members" USING btree ("hmo_org_id","member_number");--> statement-breakpoint
CREATE UNIQUE INDEX "network_locations_hmo_location_uq" ON "network_locations" USING btree ("hmo_org_id","location_id");--> statement-breakpoint
CREATE INDEX "notification_events_hmo_idx" ON "notification_events" USING btree ("hmo_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_membership_user_org_uq" ON "organization_memberships" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "org_membership_org_idx" ON "organization_memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "otp_challenges_intent_idx" ON "otp_challenges" USING btree ("visit_intent_id");--> statement-breakpoint
CREATE INDEX "otp_challenges_member_idx" ON "otp_challenges" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_memberships_member_plan_start_uq" ON "plan_memberships" USING btree ("member_id","plan_id","coverage_start");--> statement-breakpoint
CREATE INDEX "plan_memberships_hmo_idx" ON "plan_memberships" USING btree ("hmo_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_plan_version_uq" ON "plan_versions" USING btree ("plan_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_hmo_code_uq" ON "plans" USING btree ("hmo_org_id","code");--> statement-breakpoint
CREATE INDEX "pba_hmo_provider_benefit_idx" ON "provider_benefit_assignments" USING btree ("hmo_org_id","provider_org_id","benefit_id");--> statement-breakpoint
CREATE INDEX "provider_locations_provider_idx" ON "provider_locations" USING btree ("provider_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_approvals_hmo_ref_uq" ON "service_approvals" USING btree ("hmo_org_id","reference");--> statement-breakpoint
CREATE INDEX "service_approvals_member_benefit_idx" ON "service_approvals" USING btree ("member_id","benefit_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_hmo_payment_ref_uq" ON "settlements" USING btree ("hmo_org_id","payment_reference");--> statement-breakpoint
CREATE INDEX "settlements_hmo_status_idx" ON "settlements" USING btree ("hmo_org_id","status");--> statement-breakpoint
CREATE INDEX "settlements_provider_status_idx" ON "settlements" USING btree ("provider_org_id","status");--> statement-breakpoint
CREATE INDEX "visit_intents_provider_idx" ON "visit_intents" USING btree ("provider_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_integration_external_uq" ON "webhook_events" USING btree ("integration_id","external_event_id");