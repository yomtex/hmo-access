import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { db, schema, type DbOrTx } from "@/db/client";
import { audit } from "../audit";
import { hmoScope, providerScope } from "../auth/guards";
import type { Actor } from "../auth/session";
import { decryptField, hmacHex, randomRef, randomToken } from "../crypto";
import { AppError, notFound } from "../errors";
import { rateLimit } from "../rate-limit";

export const QR_PREFIX = "HMOA1.";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const credentialHash = (token: string) => hmacHex("member-credential", token);

/** Minimal member view for providers: enough to recognise the person, nothing more. */
export function providerMemberView(m: { shortRef: string; firstName: string; lastName: string; phoneLast4: string | null }) {
  return {
    memberRef: m.shortRef,
    displayName: `${m.firstName} ${m.lastName.charAt(0)}.`,
    phoneMasked: m.phoneLast4 ? `•••• ${m.phoneLast4}` : null,
  };
}

export async function generateShortRef(tx: DbOrTx): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const ref = randomRef("HM", 7);
    const exists = await tx.query.members.findFirst({ where: eq(schema.members.shortRef, ref), columns: { id: true } });
    if (!exists) return ref;
  }
  throw new AppError("INTERNAL", "Could not allocate a member reference");
}

export async function listMembers(actor: Actor, opts: { q?: string; limit?: number; offset?: number } = {}) {
  const hmoOrgId = hmoScope(actor, "members:read");
  const q = opts.q?.trim();
  const where = q
    ? and(
        eq(schema.members.hmoOrgId, hmoOrgId),
        or(ilike(schema.members.memberNumber, `%${q}%`), ilike(schema.members.shortRef, `%${q}%`), ilike(schema.members.lastName, `%${q}%`), ilike(schema.members.firstName, `%${q}%`)),
      )
    : eq(schema.members.hmoOrgId, hmoOrgId);
  const rows = await db
    .select({
      id: schema.members.id,
      memberNumber: schema.members.memberNumber,
      shortRef: schema.members.shortRef,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      phoneLast4: schema.members.phoneLast4,
      status: schema.members.status,
      lastSyncedAt: schema.members.lastSyncedAt,
    })
    .from(schema.members)
    .where(where)
    .orderBy(asc(schema.members.lastName), asc(schema.members.firstName))
    .limit(Math.min(opts.limit ?? 50, 200))
    .offset(opts.offset ?? 0);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.members).where(where);
  return { items: rows, total: count };
}

export async function getMember(actor: Actor, memberId: string) {
  const hmoOrgId = hmoScope(actor, "members:read");
  const member = await db.query.members.findFirst({ where: and(eq(schema.members.id, memberId), eq(schema.members.hmoOrgId, hmoOrgId)) });
  if (!member) throw notFound("Member");
  const coverage = await db
    .select({
      id: schema.planMemberships.id,
      planCode: schema.plans.code,
      planName: schema.plans.name,
      coverageStart: schema.planMemberships.coverageStart,
      coverageEnd: schema.planMemberships.coverageEnd,
      status: schema.planMemberships.status,
      memberGroup: schema.planMemberships.memberGroup,
    })
    .from(schema.planMemberships)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.planMemberships.planId))
    .where(and(eq(schema.planMemberships.memberId, member.id), eq(schema.planMemberships.hmoOrgId, hmoOrgId)))
    .orderBy(desc(schema.planMemberships.coverageStart));
  const credentials = await db
    .select({
      id: schema.memberCredentials.id,
      kind: schema.memberCredentials.kind,
      status: schema.memberCredentials.status,
      issuedAt: schema.memberCredentials.issuedAt,
      expiresAt: schema.memberCredentials.expiresAt,
      revokedAt: schema.memberCredentials.revokedAt,
      lastUsedAt: schema.memberCredentials.lastUsedAt,
      useCount: schema.memberCredentials.useCount,
    })
    .from(schema.memberCredentials)
    .where(and(eq(schema.memberCredentials.memberId, member.id), eq(schema.memberCredentials.kind, "CARD")))
    .orderBy(desc(schema.memberCredentials.issuedAt));
  const { phoneEnc: _enc, phoneHash: _hash, ...safe } = member;
  return { member: safe, coverage, credentials };
}

