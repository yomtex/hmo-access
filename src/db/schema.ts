/**
 * HMO Access — database schema (PostgreSQL, Drizzle ORM)
 *
 * Conventions
 * - Every tenant-owned row carries the owning HMO and/or provider organization id.
 *   Services MUST scope queries by the authenticated actor's organization (src/lib/server/auth).
 * - Money is an integer number of minor units (kobo for NGN) plus an ISO-4217 currency code.
 * - Published plan/benefit versions and provider tariffs are never edited in place.
 * - audit_events is append-only (enforced by a trigger in drizzle/0001_integrity.sql).
 * - Further CHECK constraints live in drizzle/0001_integrity.sql.
 */
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ───────────────────────────── Enums ─────────────────────────────
export const orgType = pgEnum("org_type", ["PLATFORM", "HMO", "PROVIDER"]);
export const orgStatus = pgEnum("org_status", ["PENDING", "ACTIVE", "SUSPENDED"]);
export const activeStatus = pgEnum("active_status", ["ACTIVE", "INACTIVE"]);
export const memberStatus = pgEnum("member_status", ["ACTIVE", "SUSPENDED", "TERMINATED"]);
export const credentialStatus = pgEnum("credential_status", ["ACTIVE", "REVOKED"]);
export const credentialKind = pgEnum("credential_kind", ["CARD", "EPHEMERAL"]);
export const versionStatus = pgEnum("version_status", ["DRAFT", "PUBLISHED", "RETIRED"]);
export const coverageStatus = pgEnum("coverage_status", ["ACTIVE", "SUSPENDED", "TERMINATED"]);
export const serviceApprovalType = pgEnum("service_approval_type", ["REFERRAL", "PREAUTHORIZATION"]);
export const serviceApprovalStatus = pgEnum("service_approval_status", ["APPROVED", "USED", "REVOKED"]);
export const networkStatus = pgEnum("network_status", ["PENDING", "APPROVED", "SUSPENDED"]);
export const assignmentStatus = pgEnum("assignment_status", ["ACTIVE", "ENDED"]);
export const eligibilityDecision = pgEnum("eligibility_decision", ["ELIGIBLE", "INELIGIBLE", "UNVERIFIABLE"]);
export const lookupMethod = pgEnum("lookup_method", ["QR", "MEMBER_REF", "MEMBER_NUMBER"]);
export const visitIntentStatus = pgEnum("visit_intent_status", [
  "PENDING_CONFIRMATION",
  "CONFIRMED",
  "AUTHORIZED",
  "EXPIRED",
  "CANCELLED",
]);
export const otpPurpose = pgEnum("otp_purpose", ["VISIT_CONFIRMATION", "MEMBER_ACCESS"]);
export const otpStatus = pgEnum("otp_status", ["PENDING", "SENT", "SEND_FAILED", "VERIFIED", "EXPIRED", "LOCKED"]);
export const authorizationStatus = pgEnum("authorization_status", ["AUTHORIZED", "COMPLETED", "CANCELLED", "EXPIRED"]);
export const usageStatus = pgEnum("usage_status", ["CONSUMED", "REVERSED"]);
export const claimStatus = pgEnum("claim_status", [
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "DISPUTED",
  "SETTLED",
]);
export const settlementStatus = pgEnum("settlement_status", [
  "DRAFT",
  "APPROVED",
  "AWAITING_PAYMENT",
  "PAID",
  "RECONCILED",
  "RECONCILIATION_MISMATCH",
  "CANCELLED",
]);
export const importStatus = pgEnum("import_status", ["PREVIEWED", "APPLIED", "FAILED", "CANCELLED", "QUEUED", "PROCESSING", "PARTIALLY_APPLIED"]);
export const integrationKind = pgEnum("integration_kind", ["CSV_UPLOAD", "REST_API", "WEBHOOK", "FHIR", "SCHEDULED_FILE"]);
export const integrationStatus = pgEnum("integration_status", ["ACTIVE", "DISABLED", "ERROR"]);

// ───────────────────────────── Organizations & identity ─────────────────────────────
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: orgType("type").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: orgStatus("status").notNull().default("ACTIVE"),
  timezone: text("timezone").notNull().default("Africa/Lagos"),
  createdAt: createdAt(),
});

