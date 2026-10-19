/** Organization onboarding (platform admin), staff administration and provider locations. */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { audit } from "../audit";
import { providerScope, requirePermission, requirePlatformAdmin } from "../auth/guards";
import { hashPassword } from "../auth/password";
import { ROLES } from "../auth/permissions";
import { revokeAllSessionsForUser, type Actor } from "../auth/session";
import { randomToken } from "../crypto";
import { AppError, isUniqueViolation, notFound } from "../errors";

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,48}$/, "Use 3–49 lowercase letters, digits or hyphens");
const email = z.string().trim().toLowerCase().email().max(200);
const personName = z.string().trim().min(2).max(120);

export const CreateHmoInput = z.object({
  name: z.string().trim().min(2).max(160),
  slug,
  contactEmail: email.optional(),
  staleDataThresholdHours: z.number().int().min(1).max(24 * 90).default(168),
  admin: z.object({ email, name: personName }),
});

export const CreateProviderInput = z.object({
  name: z.string().trim().min(2).max(160),
  slug,
  providerType: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,40}$/),
  contactEmail: email.optional(),
  locations: z.array(z.object({ name: z.string().trim().min(2).max(120), address: z.string().max(300).optional(), city: z.string().max(80).optional() })).min(1).max(100),
  admin: z.object({ email, name: personName }),
});

/**
 * Creates a user if needed; returns a one-time temporary password only for newly created users.
 *
 * A login may be active in only ONE organization (also enforced by the database index
 * org_membership_one_active_per_user_uq). Reusing an existing login that is still active elsewhere
 * would let one credential act for an HMO and a provider, or for two competing providers, so it is
 * refused. A login whose previous memberships were all disabled may be linked (someone changing jobs);
 * that is audited by the caller.
 */
async function ensureUser(tx: Tx, input: { email: string; name: string }) {
  const email = input.email.trim().toLowerCase();
  const existing = await tx.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (existing) {
    const active = await tx.query.organizationMemberships.findFirst({ where: and(eq(schema.organizationMemberships.userId, existing.id), eq(schema.organizationMemberships.status, "ACTIVE")) });
    if (active) throw new AppError("CONFLICT", "This email already signs in to another organization. Each login can belong to one organization; use a different work email.");
    return { user: existing, temporaryPassword: null as string | null, reusedLogin: true };
  }
  const temporaryPassword = randomToken(12);
  const [user] = await tx.insert(schema.users).values({ email, name: input.name, passwordHash: await hashPassword(temporaryPassword) }).returning();
  return { user, temporaryPassword, reusedLogin: false };
}

export async function createHmo(actor: Actor, input: z.input<typeof CreateHmoInput>) {
  requirePlatformAdmin(actor);
  const data = CreateHmoInput.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [org] = await tx.insert(schema.organizations).values({ type: "HMO", name: data.name, slug: data.slug }).returning();
      await tx.insert(schema.hmoProfiles).values({ orgId: org.id, contactEmail: data.contactEmail, staleDataThresholdHours: data.staleDataThresholdHours });
      await tx.insert(schema.integrationConfigs).values({ hmoOrgId: org.id, kind: "CSV_UPLOAD", name: "Member file upload", status: "ACTIVE", config: {} });
      const { user, temporaryPassword } = await ensureUser(tx, data.admin);
      await tx.insert(schema.organizationMemberships).values({ userId: user.id, orgId: org.id, roleKey: "HMO_ADMIN" });
      await audit(tx, { orgId: org.id, actorUserId: actor.userId, action: "organization.created", entityType: "organization", entityId: org.id, metadata: { type: "HMO", slug: org.slug } });
      return { organization: org, admin: { email: user.email, temporaryPassword } };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "An organization with this slug already exists, or the admin email already signs in to another organization");
    throw e;
  }
}

