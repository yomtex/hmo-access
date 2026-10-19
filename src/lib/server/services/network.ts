/** Provider network: contracts, approved locations and provider-specific tariffs. */
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { audit } from "../audit";
import { hmoScope, providerScope } from "../auth/guards";
import type { Actor } from "../auth/session";
import { AppError, notFound } from "../errors";

export const ContractInput = z.object({
  providerOrgId: z.string().uuid(),
  status: z.enum(["PENDING", "APPROVED", "SUSPENDED"]),
  settlementTermsDays: z.number().int().min(0).max(365).default(30),
  settlementTermsNotes: z.string().max(2000).optional(),
});

export const TariffInput = z.object({
  providerOrgId: z.string().uuid(),
  benefitId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  tariffMinor: z.number().int().min(0).max(1_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default("NGN"),
  effectiveFrom: z.coerce.date().optional(),
});

/** All active providers on the platform (so an HMO can choose whom to approve). */
export async function listPlatformProviders(actor: Actor) {
  const hmoOrgId = hmoScope(actor, "network:manage");
  const providers = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name, status: schema.organizations.status, providerType: schema.providerProfiles.providerType })
    .from(schema.organizations)
    .innerJoin(schema.providerProfiles, eq(schema.providerProfiles.orgId, schema.organizations.id))
    .where(eq(schema.organizations.type, "PROVIDER"))
    .orderBy(asc(schema.organizations.name));
  const locations = await db.select().from(schema.providerLocations).orderBy(asc(schema.providerLocations.name));
  const contracts = await db.select().from(schema.hmoProviderContracts).where(eq(schema.hmoProviderContracts.hmoOrgId, hmoOrgId));
  const netLocs = await db.select().from(schema.networkLocations).where(eq(schema.networkLocations.hmoOrgId, hmoOrgId));
  const tariffs = await db
    .select({
      id: schema.providerBenefitAssignments.id,
      providerOrgId: schema.providerBenefitAssignments.providerOrgId,
      benefitId: schema.providerBenefitAssignments.benefitId,
      benefitCode: schema.benefits.code,
      benefitName: schema.benefits.name,
      locationId: schema.providerBenefitAssignments.locationId,
      tariffMinor: schema.providerBenefitAssignments.tariffMinor,
      currency: schema.providerBenefitAssignments.currency,
      effectiveFrom: schema.providerBenefitAssignments.effectiveFrom,
    })
    .from(schema.providerBenefitAssignments)
    .innerJoin(schema.benefits, eq(schema.benefits.id, schema.providerBenefitAssignments.benefitId))
    .where(and(eq(schema.providerBenefitAssignments.hmoOrgId, hmoOrgId), eq(schema.providerBenefitAssignments.status, "ACTIVE")));
  return providers.map((p) => ({
    ...p,
    contract: contracts.find((c) => c.providerOrgId === p.id) ?? null,
    locations: locations
      .filter((l) => l.providerOrgId === p.id)
      .map((l) => ({ ...l, networkStatus: netLocs.find((n) => n.locationId === l.id)?.status ?? null })),
    tariffs: tariffs.filter((t) => t.providerOrgId === p.id),
  }));
}

export async function upsertContract(actor: Actor, input: z.input<typeof ContractInput>) {
  const hmoOrgId = hmoScope(actor, "network:manage");
  const data = ContractInput.parse(input);
  return db.transaction(async (tx) => {
    const provider = await tx.query.organizations.findFirst({ where: and(eq(schema.organizations.id, data.providerOrgId), eq(schema.organizations.type, "PROVIDER")) });
    if (!provider) throw notFound("Provider");
    const [c] = await tx
      .insert(schema.hmoProviderContracts)
      .values({ hmoOrgId, ...data })
      .onConflictDoUpdate({
        target: [schema.hmoProviderContracts.hmoOrgId, schema.hmoProviderContracts.providerOrgId],
        set: { status: data.status, settlementTermsDays: data.settlementTermsDays, settlementTermsNotes: data.settlementTermsNotes, updatedAt: new Date() },
      })
      .returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "network.contract_set", entityType: "hmo_provider_contract", entityId: c.id, metadata: { providerOrgId: data.providerOrgId, status: data.status, settlementTermsDays: data.settlementTermsDays } });
    return c;
  });
}