export const hmoProfiles = pgTable("hmo_profiles", {
  orgId: uuid("org_id").primaryKey().references(() => organizations.id),
  contactEmail: text("contact_email"),
  /** Eligibility based on imported data older than this is UNVERIFIABLE (fail-closed). */
  staleDataThresholdHours: integer("stale_data_threshold_hours").notNull().default(168),
  /** Only "DENY" is implemented. Other fallbacks need a documented, HMO-authorized policy. */
  unverifiablePolicy: text("unverifiable_policy").notNull().default("DENY"),
  lastMemberDataRefreshAt: ts("last_member_data_refresh_at"),
  createdAt: createdAt(),
});

export const providerProfiles = pgTable("provider_profiles", {
  orgId: uuid("org_id").primaryKey().references(() => organizations.id),
  providerType: text("provider_type").notNull(), // GYM, PHYSIOTHERAPY, CLINIC, ...
  contactEmail: text("contact_email"),
  createdAt: createdAt(),
});

export const providerLocations = pgTable(
  "provider_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    address: text("address"),
    city: text("city"),
    status: activeStatus("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
  },
  (t) => [index("provider_locations_provider_idx").on(t.providerOrgId)],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  status: activeStatus("status").notNull().default("ACTIVE"),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: ts("locked_until"),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
});

export const roles = pgTable("roles", {
  key: text("key").primaryKey(),
  orgType: orgType("org_type").notNull(),
  name: text("name").notNull(),
  description: text("description"),
});

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleKey: text("role_key").notNull().references(() => roles.key),
    permissionKey: text("permission_key").notNull().references(() => permissions.key),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    roleKey: text("role_key").notNull().references(() => roles.key),
    status: activeStatus("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("org_membership_user_org_uq").on(t.userId, t.orgId), index("org_membership_org_idx").on(t.orgId)],
);

/** Which provider branches a provider staff membership may act for. */
export const providerStaffLocations = pgTable(
  "provider_staff_locations",
  {
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").notNull().references(() => providerLocations.id),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.locationId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id").notNull().references(() => users.id),
    activeOrgId: uuid("active_org_id").references(() => organizations.id),
    activeLocationId: uuid("active_location_id").references(() => providerLocations.id),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// ───────────────────────────── Members & credentials ─────────────────────────────
export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    memberNumber: text("member_number").notNull(), // the HMO's own enrollee identifier
    shortRef: text("short_ref").notNull().unique(), // platform reference for manual lookup
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phoneEnc: text("phone_enc"), // AES-256-GCM ciphertext
    phoneHash: text("phone_hash"), // HMAC for equality checks
    phoneLast4: text("phone_last4"), // masked display
    status: memberStatus("status").notNull().default("ACTIVE"),
    lastSyncedAt: ts("last_synced_at").notNull(),
    sourceImportId: uuid("source_import_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("members_hmo_number_uq").on(t.hmoOrgId, t.memberNumber),
    // Case-insensitive uniqueness of member numbers lives in drizzle/0006_isolation_and_checkins.sql.
    index("members_hmo_phone_idx").on(t.hmoOrgId, t.phoneHash),
  ],
);

export const memberCredentials = pgTable(
  "member_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id").notNull().references(() => members.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    kind: credentialKind("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(), // HMAC of the random token; the token is never stored
    status: credentialStatus("status").notNull().default("ACTIVE"),
    issuedAt: ts("issued_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    revokedReason: text("revoked_reason"),
    lastUsedAt: ts("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
  },
  (t) => [index("member_credentials_member_idx").on(t.memberId)],
);

// ───────────────────────────── Plans & benefits ─────────────────────────────
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("plans_hmo_code_uq").on(t.hmoOrgId, t.code)],
);

export const planVersions = pgTable(
  "plan_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull().references(() => plans.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    version: integer("version").notNull(),
    status: versionStatus("status").notNull().default("DRAFT"),
    effectiveFrom: ts("effective_from").notNull(),
    effectiveTo: ts("effective_to"),
    notes: text("notes"),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("plan_versions_plan_version_uq").on(t.planId, t.version)],
);