export async function setMemberStatus(actor: Actor, memberId: string, status: "ACTIVE" | "SUSPENDED" | "TERMINATED", reason: string) {
  const hmoOrgId = hmoScope(actor, "members:write");
  return db.transaction(async (tx) => {
    const [m] = await tx
      .update(schema.members)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(schema.members.id, memberId), eq(schema.members.hmoOrgId, hmoOrgId)))
      .returning({ id: schema.members.id });
    if (!m) throw notFound("Member");
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "member.status_changed", entityType: "member", entityId: memberId, metadata: { status, reason } });
    return m;
  });
}

// ───────────────────────── Credentials ─────────────────────────

async function createCredential(tx: DbOrTx, member: { id: string; hmoOrgId: string }, kind: "CARD" | "EPHEMERAL", ttlSeconds?: number) {
  const token = randomToken(32);
  const [cred] = await tx
    .insert(schema.memberCredentials)
    .values({
      memberId: member.id,
      hmoOrgId: member.hmoOrgId,
      kind,
      tokenHash: credentialHash(token),
      expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null,
    })
    .returning();
  const payload = `${QR_PREFIX}${token}`;
  const qrSvg = await QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return { credential: cred, payload, qrSvg };
}

/**
 * Issues a long-lived card credential. Any existing ACTIVE card credential is revoked, so only one
 * printed QR is valid at a time. The raw token is returned exactly once and never stored.
 */
export async function issueCardCredential(actor: Actor, memberId: string) {
  const hmoOrgId = hmoScope(actor, "credentials:manage");
  return db.transaction(async (tx) => {
    const member = await tx.query.members.findFirst({ where: and(eq(schema.members.id, memberId), eq(schema.members.hmoOrgId, hmoOrgId)) });
    if (!member) throw notFound("Member");
    await tx
      .update(schema.memberCredentials)
      .set({ status: "REVOKED", revokedAt: new Date(), revokedReason: "REISSUED" })
      .where(and(eq(schema.memberCredentials.memberId, memberId), eq(schema.memberCredentials.kind, "CARD"), eq(schema.memberCredentials.status, "ACTIVE")));
    const out = await createCredential(tx, member, "CARD");
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "credential.issued", entityType: "member_credential", entityId: out.credential.id, metadata: { memberId, kind: "CARD" } });
    return { credentialId: out.credential.id, qrPayload: out.payload, qrSvg: out.qrSvg, memberRef: member.shortRef };
  });
}

export async function revokeCredential(actor: Actor, credentialId: string, reason: string) {
  const hmoOrgId = hmoScope(actor, "credentials:manage");
  return db.transaction(async (tx) => {
    const [c] = await tx
      .update(schema.memberCredentials)
      .set({ status: "REVOKED", revokedAt: new Date(), revokedReason: reason.slice(0, 200) })
      .where(and(eq(schema.memberCredentials.id, credentialId), eq(schema.memberCredentials.hmoOrgId, hmoOrgId), eq(schema.memberCredentials.status, "ACTIVE")))
      .returning({ id: schema.memberCredentials.id, memberId: schema.memberCredentials.memberId });
    if (!c) throw notFound("Active credential");
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "credential.revoked", entityType: "member_credential", entityId: c.id, metadata: { reason } });
    return c;
  });
}

/** Short-lived QR shown on the member's secure web page (no app). */
export async function issueEphemeralCredential(memberId: string, ttlSeconds = 300) {
  const member = await db.query.members.findFirst({ where: eq(schema.members.id, memberId) });
  if (!member) throw notFound("Member");
  return db.transaction(async (tx) => {
    const out = await createCredential(tx, member, "EPHEMERAL", ttlSeconds);
    await audit(tx, { orgId: member.hmoOrgId, action: "credential.ephemeral_issued", entityType: "member_credential", entityId: out.credential.id, metadata: { memberId, ttlSeconds } });
    return { qrPayload: out.payload, qrSvg: out.qrSvg, expiresAt: out.credential.expiresAt! };
  });
}

