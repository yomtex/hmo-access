import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { audit } from "../audit";
import { config } from "../config";
import { hmacHex, randomToken } from "../crypto";
import { AppError } from "../errors";
import { rateLimit } from "../rate-limit";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "./password";
import { permissionsForRole, type OrgTypeName, type Permission } from "./permissions";

export const SESSION_COOKIE = "hmoa_session";
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export type Actor = {
  userId: string;
  email: string;
  name: string;
  sessionId: string;
  orgId: string;
  orgType: OrgTypeName;
  orgName: string;
  orgTimezone: string;
  roleKey: string;
  permissions: Set<Permission>;
  /** Provider branches this user may act for (empty for non-provider orgs). */
  locationIds: string[];
  activeLocationId: string | null;
};

const tokenHash = (token: string) => hmacHex("session", token);

// Unknown e-mails still run one argon2 verification so response time does not reveal which accounts exist.
let dummyHash: string | undefined;
async function burnPasswordCheck(password: string) {
  dummyHash ??= await hashPassword(randomToken(16));
  await verifyPassword(dummyHash, password);
}

export async function login(emailRaw: string, password: string, ip = "unknown"): Promise<{ token: string; expiresAt: Date }> {
  const email = emailRaw.trim().toLowerCase();
  await rateLimit(`login:ip:${ip}`, 30, 300);
  await rateLimit(`login:email:${email}`, 10, 300);

  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (!user) {
    await burnPasswordCheck(password);
    throw new AppError("UNAUTHENTICATED", "Invalid email or password");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError("ACCOUNT_LOCKED", "Account temporarily locked after repeated failed sign-ins");
  }
  const ok = user.status === "ACTIVE" && (await verifyPassword(user.passwordHash, password));
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    await db
      .update(schema.users)
      .set({
        failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : user.lockedUntil,
      })
      .where(eq(schema.users.id, user.id));
    await audit(db, { actorUserId: user.id, action: "auth.login_failed", entityType: "user", entityId: user.id });
    throw new AppError("UNAUTHENTICATED", "Invalid email or password");
  }

  const memberships = await activeMemberships(user.id);
  if (memberships.length === 0) throw new AppError("FORBIDDEN", "This account is not linked to an active organization");

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config().SESSION_TTL_HOURS * 3600_000);
  const first = memberships[0];
  const [session] = await db
    .insert(schema.sessions)
    .values({ tokenHash: tokenHash(token), userId: user.id, activeOrgId: first.orgId, expiresAt })
    .returning();
  await db.update(schema.users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  await audit(db, { orgId: first.orgId, actorUserId: user.id, action: "auth.login", entityType: "session", entityId: session.id });
  return { token, expiresAt };
}

async function activeMemberships(userId: string) {
  return db
    .select({
      id: schema.organizationMemberships.id,
      orgId: schema.organizationMemberships.orgId,
      roleKey: schema.organizationMemberships.roleKey,
      orgType: schema.organizations.type,
      orgName: schema.organizations.name,
      orgStatus: schema.organizations.status,
      orgTimezone: schema.organizations.timezone,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationMemberships.orgId))
    .where(and(eq(schema.organizationMemberships.userId, userId), eq(schema.organizationMemberships.status, "ACTIVE"), eq(schema.organizations.status, "ACTIVE")))
    .orderBy(schema.organizationMemberships.createdAt);
}

/** Resolve a raw session token to an Actor, or null if invalid/expired/revoked. */
export async function resolveSession(token: string | undefined | null): Promise<Actor | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const now = new Date();
  const session = await db.query.sessions.findFirst({
    where: and(eq(schema.sessions.tokenHash, tokenHash(token)), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, now)),
  });
  if (!session || !session.activeOrgId) return null;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, session.userId) });
  if (!user || user.status !== "ACTIVE") return null;

  const memberships = await activeMemberships(user.id);
  const m = memberships.find((x) => x.orgId === session.activeOrgId);
  if (!m) return null; // membership or org disabled since login

  let locationIds: string[] = [];
  if (m.orgType === "PROVIDER") {
    const rows = await db
      .select({ id: schema.providerStaffLocations.locationId })
      .from(schema.providerStaffLocations)
      .innerJoin(schema.providerLocations, eq(schema.providerLocations.id, schema.providerStaffLocations.locationId))
      .where(and(eq(schema.providerStaffLocations.membershipId, m.id), eq(schema.providerLocations.status, "ACTIVE")));
    locationIds = rows.map((r) => r.id);
  }

  // Throttled "last seen" update.
  if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
    await db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, session.id));
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    sessionId: session.id,
    orgId: m.orgId,
    orgType: m.orgType,
    orgName: m.orgName,
    orgTimezone: m.orgTimezone,
    roleKey: m.roleKey,
    permissions: permissionsForRole(m.roleKey),
    locationIds,
    activeLocationId: session.activeLocationId && locationIds.includes(session.activeLocationId) ? session.activeLocationId : null,
  };
}

export async function listUserOrganizations(userId: string) {
  return activeMemberships(userId);
}

export async function switchOrganization(actor: Actor, orgId: string) {
  const memberships = await activeMemberships(actor.userId);
  if (!memberships.some((m) => m.orgId === orgId)) throw new AppError("FORBIDDEN", "Not a member of that organization");
  await db.update(schema.sessions).set({ activeOrgId: orgId, activeLocationId: null }).where(eq(schema.sessions.id, actor.sessionId));
}

export async function selectLocation(actor: Actor, locationId: string) {
  if (actor.orgType !== "PROVIDER" || !actor.locationIds.includes(locationId)) {
    throw new AppError("FORBIDDEN", "You are not authorized for that branch");
  }
  await db.update(schema.sessions).set({ activeLocationId: locationId }).where(eq(schema.sessions.id, actor.sessionId));
}

export async function logout(token: string) {
  await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.tokenHash, tokenHash(token)));
}

export async function revokeAllSessionsForUser(userId: string) {
  await db.update(schema.sessions).set({ revokedAt: sql`now()` }).where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
}

/**
 * Changes the signed-in user's password. Needs the current password; signs out every other session
 * of this user (a stolen session ends when the owner changes the password).
 */
export async function changePassword(actor: Actor, currentPassword: string, newPassword: string) {
  await rateLimit(`password-change:${actor.userId}`, 10, 3600);
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, actor.userId) });
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
    await audit(db, { orgId: actor.orgId, actorUserId: actor.userId, action: "user.password_change_failed", entityType: "user", entityId: actor.userId });
    throw new AppError("UNAUTHENTICATED", "Current password is incorrect");
  }
  const weak = assertPasswordPolicy(newPassword);
  if (weak) throw new AppError("VALIDATION_FAILED", weak);
  if (newPassword === currentPassword) throw new AppError("VALIDATION_FAILED", "Choose a password you haven't used here");
  await db.update(schema.users).set({ passwordHash: await hashPassword(newPassword), failedLoginCount: 0, lockedUntil: null }).where(eq(schema.users.id, actor.userId));
  await db.update(schema.sessions).set({ revokedAt: sql`now()` }).where(and(eq(schema.sessions.userId, actor.userId), isNull(schema.sessions.revokedAt), sql`${schema.sessions.id} <> ${actor.sessionId}`));
  await audit(db, { orgId: actor.orgId, actorUserId: actor.userId, action: "user.password_changed", entityType: "user", entityId: actor.userId });
}
