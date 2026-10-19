/**
 * Plans, benefits and their versions.
 *
 * Lifecycle: DRAFT → PUBLISHED → (closed by a later version, or) RETIRED.
 * Publishing a version closes the previously open published version at the new version's
 * effective date, so exactly one version is in effect at any instant. Published versions are
 * immutable (DB trigger); authorizations and claims keep the version id they were evaluated with.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { BenefitRulesSchema, describeRules, type BenefitRules } from "@/lib/domain/benefit-rules";
import { audit } from "../audit";
import { hmoScope } from "../auth/guards";
import type { Actor } from "../auth/session";
import { AppError, isUniqueViolation, notFound } from "../errors";

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/, "Use 2–40 letters, digits, _ or -");
const name = z.string().trim().min(2).max(120);

export const CreatePlanInput = z.object({ code, name });
export const CreateBenefitInput = z.object({ code, name, category: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,40}$/), description: z.string().max(2000).optional() });
export const PlanVersionInput = z.object({
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable().optional(),
  notes: z.string().max(2000).optional(),
  benefits: z.array(z.object({ benefitId: z.string().uuid(), memberGroups: z.array(z.string().trim().min(1).max(60)).max(50).default([]) })).max(100),
});
export const BenefitVersionInput = z.object({
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable().optional(),
  terms: z.string().max(5000).optional(),
  rules: z.unknown(),
});

function validateRules(raw: unknown): BenefitRules {
  const parsed = BenefitRulesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Benefit rules are invalid", {
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

// ───────────────────────── Plans ─────────────────────────

export async function createPlan(actor: Actor, input: z.input<typeof CreatePlanInput>) {
  const hmoOrgId = hmoScope(actor, "plans:manage");
  const data = CreatePlanInput.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [plan] = await tx.insert(schema.plans).values({ hmoOrgId, ...data }).returning();
      await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "plan.created", entityType: "plan", entityId: plan.id, metadata: { planCode: plan.code } });
      return plan;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "A plan with this code already exists");
    throw e;
  }
}

export async function listPlans(actor: Actor) {
  const hmoOrgId = hmoScope(actor, "members:read");
  const plans = await db.select().from(schema.plans).where(eq(schema.plans.hmoOrgId, hmoOrgId)).orderBy(asc(schema.plans.code));
  const versions = await db.select().from(schema.planVersions).where(eq(schema.planVersions.hmoOrgId, hmoOrgId)).orderBy(desc(schema.planVersions.version));
  const links = await db.select().from(schema.planVersionBenefits).where(eq(schema.planVersionBenefits.hmoOrgId, hmoOrgId));
  return plans.map((p) => ({
    ...p,
    versions: versions
      .filter((v) => v.planId === p.id)
      .map((v) => ({ ...v, benefits: links.filter((l) => l.planVersionId === v.id).map((l) => ({ benefitId: l.benefitId, memberGroups: l.memberGroups })) })),
  }));
}

export async function createPlanVersion(actor: Actor, planId: string, input: z.input<typeof PlanVersionInput>) {
  const hmoOrgId = hmoScope(actor, "plans:manage");
  const data = PlanVersionInput.parse(input);
  if (data.effectiveTo && data.effectiveTo <= data.effectiveFrom) throw new AppError("VALIDATION_FAILED", "effectiveTo must be after effectiveFrom");
  return db.transaction(async (tx) => {
    const plan = await tx.query.plans.findFirst({ where: and(eq(schema.plans.id, planId), eq(schema.plans.hmoOrgId, hmoOrgId)) });
    if (!plan) throw notFound("Plan");
    for (const b of data.benefits) {
      const ok = await tx.query.benefits.findFirst({ where: and(eq(schema.benefits.id, b.benefitId), eq(schema.benefits.hmoOrgId, hmoOrgId)), columns: { id: true } });
      if (!ok) throw new AppError("VALIDATION_FAILED", "Unknown benefit in plan version");
    }
    const [last] = await tx.select({ v: schema.planVersions.version }).from(schema.planVersions).where(eq(schema.planVersions.planId, planId)).orderBy(desc(schema.planVersions.version)).limit(1);
    const [pv] = await tx
      .insert(schema.planVersions)
      .values({ planId, hmoOrgId, version: (last?.v ?? 0) + 1, effectiveFrom: data.effectiveFrom, effectiveTo: data.effectiveTo ?? null, notes: data.notes })
      .returning();
    if (data.benefits.length) {
      await tx.insert(schema.planVersionBenefits).values(data.benefits.map((b) => ({ planVersionId: pv.id, benefitId: b.benefitId, hmoOrgId, memberGroups: b.memberGroups })));
    }
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "plan_version.created", entityType: "plan_version", entityId: pv.id, metadata: { planCode: plan.code, version: pv.version } });
    return pv;
  });
}

export async function publishPlanVersion(actor: Actor, versionId: string) {
  const hmoOrgId = hmoScope(actor, "plans:manage");
  return db.transaction(async (tx) => {
    const [pv] = await tx.select().from(schema.planVersions).where(and(eq(schema.planVersions.id, versionId), eq(schema.planVersions.hmoOrgId, hmoOrgId))).for("update");
    if (!pv) throw notFound("Plan version");
    if (pv.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only draft versions can be published");
    await closeOpenVersion(tx, "plan", pv.planId, pv.effectiveFrom);
    const [out] = await tx.update(schema.planVersions).set({ status: "PUBLISHED", publishedAt: new Date() }).where(eq(schema.planVersions.id, pv.id)).returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "plan_version.published", entityType: "plan_version", entityId: pv.id, metadata: { version: pv.version, effectiveFrom: pv.effectiveFrom } });
    return out;
  });
}

// ───────────────────────── Benefits ─────────────────────────

export async function createBenefit(actor: Actor, input: z.input<typeof CreateBenefitInput>) {
  const hmoOrgId = hmoScope(actor, "benefits:manage");
  const data = CreateBenefitInput.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [b] = await tx.insert(schema.benefits).values({ hmoOrgId, ...data }).returning();
      await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "benefit.created", entityType: "benefit", entityId: b.id, metadata: { benefitCode: b.code } });
      return b;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "A benefit with this code already exists");
    throw e;
  }
}

export async function listBenefits(actor: Actor) {
  const hmoOrgId = hmoScope(actor, "members:read");
  const bs = await db.select().from(schema.benefits).where(eq(schema.benefits.hmoOrgId, hmoOrgId)).orderBy(asc(schema.benefits.code));
  const vs = await db.select().from(schema.benefitVersions).where(eq(schema.benefitVersions.hmoOrgId, hmoOrgId)).orderBy(desc(schema.benefitVersions.version));
  return bs.map((b) => ({
    ...b,
    versions: vs.filter((v) => v.benefitId === b.id).map((v) => ({ ...v, summary: safeDescribe(v.rules) })),
  }));
}

function safeDescribe(rules: unknown): string {
  const p = BenefitRulesSchema.safeParse(rules);
  return p.success ? describeRules(p.data) : "invalid rules";
}

export async function createBenefitVersion(actor: Actor, benefitId: string, input: z.input<typeof BenefitVersionInput>) {
  const hmoOrgId = hmoScope(actor, "benefits:manage");
  const data = BenefitVersionInput.parse(input);
  const rules = validateRules(data.rules);
  if (data.effectiveTo && data.effectiveTo <= data.effectiveFrom) throw new AppError("VALIDATION_FAILED", "effectiveTo must be after effectiveFrom");
  return db.transaction(async (tx) => {
    const b = await tx.query.benefits.findFirst({ where: and(eq(schema.benefits.id, benefitId), eq(schema.benefits.hmoOrgId, hmoOrgId)) });
    if (!b) throw notFound("Benefit");
    if (rules.providerScope === "SPECIFIC_PROVIDERS") {
      for (const pid of rules.providerOrgIds) {
        const c = await tx.query.hmoProviderContracts.findFirst({ where: and(eq(schema.hmoProviderContracts.hmoOrgId, hmoOrgId), eq(schema.hmoProviderContracts.providerOrgId, pid)), columns: { id: true } });
        if (!c) throw new AppError("VALIDATION_FAILED", "A listed provider is not in your network");
      }
    }
    const [last] = await tx.select({ v: schema.benefitVersions.version }).from(schema.benefitVersions).where(eq(schema.benefitVersions.benefitId, benefitId)).orderBy(desc(schema.benefitVersions.version)).limit(1);
    const [bv] = await tx
      .insert(schema.benefitVersions)
      .values({ benefitId, hmoOrgId, version: (last?.v ?? 0) + 1, effectiveFrom: data.effectiveFrom, effectiveTo: data.effectiveTo ?? null, rules, terms: data.terms, createdById: actor.userId })
      .returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "benefit_version.created", entityType: "benefit_version", entityId: bv.id, metadata: { benefitCode: b.code, version: bv.version } });
    return bv;
  });
}

export async function updateBenefitVersionDraft(actor: Actor, versionId: string, input: z.input<typeof BenefitVersionInput>) {
  const hmoOrgId = hmoScope(actor, "benefits:manage");
  const data = BenefitVersionInput.parse(input);
  const rules = validateRules(data.rules);
  const [bv] = await db
    .update(schema.benefitVersions)
    .set({ effectiveFrom: data.effectiveFrom, effectiveTo: data.effectiveTo ?? null, rules, terms: data.terms })
    .where(and(eq(schema.benefitVersions.id, versionId), eq(schema.benefitVersions.hmoOrgId, hmoOrgId), eq(schema.benefitVersions.status, "DRAFT")))
    .returning();
  if (!bv) throw new AppError("INVALID_STATE", "Only draft versions can be edited; create a new version instead");
  await audit(db, { orgId: hmoOrgId, actorUserId: actor.userId, action: "benefit_version.updated", entityType: "benefit_version", entityId: bv.id });
  return bv;
}

export async function publishBenefitVersion(actor: Actor, versionId: string) {
  const hmoOrgId = hmoScope(actor, "benefits:manage");
  return db.transaction(async (tx) => {
    const [bv] = await tx.select().from(schema.benefitVersions).where(and(eq(schema.benefitVersions.id, versionId), eq(schema.benefitVersions.hmoOrgId, hmoOrgId))).for("update");
    if (!bv) throw notFound("Benefit version");
    if (bv.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only draft versions can be published");
    validateRules(bv.rules);
    await closeOpenVersion(tx, "benefit", bv.benefitId, bv.effectiveFrom);
    const [out] = await tx.update(schema.benefitVersions).set({ status: "PUBLISHED", publishedAt: new Date() }).where(eq(schema.benefitVersions.id, bv.id)).returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "benefit_version.published", entityType: "benefit_version", entityId: bv.id, metadata: { version: bv.version, effectiveFrom: bv.effectiveFrom } });
    return out;
  });
}

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Closes the currently open published version (effective_to IS NULL) at `at`.
 * The new version must start after the open version starts; otherwise history would be rewritten.
 */