export async function setNetworkLocation(actor: Actor, locationId: string, status: "APPROVED" | "SUSPENDED") {
  const hmoOrgId = hmoScope(actor, "network:manage");
  return db.transaction(async (tx) => {
    const loc = await tx.query.providerLocations.findFirst({ where: eq(schema.providerLocations.id, locationId) });
    if (!loc) throw notFound("Location");
    const contract = await tx.query.hmoProviderContracts.findFirst({ where: and(eq(schema.hmoProviderContracts.hmoOrgId, hmoOrgId), eq(schema.hmoProviderContracts.providerOrgId, loc.providerOrgId)) });
    if (!contract) throw new AppError("INVALID_STATE", "Add the provider to your network before approving its locations");
    const [n] = await tx
      .insert(schema.networkLocations)
      .values({ hmoOrgId, providerOrgId: loc.providerOrgId, locationId, status })
      .onConflictDoUpdate({ target: [schema.networkLocations.hmoOrgId, schema.networkLocations.locationId], set: { status } })
      .returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "network.location_set", entityType: "network_location", entityId: n.id, metadata: { locationId, status } });
    return n;
  });
}

/** Creates a new tariff and ends the previous active one (tariff rows are immutable history). */
export async function setTariff(actor: Actor, input: z.input<typeof TariffInput>) {
  const hmoOrgId = hmoScope(actor, "network:manage");
  const data = TariffInput.parse(input);
  const effectiveFrom = data.effectiveFrom ?? new Date();
  return db.transaction(async (tx) => {
    const benefit = await tx.query.benefits.findFirst({ where: and(eq(schema.benefits.id, data.benefitId), eq(schema.benefits.hmoOrgId, hmoOrgId)) });
    if (!benefit) throw notFound("Benefit");
    const contract = await tx.query.hmoProviderContracts.findFirst({ where: and(eq(schema.hmoProviderContracts.hmoOrgId, hmoOrgId), eq(schema.hmoProviderContracts.providerOrgId, data.providerOrgId)) });
    if (!contract) throw new AppError("INVALID_STATE", "Provider is not in your network");
    if (data.locationId) {
      const loc = await tx.query.providerLocations.findFirst({ where: and(eq(schema.providerLocations.id, data.locationId), eq(schema.providerLocations.providerOrgId, data.providerOrgId)) });
      if (!loc) throw notFound("Location");
    }
    const locCond = data.locationId ? eq(schema.providerBenefitAssignments.locationId, data.locationId) : isNull(schema.providerBenefitAssignments.locationId);
    const [current] = await tx
      .select()
      .from(schema.providerBenefitAssignments)
      .where(and(eq(schema.providerBenefitAssignments.hmoOrgId, hmoOrgId), eq(schema.providerBenefitAssignments.providerOrgId, data.providerOrgId), eq(schema.providerBenefitAssignments.benefitId, data.benefitId), eq(schema.providerBenefitAssignments.status, "ACTIVE"), locCond))
      .for("update");
    if (current) {
      if (effectiveFrom <= current.effectiveFrom) throw new AppError("VALIDATION_FAILED", "New tariff must take effect after the current tariff started");
      await tx.update(schema.providerBenefitAssignments).set({ status: "ENDED", effectiveTo: effectiveFrom }).where(eq(schema.providerBenefitAssignments.id, current.id));
    }
    const [a] = await tx
      .insert(schema.providerBenefitAssignments)
      .values({ hmoOrgId, providerOrgId: data.providerOrgId, benefitId: data.benefitId, locationId: data.locationId ?? null, tariffMinor: data.tariffMinor, currency: data.currency, effectiveFrom, createdById: actor.userId })
      .returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "network.tariff_set", entityType: "provider_benefit_assignment", entityId: a.id, metadata: { benefitCode: benefit.code, providerOrgId: data.providerOrgId, tariffMinor: data.tariffMinor, previousAssignmentId: current?.id ?? null } });
    return a;
  });
}

/** HMOs a provider works with, plus the benefits it can serve for each (provider view). */
export async function listProviderNetworks(actor: Actor) {
  const providerOrgId = providerScope(actor, "eligibility:check");
  const rows = await db
    .select({
      hmoOrgId: schema.hmoProviderContracts.hmoOrgId,
      hmoName: schema.organizations.name,
      status: schema.hmoProviderContracts.status,
      settlementTermsDays: schema.hmoProviderContracts.settlementTermsDays,
    })
    .from(schema.hmoProviderContracts)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.hmoProviderContracts.hmoOrgId))
    .where(eq(schema.hmoProviderContracts.providerOrgId, providerOrgId));
  return rows;
}