export type MemberLookup =
  | { method: "QR"; qr: string }
  | { method: "MEMBER_REF"; memberRef: string }
  | { method: "MEMBER_NUMBER"; hmoOrgId: string; memberNumber: string };

/**
 * Resolves a QR payload or reference to a member for a provider. The provider must be in the
 * member's HMO network (approved contract) — otherwise the lookup fails exactly like "not found",
 * so providers cannot probe other HMOs' member bases.
 */
export async function resolveMemberForProvider(actor: Actor, lookup: MemberLookup) {
  const providerOrgId = providerScope(actor, "eligibility:check");
  await rateLimit(`lookup:user:${actor.userId}`, 60, 60);

  const fail = async (): Promise<never> => {
    // Count failed lookups per provider to slow down enumeration.
    await rateLimit(`lookup-fail:org:${providerOrgId}`, 30, 600).catch(() => {
      throw new AppError("RATE_LIMITED", "Too many failed lookups; try again later");
    });
    throw new AppError("CREDENTIAL_INVALID", "Member credential or reference not recognised");
  };

  let member: typeof schema.members.$inferSelect | undefined;
  let credentialId: string | null = null;

  if (lookup.method === "QR") {
    const raw = lookup.qr.trim();
    const token = raw.startsWith(QR_PREFIX) ? raw.slice(QR_PREFIX.length) : raw;
    if (!TOKEN_RE.test(token)) return fail();
    const cred = await db.query.memberCredentials.findFirst({ where: eq(schema.memberCredentials.tokenHash, credentialHash(token)) });
    if (!cred || cred.status !== "ACTIVE" || (cred.expiresAt && cred.expiresAt <= new Date())) return fail();
    member = await db.query.members.findFirst({ where: eq(schema.members.id, cred.memberId) });
    credentialId = cred.id;
  } else if (lookup.method === "MEMBER_REF") {
    const ref = lookup.memberRef.trim().toUpperCase();
    if (!/^HM-[2-9A-HJ-NP-Z]{7}$/.test(ref)) return fail();
    member = await db.query.members.findFirst({ where: eq(schema.members.shortRef, ref) });
  } else {
    const num = lookup.memberNumber.trim();
    if (!num || num.length > 64) return fail();
    // Member numbers are unique per HMO ignoring letter case (members_hmo_number_ci_uq).
    member = await db.query.members.findFirst({ where: and(eq(schema.members.hmoOrgId, lookup.hmoOrgId), sql`upper(${schema.members.memberNumber}) = upper(${num})`) });
  }
  if (!member) return fail();

  const contract = await db.query.hmoProviderContracts.findFirst({
    where: and(eq(schema.hmoProviderContracts.hmoOrgId, member.hmoOrgId), eq(schema.hmoProviderContracts.providerOrgId, providerOrgId)),
  });
  if (!contract || contract.status === "PENDING") return fail();
  if (contract.status === "SUSPENDED") throw new AppError("FORBIDDEN", "Your organization's network access with this member's HMO is suspended");

  if (credentialId) {
    await db
      .update(schema.memberCredentials)
      .set({ lastUsedAt: new Date(), useCount: sql`${schema.memberCredentials.useCount} + 1` })
      .where(eq(schema.memberCredentials.id, credentialId));
  }
  const hmo = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, member.hmoOrgId) });
  return { member, hmoName: hmo?.name ?? "", view: providerMemberView(member) };
}

/** Decrypts the member's phone for sending an SMS. Never returned through any API. */
export function memberPhone(m: { phoneEnc: string | null }): string | null {
  return m.phoneEnc ? decryptField(m.phoneEnc) : null;
}