export const benefits = pgTable(
  "benefits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("benefits_hmo_code_uq").on(t.hmoOrgId, t.code)],
);

export const benefitVersions = pgTable(
  "benefit_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    benefitId: uuid("benefit_id").notNull().references(() => benefits.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    version: integer("version").notNull(),
    status: versionStatus("status").notNull().default("DRAFT"),
    effectiveFrom: ts("effective_from").notNull(),
    effectiveTo: ts("effective_to"),
    /** Validated against BenefitRulesSchema (src/lib/domain/benefit-rules.ts) on every write. */
    rules: jsonb("rules").notNull(),
    terms: text("terms"),
    publishedAt: ts("published_at"),
    createdById: uuid("created_by_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("benefit_versions_benefit_version_uq").on(t.benefitId, t.version)],
);

/** Assigns a benefit to a plan version, optionally restricted to member groups. */
export const planVersionBenefits = pgTable(
  "plan_version_benefits",
  {
    planVersionId: uuid("plan_version_id").notNull().references(() => planVersions.id),
    benefitId: uuid("benefit_id").notNull().references(() => benefits.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    memberGroups: text("member_groups").array().notNull().default([]), // empty = every group on the plan
  },
  (t) => [primaryKey({ columns: [t.planVersionId, t.benefitId] })],
);

export const planMemberships = pgTable(
  "plan_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id").notNull().references(() => members.id),
    planId: uuid("plan_id").notNull().references(() => plans.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    coverageStart: ts("coverage_start").notNull(),
    coverageEnd: ts("coverage_end"),
    status: coverageStatus("status").notNull().default("ACTIVE"),
    memberGroup: text("member_group"),
    sourceImportId: uuid("source_import_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("plan_memberships_member_plan_start_uq").on(t.memberId, t.planId, t.coverageStart),
    index("plan_memberships_hmo_idx").on(t.hmoOrgId),
  ],
);

/** HMO-issued referral / pre-authorization, required only when a benefit's rules say so. */
export const serviceApprovals = pgTable(
  "service_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    benefitId: uuid("benefit_id").notNull().references(() => benefits.id),
    providerOrgId: uuid("provider_org_id").references(() => organizations.id),
    type: serviceApprovalType("type").notNull(),
    reference: text("reference").notNull(),
    status: serviceApprovalStatus("status").notNull().default("APPROVED"),
    validFrom: ts("valid_from").notNull(),
    validTo: ts("valid_to").notNull(),
    createdById: uuid("created_by_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("service_approvals_hmo_ref_uq").on(t.hmoOrgId, t.reference),
    index("service_approvals_member_benefit_idx").on(t.memberId, t.benefitId),
  ],
);

// ───────────────────────────── Provider network & tariffs ─────────────────────────────
export const hmoProviderContracts = pgTable(
  "hmo_provider_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    status: networkStatus("status").notNull().default("PENDING"),
    settlementTermsDays: integer("settlement_terms_days").notNull().default(30),
    settlementTermsNotes: text("settlement_terms_notes"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("hmo_provider_contracts_uq").on(t.hmoOrgId, t.providerOrgId)],
);

export const networkLocations = pgTable(
  "network_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    locationId: uuid("location_id").notNull().references(() => providerLocations.id),
    status: networkStatus("status").notNull().default("APPROVED"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("network_locations_hmo_location_uq").on(t.hmoOrgId, t.locationId)],
);

/** Provider-specific tariff for a benefit. Never edited: a change ends this row and inserts a new one. */
export const providerBenefitAssignments = pgTable(
  "provider_benefit_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    benefitId: uuid("benefit_id").notNull().references(() => benefits.id),
    locationId: uuid("location_id").references(() => providerLocations.id), // null = all approved locations
    tariffMinor: integer("tariff_minor").notNull(),
    currency: text("currency").notNull().default("NGN"),
    status: assignmentStatus("status").notNull().default("ACTIVE"),
    effectiveFrom: ts("effective_from").notNull(),
    effectiveTo: ts("effective_to"),
    createdById: uuid("created_by_id"),
    createdAt: createdAt(),
  },
  (t) => [index("pba_hmo_provider_benefit_idx").on(t.hmoOrgId, t.providerOrgId, t.benefitId)],
);

// ───────────────────────────── Verification flow ─────────────────────────────
export const eligibilityChecks = pgTable(
  "eligibility_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    locationId: uuid("location_id").notNull().references(() => providerLocations.id),
    memberId: uuid("member_id").references(() => members.id),
    benefitId: uuid("benefit_id").references(() => benefits.id),
    benefitVersionId: uuid("benefit_version_id").references(() => benefitVersions.id),
    planVersionId: uuid("plan_version_id").references(() => planVersions.id),
    lookupMethod: lookupMethod("lookup_method").notNull(),
    decision: eligibilityDecision("decision").notNull(),
    reasonCodes: text("reason_codes").array().notNull().default([]),
    remaining: jsonb("remaining"),
    durationMs: integer("duration_ms"),
    requestedById: uuid("requested_by_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("eligibility_checks_provider_idx").on(t.providerOrgId, t.createdAt),
    index("eligibility_checks_hmo_idx").on(t.hmoOrgId, t.createdAt),
  ],
);

export const visitIntents = pgTable(
  "visit_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull().unique(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    locationId: uuid("location_id").notNull().references(() => providerLocations.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    benefitId: uuid("benefit_id").notNull().references(() => benefits.id),
    eligibilityCheckId: uuid("eligibility_check_id").notNull().references(() => eligibilityChecks.id),
    quantity: integer("quantity").notNull().default(1),
    confirmationMethod: text("confirmation_method").notNull(), // OTP | NONE
    status: visitIntentStatus("status").notNull().default("PENDING_CONFIRMATION"),
    confirmedAt: ts("confirmed_at"),
    expiresAt: ts("expires_at").notNull(),
    createdById: uuid("created_by_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("visit_intents_provider_idx").on(t.providerOrgId, t.createdAt)],
);

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: otpPurpose("purpose").notNull(),
    memberId: uuid("member_id").notNull().references(() => members.id),
    visitIntentId: uuid("visit_intent_id").references(() => visitIntents.id),
    providerOrgId: uuid("provider_org_id").references(() => organizations.id),
    codeHash: text("code_hash").notNull(), // HMAC(secret, challengeId:code); code never stored
    status: otpStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    sendCount: integer("send_count").notNull().default(0),
    lastSentAt: ts("last_sent_at"),
    expiresAt: ts("expires_at").notNull(),
    verifiedAt: ts("verified_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("otp_challenges_intent_idx").on(t.visitIntentId),
    index("otp_challenges_member_idx").on(t.memberId, t.createdAt),
  ],
);

export const authorizations = pgTable(
  "authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull().unique(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    locationId: uuid("location_id").notNull().references(() => providerLocations.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    benefitId: uuid("benefit_id").notNull().references(() => benefits.id),
    benefitVersionId: uuid("benefit_version_id").notNull().references(() => benefitVersions.id),
    planId: uuid("plan_id").notNull().references(() => plans.id),
    planVersionId: uuid("plan_version_id").notNull().references(() => planVersions.id),
    planMembershipId: uuid("plan_membership_id").notNull().references(() => planMemberships.id),
    assignmentId: uuid("assignment_id").notNull().references(() => providerBenefitAssignments.id),
    visitIntentId: uuid("visit_intent_id").notNull().unique().references(() => visitIntents.id),
    idempotencyKey: text("idempotency_key").notNull(),
    status: authorizationStatus("status").notNull().default("AUTHORIZED"),
    quantity: integer("quantity").notNull().default(1),
    tariffMinor: integer("tariff_minor").notNull(),
    copayMinor: integer("copay_minor").notNull(),
    payableMinor: integer("payable_minor").notNull(),
    currency: text("currency").notNull(),
    /** Rule snapshot + usage snapshot at authorization time. */
    evaluation: jsonb("evaluation").notNull(),
    authorizedAt: ts("authorized_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    completedAt: ts("completed_at"),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
    authorizedById: uuid("authorized_by_id").notNull().references(() => users.id),
  },
  (t) => [
    uniqueIndex("authorizations_provider_idem_uq").on(t.providerOrgId, t.idempotencyKey),
    index("authorizations_hmo_idx").on(t.hmoOrgId, t.authorizedAt),
    index("authorizations_member_benefit_idx").on(t.memberId, t.benefitId),
  ],
);

export const benefitUsage = pgTable(
  "benefit_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorizationId: uuid("authorization_id").notNull().unique().references(() => authorizations.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    benefitId: uuid("benefit_id").notNull().references(() => benefits.id),
    quantity: integer("quantity").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    usedAt: ts("used_at").notNull(),
    status: usageStatus("status").notNull().default("CONSUMED"),
    reversedAt: ts("reversed_at"),
    reversalReason: text("reversal_reason"),
  },
  (t) => [index("benefit_usage_member_benefit_idx").on(t.memberId, t.benefitId, t.usedAt)],
);