async function closeOpenVersion(tx: TxLike, kind: "plan" | "benefit", parentId: string, at: Date) {
  if (kind === "plan") {
    const [open] = await tx
      .select()
      .from(schema.planVersions)
      .where(and(eq(schema.planVersions.planId, parentId), eq(schema.planVersions.status, "PUBLISHED"), isNull(schema.planVersions.effectiveTo)))
      .for("update");
    if (!open) return;
    if (at <= open.effectiveFrom) throw new AppError("VALIDATION_FAILED", "New version must take effect after the current version started");
    await tx.update(schema.planVersions).set({ effectiveTo: at }).where(eq(schema.planVersions.id, open.id));
  } else {
    const [open] = await tx
      .select()
      .from(schema.benefitVersions)
      .where(and(eq(schema.benefitVersions.benefitId, parentId), eq(schema.benefitVersions.status, "PUBLISHED"), isNull(schema.benefitVersions.effectiveTo)))
      .for("update");
    if (!open) return;
    if (at <= open.effectiveFrom) throw new AppError("VALIDATION_FAILED", "New version must take effect after the current version started");
    await tx.update(schema.benefitVersions).set({ effectiveTo: at }).where(eq(schema.benefitVersions.id, open.id));
  }
}

/** Pure selection of the version in effect at `at` among published versions (deterministic). */
export function selectEffectiveVersion<T extends { status: string; effectiveFrom: Date; effectiveTo: Date | null; version: number }>(versions: T[], at: Date): T | null {
  return (
    versions
      .filter((v) => v.status === "PUBLISHED" && v.effectiveFrom <= at && (v.effectiveTo === null || at < v.effectiveTo))
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}