export async function createProvider(actor: Actor, input: z.input<typeof CreateProviderInput>) {
  requirePlatformAdmin(actor);
  const data = CreateProviderInput.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [org] = await tx.insert(schema.organizations).values({ type: "PROVIDER", name: data.name, slug: data.slug }).returning();
      await tx.insert(schema.providerProfiles).values({ orgId: org.id, providerType: data.providerType, contactEmail: data.contactEmail });
      const locs = await tx.insert(schema.providerLocations).values(data.locations.map((l) => ({ ...l, providerOrgId: org.id }))).returning();
      const { user, temporaryPassword } = await ensureUser(tx, data.admin);
      const [m] = await tx.insert(schema.organizationMemberships).values({ userId: user.id, orgId: org.id, roleKey: "PROVIDER_ADMIN" }).returning();
      await tx.insert(schema.providerStaffLocations).values(locs.map((l) => ({ membershipId: m.id, locationId: l.id })));
      await audit(tx, { orgId: org.id, actorUserId: actor.userId, action: "organization.created", entityType: "organization", entityId: org.id, metadata: { type: "PROVIDER", slug: org.slug } });
      return { organization: org, locations: locs, admin: { email: user.email, temporaryPassword } };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "An organization with this slug already exists, or the admin email already signs in to another organization");
    throw e;
  }
}

export async function setOrganizationStatus(actor: Actor, orgId: string, status: "ACTIVE" | "SUSPENDED", reason: string) {
  requirePlatformAdmin(actor);
  if (orgId === actor.orgId) throw new AppError("INVALID_STATE", "You cannot suspend your own organization");
  return db.transaction(async (tx) => {
    const [org] = await tx.update(schema.organizations).set({ status }).where(eq(schema.organizations.id, orgId)).returning();
    if (!org) throw notFound("Organization");
    await audit(tx, { orgId, actorUserId: actor.userId, action: status === "SUSPENDED" ? "organization.suspended" : "organization.reactivated", entityType: "organization", entityId: orgId, metadata: { reason } });
    return org;
  });
}

export async function listOrganizations(actor: Actor) {
  requirePlatformAdmin(actor);
  const orgs = await db.select().from(schema.organizations).orderBy(asc(schema.organizations.type), asc(schema.organizations.name));
  const hmos = await db.select().from(schema.hmoProfiles);
  const providers = await db.select().from(schema.providerProfiles);
  const locations = await db.select().from(schema.providerLocations);
  return orgs.map((o) => ({
    ...o,
    hmoProfile: hmos.find((h) => h.orgId === o.id) ?? null,
    providerProfile: providers.find((p) => p.orgId === o.id) ?? null,
    locations: locations.filter((l) => l.providerOrgId === o.id),
  }));
}

// ───────────────────────── Staff ─────────────────────────

export const InviteStaffInput = z.object({
  email,
  name: personName,
  roleKey: z.string(),
  locationIds: z.array(z.string().uuid()).max(100).default([]),
});

export async function listStaff(actor: Actor) {
  requirePermission(actor, "staff:manage");
  const rows = await db
    .select({ membershipId: schema.organizationMemberships.id, userId: schema.users.id, email: schema.users.email, name: schema.users.name, roleKey: schema.organizationMemberships.roleKey, status: schema.organizationMemberships.status, lastLoginAt: schema.users.lastLoginAt })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .where(eq(schema.organizationMemberships.orgId, actor.orgId))
    .orderBy(asc(schema.users.name));
  const ids = rows.map((r) => r.membershipId);
  const locs = ids.length ? await db.select().from(schema.providerStaffLocations).where(inArray(schema.providerStaffLocations.membershipId, ids)) : [];
  return rows.map((r) => ({ ...r, locationIds: locs.filter((l) => l.membershipId === r.membershipId).map((l) => l.locationId) }));
}