// ───────────────────────────── Claims & settlement ─────────────────────────────
export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull().unique(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    authorizationId: uuid("authorization_id").notNull().unique().references(() => authorizations.id),
    benefitVersionId: uuid("benefit_version_id").notNull().references(() => benefitVersions.id),
    planVersionId: uuid("plan_version_id").notNull().references(() => planVersions.id),
    serviceDate: ts("service_date").notNull(),
    currency: text("currency").notNull(),
    tariffMinor: integer("tariff_minor").notNull(),
    copayMinor: integer("copay_minor").notNull(),
    claimedAmountMinor: integer("claimed_amount_minor").notNull(),
    approvedAmountMinor: integer("approved_amount_minor"),
    status: claimStatus("status").notNull().default("SUBMITTED"),
    evidence: jsonb("evidence"),
    submittedAt: ts("submitted_at").notNull().defaultNow(),
    reviewedAt: ts("reviewed_at"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    rejectionReason: text("rejection_reason"),
    disputeReason: text("dispute_reason"),
    disputedAt: ts("disputed_at"),
    settlementId: uuid("settlement_id"),
  },
  (t) => [index("claims_hmo_status_idx").on(t.hmoOrgId, t.status), index("claims_provider_status_idx").on(t.providerOrgId, t.status)],
);

export const claimAdjustments = pgTable(
  "claim_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id").notNull().references(() => claims.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    deltaMinor: integer("delta_minor").notNull(),
    reason: text("reason").notNull(),
    createdById: uuid("created_by_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("claim_adjustments_claim_idx").on(t.claimId)],
);

export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull().unique(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    status: settlementStatus("status").notNull().default("DRAFT"),
    currency: text("currency").notNull(),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    dueDate: ts("due_date"),
    paymentReference: text("payment_reference"),
    paymentMethod: text("payment_method"),
    paidAmountMinor: bigint("paid_amount_minor", { mode: "number" }),
    paidAt: ts("paid_at"),
    paymentRecordedById: uuid("payment_recorded_by_id").references(() => users.id),
    statementReference: text("statement_reference"),
    confirmedAmountMinor: bigint("confirmed_amount_minor", { mode: "number" }),
    reconciledAt: ts("reconciled_at"),
    reconciledById: uuid("reconciled_by_id").references(() => users.id),
    providerConfirmedAt: ts("provider_confirmed_at"),
    /** NONE until paid; BANK_VERIFIED when matched to partner-verified credits; MANUAL_UNVERIFIED when typed in by the HMO. */
    verification: text("verification").notNull().default("NONE"),
    /** Sum of verified bank credits matched to this settlement. */
    receivedMinor: bigint("received_minor", { mode: "number" }).notNull().default(0),
    collectionAccountId: uuid("collection_account_id"),
    paymentInstructionsIssuedAt: ts("payment_instructions_issued_at"),
    /** Why the settlement needs attention (short, over, wrong reference…). Cleared when resolved. */
    exceptionReason: text("exception_reason"),
    exceptionResolvedAt: ts("exception_resolved_at"),
    exceptionResolution: text("exception_resolution"),
    notes: text("notes"),
    createdById: uuid("created_by_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("settlements_hmo_payment_ref_uq").on(t.hmoOrgId, t.paymentReference),
    index("settlements_hmo_status_idx").on(t.hmoOrgId, t.status),
    index("settlements_provider_status_idx").on(t.providerOrgId, t.status),
  ],
);

export const settlementItems = pgTable("settlement_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  settlementId: uuid("settlement_id")
    .notNull()
    .references(() => settlements.id, { onDelete: "cascade" }),
  claimId: uuid("claim_id").notNull().unique().references(() => claims.id),
  amountMinor: integer("amount_minor").notNull(),
});