export async function inviteStaff(actor: Actor, input: z.input<typeof InviteStaffInput>) {
  requirePermission(actor, "staff:manage");
  const data = InviteStaffInput.parse(input);
  const role = ROLES[data.roleKey];
  if (!role || role.orgType !== actor.orgType) throw new AppError("VALIDATION_FAILED", "Role is not valid for your organization");
  if (actor.orgType === "PROVIDER") {
    if (data.locationIds.length === 0) throw new AppError("VALIDATION_FAILED", "Assign at least one branch");
    const owned = await db.select({ id: schema.providerLocations.id }).from(schema.providerLocations).where(and(eq(schema.providerLocations.providerOrgId, actor.orgId), inArray(schema.providerLocations.id, data.locationIds)));
    if (owned.length !== data.locationIds.length) throw new AppError("VALIDATION_FAILED", "Unknown branch");
  }
  try {
    return await db.transaction(async (tx) => {
      const { user, temporaryPassword, reusedLogin } = await ensureUser(tx, data);
      const [m] = await tx.insert(schema.organizationMemberships).values({ userId: user.id, orgId: actor.orgId, roleKey: data.roleKey }).returning();
      if (reusedLogin) await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "staff.existing_login_linked", entityType: "organization_membership", entityId: m.id, metadata: { userId: user.id } });
      if (data.locationIds.length) await tx.insert(schema.providerStaffLocations).values(data.locationIds.map((locationId) => ({ membershipId: m.id, locationId })));
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "staff.invited", entityType: "organization_membership", entityId: m.id, metadata: { email: data.email, roleKey: data.roleKey } });
      return { membershipId: m.id, email: user.email, temporaryPassword };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "This person is already a member of your organization, or already signs in to another organization");
    throw e;
  }
}

export async function setStaffStatus(actor: Actor, membershipId: string, status: "ACTIVE" | "INACTIVE") {
  requirePermission(actor, "staff:manage");
  return setStaffStatusTx(actor, membershipId, status).catch((e) => {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "This login is active in another organization; it can be enabled here only after it is disabled there");
    throw e;
  });
}

function setStaffStatusTx(actor: Actor, membershipId: string, status: "ACTIVE" | "INACTIVE") {
  return db.transaction(async (tx) => {
    const [m] = await tx
      .update(schema.organizationMemberships)
      .set({ status })
      .where(and(eq(schema.organizationMemberships.id, membershipId), eq(schema.organizationMemberships.orgId, actor.orgId)))
      .returning();
    if (!m) throw notFound("Staff member");
    if (m.userId === actor.userId) throw new AppError("INVALID_STATE", "You cannot change your own access");
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: status === "INACTIVE" ? "staff.disabled" : "staff.enabled", entityType: "organization_membership", entityId: m.id });
    if (status === "INACTIVE") await revokeAllSessionsForUser(m.userId);
    return m;
  });
}

// ───────────────────────── Provider locations ─────────────────────────

export const LocationInput = z.object({ name: z.string().trim().min(2).max(120), address: z.string().max(300).optional(), city: z.string().max(80).optional() });

export async function listMyLocations(actor: Actor) {
  if (actor.orgType !== "PROVIDER") throw new AppError("FORBIDDEN", "Providers only");
  return db.select().from(schema.providerLocations).where(eq(schema.providerLocations.providerOrgId, actor.orgId)).orderBy(asc(schema.providerLocations.name));
}

export async function createLocation(actor: Actor, input: z.input<typeof LocationInput>) {
  const providerOrgId = providerScope(actor, "provider:locations");
  const data = LocationInput.parse(input);
  return db.transaction(async (tx) => {
    const [loc] = await tx.insert(schema.providerLocations).values({ ...data, providerOrgId }).returning();
    await audit(tx, { orgId: providerOrgId, actorUserId: actor.userId, action: "location.created", entityType: "provider_location", entityId: loc.id });
    return loc;
  });
}

// ───────────────────────── Audit review ─────────────────────────

export async function listAudit(actor: Actor, opts: { entityType?: string; entityId?: string; orgId?: string; limit?: number } = {}) {
  requirePermission(actor, "audit:read");
  const conds = [];
  if (actor.orgType !== "PLATFORM") conds.push(eq(schema.auditEvents.orgId, actor.orgId));
  else if (opts.orgId) conds.push(eq(schema.auditEvents.orgId, opts.orgId));
  if (opts.entityType) conds.push(eq(schema.auditEvents.entityType, opts.entityType));
  if (opts.entityId) conds.push(eq(schema.auditEvents.entityId, opts.entityId));
  return db
    .select()
    .from(schema.auditEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.auditEvents.id))
    .limit(Math.min(opts.limit ?? 200, 1000));
}