// ───────────────────────────── Verified payments (partner adapters) ─────────────────────────────
/**
 * A provider's bank account for receiving HMO payments. The account name is fetched from the bank
 * (name enquiry) and compared with the provider's registered name. A change only takes effect after a
 * hold period, and HMOs in the provider's network can see it. Account numbers are encrypted.
 *   PENDING_REVIEW (name doesn't match) → platform approves → SCHEDULED / ACTIVE, or REJECTED
 *   SCHEDULED (change, waiting for the hold) → ACTIVE; CANCELLED by the provider
 *   ACTIVE → REPLACED when the next account becomes active
 */
export const payoutAccounts = pgTable(
  "payout_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    partner: text("partner").notNull(),
    bankCode: text("bank_code").notNull(),
    bankName: text("bank_name").notNull(),
    accountNumberEnc: text("account_number_enc").notNull(),
    accountNumberHash: text("account_number_hash").notNull(),
    accountLast4: text("account_last4").notNull(),
    /** Name returned by the bank for this account (name enquiry). */
    resolvedName: text("resolved_name").notNull(),
    nameMatchScore: integer("name_match_score").notNull(),
    status: text("status").notNull(),
    activeFrom: ts("active_from"),
    activatedAt: ts("activated_at"),
    endedAt: ts("ended_at"),
    /** Partner's id for paying this account (e.g. Paystack subaccount code), created on activation. */
    partnerRecipientRef: text("partner_recipient_ref"),
    createdById: uuid("created_by_id").notNull().references(() => users.id),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    createdAt: createdAt(),
  },
  (t) => [index("payout_accounts_provider_idx").on(t.providerOrgId, t.createdAt)],
);

/**
 * Account an HMO pays into for one provider, issued by the payment partner (e.g. a Paystack
 * dedicated virtual account split to the provider's payout account). Credits to it are reported by
 * the partner and verified by re-querying the partner before they count. The platform never holds
 * the funds: the partner settles them to the provider's bank account.
 */
export const collectionAccounts = pgTable(
  "collection_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").notNull().references(() => organizations.id),
    payoutAccountId: uuid("payout_account_id").notNull().references(() => payoutAccounts.id),
    partner: text("partner").notNull(),
    partnerAccountRef: text("partner_account_ref").notNull(),
    partnerCustomerRef: text("partner_customer_ref"),
    accountNumber: text("account_number").notNull(),
    bankName: text("bank_name").notNull(),
    accountName: text("account_name").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    closedAt: ts("closed_at"),
  },
  (t) => [uniqueIndex("collection_accounts_partner_number_uq").on(t.partner, t.accountNumber)],
);

/**
 * Every incoming credit reported by a payment partner. A credit counts only after its signature was
 * valid AND re-querying the partner confirmed it (verification = VERIFIED); the re-queried values are
 * the ones used. (partner, transaction_ref) and the interbank session id are unique, so the same money
 * can never be counted twice. No raw payload is stored (hash only).
 */
export const paymentCredits = pgTable(
  "payment_credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partner: text("partner").notNull(),
    partnerEventId: text("partner_event_id").notNull(),
    transactionRef: text("transaction_ref").notNull(),
    sessionId: text("session_id"),
    collectionAccountId: uuid("collection_account_id").references(() => collectionAccounts.id),
    hmoOrgId: uuid("hmo_org_id").references(() => organizations.id),
    providerOrgId: uuid("provider_org_id").references(() => organizations.id),
    accountNumber: text("account_number").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    narration: text("narration"),
    senderName: text("sender_name"),
    senderBank: text("sender_bank"),
    senderAccountLast4: text("sender_account_last4"),
    paidAt: ts("paid_at"),
    /** PENDING (partner not re-queried yet) | VERIFIED | REJECTED (re-query disagreed or failed). */
    verification: text("verification").notNull().default("PENDING"),
    verificationNote: text("verification_note"),
    verifiedAt: ts("verified_at"),
    /** PENDING | MATCHED | UNMATCHED | EXCEPTION | DUPLICATE | REJECTED */
    matchStatus: text("match_status").notNull().default("PENDING"),
    matchRule: text("match_rule"), // REFERENCE | UNIQUE_AMOUNT | MANUAL
    settlementId: uuid("settlement_id").references(() => settlements.id),
    exceptionReason: text("exception_reason"),
    matchedById: uuid("matched_by_id").references(() => users.id),
    /** How an UNMATCHED / EXCEPTION credit was dealt with (e.g. refunded to the HMO), by whom and when. */
    resolution: text("resolution"),
    resolvedAt: ts("resolved_at"),
    resolvedById: uuid("resolved_by_id").references(() => users.id),
    payloadSha256: text("payload_sha256").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [
    uniqueIndex("payment_credits_partner_txn_uq").on(t.partner, t.transactionRef),
    index("payment_credits_hmo_idx").on(t.hmoOrgId, t.receivedAt),
    index("payment_credits_provider_idx").on(t.providerOrgId, t.receivedAt),
    index("payment_credits_settlement_idx").on(t.settlementId),
  ],
);

/**
 * Simulated payment partner (development only): bank accounts known to the simulated bank and the
 * transfers made to collection accounts, so name enquiry and transaction re-query behave like the real
 * partner. Never written in live mode.
 */
export const paymentSimAccounts = pgTable("payment_sim_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  bankCode: text("bank_code").notNull(),
  accountNumber: text("account_number").notNull(),
  accountName: text("account_name").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("payment_sim_accounts_uq").on(t.bankCode, t.accountNumber)]);

export const paymentSimTransfers = pgTable("payment_sim_transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  reference: text("reference").notNull().unique(),
  sessionId: text("session_id").notNull(),
  accountNumber: text("account_number").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("NGN"),
  narration: text("narration"),
  senderName: text("sender_name"),
  senderBank: text("sender_bank"),
  status: text("status").notNull().default("success"),
  /** What the simulated webhook claimed, when a test deliberately sent a different value. */
  tamper: text("tamper"),
  result: jsonb("result"),
  createdAt: createdAt(),
});

// ───────────────────────────── Imports & integrations ─────────────────────────────
export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    appliedFileSha: text("applied_file_sha"), // set on apply -> unique per HMO -> idempotent apply
    status: importStatus("status").notNull().default("PREVIEWED"),
    mapping: jsonb("mapping").notNull(),
    totalRows: integer("total_rows").notNull(),
    validRows: integer("valid_rows").notNull(),
    errorRows: integer("error_rows").notNull(),
    errors: jsonb("errors").notNull(), // [{row, field, code, message}] — rows that will not be applied
    warnings: jsonb("warnings"), // [{row, field, code, message}] — rows applied but flagged for review
    /** Legacy (pre-0005) staging. New jobs stage rows in import_rows, encrypted. */
    stagedRows: jsonb("staged_rows"),
    summary: jsonb("summary"),
    /** Apply options chosen by the HMO: { duplicatePhonePolicy, acceptIdentityChanges }. */
    options: jsonb("options"),
    /** What the file really is (from its bytes), the type the browser claimed, and the malware scan result. */
    detectedType: text("detected_type"),
    clientMime: text("client_mime"),
    scanStatus: text("scan_status"), // CLEAN | NOT_SCANNED | INFECTED (never stored: rejected)
    warningRows: integer("warning_rows").notNull().default(0),
    conflictRows: integer("conflict_rows").notNull().default(0),
    // Processing progress (background worker)
    processedRows: integer("processed_rows").notNull().default(0),
    appliedRows: integer("applied_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    heldRows: integer("held_rows").notNull().default(0),
    queuedAt: ts("queued_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    lastError: text("last_error"),
    createdById: uuid("created_by_id").notNull().references(() => users.id),
    createdAt: createdAt(),
    appliedAt: ts("applied_at"),
  },
  (t) => [
    uniqueIndex("import_jobs_hmo_applied_sha_uq").on(t.hmoOrgId, t.appliedFileSha),
    index("import_jobs_hmo_idx").on(t.hmoOrgId, t.createdAt),
  ],
);

/**
 * One row per importable record of an import job (new, update, unchanged or conflict).
 * The record itself is AES-256-GCM encrypted (payloadEnc) and cleared once the job finishes.
 * `status` is set in the same transaction as the record's effect, so a retried or resumed job never
 * applies a row twice.
 */
export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importJobId: uuid("import_job_id").notNull().references(() => importJobs.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    rowNumber: integer("row_number").notNull(),
    memberNumber: text("member_number").notNull(),
    classification: text("classification").notNull(), // NEW | UPDATE | UNCHANGED | CONFLICT
    warnings: text("warnings").array().notNull().default([]),
    changedFields: text("changed_fields").array().notNull().default([]),
    status: text("status").notNull().default("PENDING"), // PENDING | APPLIED | HELD | FAILED
    payloadEnc: text("payload_enc"),
    outcome: text("outcome"), // CREATED | UPDATED | UNCHANGED | HELD_IDENTITY_CONFLICT | ERROR code
    error: text("error"),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("import_rows_job_row_uq").on(t.importJobId, t.rowNumber),
    index("import_rows_job_status_idx").on(t.importJobId, t.status, t.rowNumber),
  ],
);

/**
 * Durable job queue in PostgreSQL (no extra infrastructure). Workers claim jobs with
 * FOR UPDATE SKIP LOCKED and hold a lease; a crashed worker's lease expires and the job resumes.
 */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(), // IMPORT_APPLY
    refId: uuid("ref_id").notNull(),
    orgId: uuid("org_id"),
    status: text("status").notNull().default("QUEUED"), // QUEUED | RUNNING | SUCCEEDED | FAILED
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAfter: ts("run_after").notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [uniqueIndex("background_jobs_kind_ref_uq").on(t.kind, t.refId), index("background_jobs_status_idx").on(t.status, t.runAfter)],
);

export const integrationConfigs = pgTable(
  "integration_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    kind: integrationKind("kind").notNull(),
    name: text("name").notNull(),
    status: integrationStatus("status").notNull().default("DISABLED"),
    config: jsonb("config").notNull(), // non-secret settings only
    secretRef: text("secret_ref"), // NAME of an env var / secret-manager key, never the value
    lastSuccessAt: ts("last_success_at"),
    lastErrorAt: ts("last_error_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [index("integration_configs_hmo_idx").on(t.hmoOrgId)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id").notNull().references(() => integrationConfigs.id),
    hmoOrgId: uuid("hmo_org_id").notNull().references(() => organizations.id),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    status: text("status").notNull(), // RECEIVED | PROCESSED | FAILED
    error: text("error"),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("webhook_events_integration_external_uq").on(t.integrationId, t.externalEventId)],
);

// ───────────────────────────── Audit, notifications, rate limits ─────────────────────────────
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id"),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_org_idx").on(t.orgId, t.createdAt), index("audit_events_entity_idx").on(t.entityType, t.entityId)],
);

export const notificationEvents = pgTable(
  "notification_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hmoOrgId: uuid("hmo_org_id"),
    memberId: uuid("member_id"),
    channel: text("channel").notNull(), // SMS
    template: text("template").notNull(), // e.g. VISIT_OTP; bodies containing codes are never stored
    provider: text("provider").notNull(),
    status: text("status").notNull(), // SENT | FAILED
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("notification_events_hmo_idx").on(t.hmoOrgId, t.createdAt)],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);


/**
 * Phone simulator inbox. Written ONLY when SMS is in simulation mode (never in live mode), so test
 * messages — including OTP codes — can be read on /simulator without a real SMS provider.
 */
export const smsSimulations = pgTable(
  "sms_simulations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toE164: text("to_e164").notNull(),
    body: text("body").notNull(),
    template: text("template"),
    /** Live provider that would have been used, and whether its credentials are configured. */
    wouldUseProvider: text("would_use_provider").notNull(),
    liveConfigured: boolean("live_configured").notNull().default(false),
    /** The exact request the live provider adapter would have sent, with the API key masked. */
    requestPreview: jsonb("request_preview"),
    createdAt: createdAt(),
  },
  (t) => [index("sms_simulations_to_idx").on(t.toE164, t.createdAt)],
);
