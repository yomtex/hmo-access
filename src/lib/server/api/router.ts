/**
 * REST API v1 route table. Every route documented in docs/api/openapi.yaml is listed here, and
 * nothing else. Handlers are thin: parse input with zod, call a service with the authenticated
 * actor, return JSON. All authorization decisions live in the services.
 */
import { z } from "zod";
import { BenefitRulesSchema, describeRules } from "@/lib/domain/benefit-rules";
import type { Actor } from "../auth/session";
import { changePassword, listUserOrganizations, login, logout, selectLocation, switchOrganization, SESSION_COOKIE } from "../auth/session";
import { requirePlatformAdmin } from "../auth/guards";
import { config } from "../config";
import { AppError } from "../errors";
import { pruneRateLimits } from "../rate-limit";
import * as approvals from "../services/approvals";
import * as catalog from "../services/catalog";
import * as claims from "../services/claims";
import * as eligibility from "../services/eligibility";
import * as imports from "../services/imports";
import * as integrity from "../services/integrity";
import * as integrations from "../services/integrations";
import * as memberPortal from "../services/member-portal";
import * as members from "../services/members";
import * as network from "../services/network";
import * as orgs from "../services/organizations";
import * as reports from "../services/reports";
import * as settlements from "../services/settlements";
import * as payments from "../services/payments";
import { paymentsStatus } from "../payments";
import * as visits from "../services/visits";
import * as simulator from "../services/simulator";
import { smsStatus } from "../sms";
import { assertSameOrigin, assertSameOriginIfPresent, authenticate, clearCookie, clientIp, errorResponse, json, jsonBody, readBodyCapped, readCookie, sessionCookie, type ApiContext } from "./http";

type Auth = "user" | "public" | "member" | "webhook";
type Handler = (ctx: ApiContext & { actor: Actor }) => Promise<unknown>;
type PublicHandler = (ctx: ApiContext) => Promise<unknown>;
type Route = { method: string; pattern: string; auth: Auth; handler: Handler | PublicHandler; regex: RegExp; keys: string[] };

const routes: Route[] = [];
function add(method: string, pattern: string, handler: Handler, auth?: "user"): void;
function add(method: string, pattern: string, handler: PublicHandler, auth: "public" | "member" | "webhook"): void;
function add(method: string, pattern: string, handler: Handler | PublicHandler, auth: Auth = "user") {
  const keys: string[] = [];
  const regex = new RegExp("^" + pattern.replace(/\{(\w+)\}/g, (_m, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, pattern, auth, handler, regex, keys });
}

const uuid = z.string().uuid();
const body = <T extends z.ZodTypeAny>(ctx: ApiContext, schema: T) => jsonBody(ctx.req).then((b) => schema.parse(b) as z.infer<T>);
const param = (ctx: ApiContext, k: string) => uuid.parse(ctx.params[k]);
const created = (data: unknown) => json(data, 201);
const csv = (text: string, filename: string) =>
  new Response(text, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });

// ───────────── auth ─────────────
add(
  "POST",
  "/v1/auth/login",
  async (ctx) => {
    const b = await body(ctx, z.object({ email: z.string().max(200), password: z.string().min(1).max(256) }));
    const { token, expiresAt } = await login(b.email, b.password, ctx.ip);
    return json({ token, expiresAt }, 200, { "set-cookie": sessionCookie(token, config().SESSION_TTL_HOURS * 3600) });
  },
  "public",
);
add("POST", "/v1/auth/logout", async (ctx) => {
  const token = ctx.req.headers.get("authorization")?.replace(/^Bearer /, "") ?? readCookie(ctx.req, SESSION_COOKIE);
  if (token) await logout(token);
  return json({ ok: true }, 200, { "set-cookie": clearCookie() });
});
add("GET", "/v1/auth/me", async ({ actor }) => ({
  user: { id: actor.userId, email: actor.email, name: actor.name },
  organization: { id: actor.orgId, type: actor.orgType, name: actor.orgName },
  role: actor.roleKey,
  permissions: [...actor.permissions],
  locationIds: actor.locationIds,
  activeLocationId: actor.activeLocationId,
  organizations: (await listUserOrganizations(actor.userId)).map((o) => ({ id: o.orgId, name: o.orgName, type: o.orgType, role: o.roleKey })),
}));
add("POST", "/v1/auth/switch-organization", async (ctx) => {
  const b = await body(ctx, z.object({ orgId: uuid }));
  await switchOrganization(ctx.actor, b.orgId);
  return { ok: true };
});
add("POST", "/v1/auth/password", async (ctx) => {
  const b = await body(ctx, z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }));
  await changePassword(ctx.actor, b.currentPassword, b.newPassword);
  return { ok: true };
});
add("POST", "/v1/auth/select-location", async (ctx) => {
  const b = await body(ctx, z.object({ locationId: uuid }));
  await selectLocation(ctx.actor, b.locationId);
  return { ok: true };
});

// ───────────── organizations ─────────────
add("GET", "/v1/organizations", async ({ actor }) => ({ items: await orgs.listOrganizations(actor) }));
add("POST", "/v1/organizations/hmos", async (ctx) => created(await orgs.createHmo(ctx.actor, await jsonBody(ctx.req))));
add("POST", "/v1/organizations/providers", async (ctx) => created(await orgs.createProvider(ctx.actor, await jsonBody(ctx.req))));
add("POST", "/v1/organizations/{id}/status", async (ctx) => {
  const b = await body(ctx, z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]), reason: z.string().min(3).max(300) }));
  return orgs.setOrganizationStatus(ctx.actor, param(ctx, "id"), b.status, b.reason);
});
add("GET", "/v1/organizations/me/staff", async ({ actor }) => ({ items: await orgs.listStaff(actor) }));
add("POST", "/v1/organizations/me/staff", async (ctx) => created(await orgs.inviteStaff(ctx.actor, await jsonBody(ctx.req))));
add("POST", "/v1/organizations/me/staff/{membershipId}/status", async (ctx) => {
  const b = await body(ctx, z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }));
  return orgs.setStaffStatus(ctx.actor, param(ctx, "membershipId"), b.status);
});
add("GET", "/v1/organizations/me/locations", async ({ actor }) => ({ items: await orgs.listMyLocations(actor) }));
add("POST", "/v1/organizations/me/locations", async (ctx) => created(await orgs.createLocation(ctx.actor, await jsonBody(ctx.req))));

// ───────────── members & credentials ─────────────
add("GET", "/v1/members", async ({ actor, url }) => members.listMembers(actor, { q: url.searchParams.get("q") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50), offset: Number(url.searchParams.get("offset") ?? 0) }));
add("GET", "/v1/members/{id}", async (ctx) => members.getMember(ctx.actor, param(ctx, "id")));
add("POST", "/v1/members/{id}/status", async (ctx) => {
  const b = await body(ctx, z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "TERMINATED"]), reason: z.string().min(3).max(300) }));
  return members.setMemberStatus(ctx.actor, param(ctx, "id"), b.status, b.reason);
});
add("GET", "/v1/members/{id}/service-approvals", async (ctx) => ({ items: await approvals.listServiceApprovals(ctx.actor, param(ctx, "id")) }));
add("POST", "/v1/members/{id}/service-approvals", async (ctx) => created(await approvals.createServiceApproval(ctx.actor, { ...(await jsonBody<object>(ctx.req)), memberId: param(ctx, "id") } as z.input<typeof approvals.ApprovalInput>)));
add("POST", "/v1/service-approvals/{id}/revoke", async (ctx) => approvals.revokeServiceApproval(ctx.actor, param(ctx, "id")));
add("POST", "/v1/member-credentials", async (ctx) => {
  const b = await body(ctx, z.object({ memberId: uuid }));
  return created(await members.issueCardCredential(ctx.actor, b.memberId));
});
add("POST", "/v1/member-credentials/{id}/revoke", async (ctx) => {
  const b = await body(ctx, z.object({ reason: z.string().min(3).max(200) }));
  return members.revokeCredential(ctx.actor, param(ctx, "id"), b.reason);
});

// ───────────── plans & benefits ─────────────
add("GET", "/v1/plans", async ({ actor }) => ({ items: await catalog.listPlans(actor) }));
add("POST", "/v1/plans", async (ctx) => created(await catalog.createPlan(ctx.actor, await jsonBody(ctx.req))));
add("POST", "/v1/plans/{id}/versions", async (ctx) => created(await catalog.createPlanVersion(ctx.actor, param(ctx, "id"), await jsonBody(ctx.req))));
add("POST", "/v1/plans/versions/{versionId}/publish", async (ctx) => catalog.publishPlanVersion(ctx.actor, param(ctx, "versionId")));
add("GET", "/v1/benefits", async ({ actor }) => ({ items: await catalog.listBenefits(actor) }));
add("POST", "/v1/benefits", async (ctx) => created(await catalog.createBenefit(ctx.actor, await jsonBody(ctx.req))));
add("POST", "/v1/benefits/validate-rules", async (ctx) => {
  const r = BenefitRulesSchema.safeParse(await jsonBody(ctx.req));
  return r.success ? { valid: true, rules: r.data, summary: describeRules(r.data) } : { valid: false, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
});
add("POST", "/v1/benefits/{id}/versions", async (ctx) => created(await catalog.createBenefitVersion(ctx.actor, param(ctx, "id"), await jsonBody(ctx.req))));
add("PUT", "/v1/benefits/versions/{versionId}", async (ctx) => catalog.updateBenefitVersionDraft(ctx.actor, param(ctx, "versionId"), await jsonBody(ctx.req)));
add("POST", "/v1/benefits/versions/{versionId}/publish", async (ctx) => catalog.publishBenefitVersion(ctx.actor, param(ctx, "versionId")));

// ───────────── providers & network ─────────────
add("GET", "/v1/providers", async ({ actor }) => ({ items: await network.listPlatformProviders(actor) }));
add("GET", "/v1/providers/networks", async ({ actor }) => ({ items: await network.listProviderNetworks(actor) }));
add("PUT", "/v1/providers/{providerOrgId}/contract", async (ctx) => network.upsertContract(ctx.actor, { ...(await jsonBody<object>(ctx.req)), providerOrgId: param(ctx, "providerOrgId") } as z.input<typeof network.ContractInput>));
add("PUT", "/v1/providers/locations/{locationId}/network", async (ctx) => {
  const b = await body(ctx, z.object({ status: z.enum(["APPROVED", "SUSPENDED"]) }));
  return network.setNetworkLocation(ctx.actor, param(ctx, "locationId"), b.status);
});
add("POST", "/v1/providers/tariffs", async (ctx) => created(await network.setTariff(ctx.actor, await jsonBody(ctx.req))));

// ───────────── eligibility & visits ─────────────
const Lookup = z.discriminatedUnion("method", [
  z.object({ method: z.literal("QR"), qr: z.string().max(200) }),
  z.object({ method: z.literal("MEMBER_REF"), memberRef: z.string().max(20) }),
  z.object({ method: z.literal("MEMBER_NUMBER"), hmoOrgId: uuid, memberNumber: z.string().max(64) }),
]);
add("POST", "/v1/eligibility/checks", async (ctx) => {
  const b = await body(ctx, z.object({ lookup: Lookup, locationId: uuid.optional(), benefitId: uuid.optional(), quantity: z.number().int().min(1).max(1000).optional() }));
  return eligibility.checkEligibility(ctx.actor, b);
});
add("GET", "/v1/eligibility/checks", async ({ actor }) => ({ items: await eligibility.recentChecks(actor) }));
add("POST", "/v1/visit-intents", async (ctx) => {
  const b = await body(ctx, z.object({ eligibilityCheckId: uuid, quantity: z.number().int().min(1).max(1000).optional() }));
  const r = await visits.createVisitIntent(ctx.actor, b);
  return json(r, r.scanOutcome === "DUPLICATE" ? 200 : 201);
});
add("GET", "/v1/visit-intents/{id}", async (ctx) => visits.getIntent(ctx.actor, param(ctx, "id")));
add("POST", "/v1/visit-intents/{id}/otp/resend", async (ctx) => visits.resendVisitOtp(ctx.actor, param(ctx, "id")));
add("POST", "/v1/visit-intents/{id}/otp/verify", async (ctx) => {
  const b = await body(ctx, z.object({ code: z.string().max(10) }));
  return visits.confirmVisitOtp(ctx.actor, param(ctx, "id"), b.code);
});
add("POST", "/v1/visit-intents/{id}/authorize", async (ctx) => {
  const key = ctx.req.headers.get("idempotency-key");
  if (!key) throw new AppError("VALIDATION_FAILED", "Idempotency-Key header is required");
  const r = await visits.authorizeVisit(ctx.actor, param(ctx, "id"), key);
  return json(r, r.replay ? 200 : 201);
});
add("GET", "/v1/authorizations", async ({ actor, url }) => ({ items: await visits.listVisits(actor, { status: url.searchParams.get("status") ?? undefined }) }));
add("GET", "/v1/authorizations/receipts/{reference}", async (ctx) => visits.getReceipt(ctx.actor, z.string().regex(/^AUTH-[A-Z0-9]{8}$/).parse(ctx.params.reference)));
add("POST", "/v1/authorizations/{id}/complete", async (ctx) => visits.completeVisit(ctx.actor, param(ctx, "id"), await jsonBody(ctx.req)));
add("POST", "/v1/authorizations/{id}/cancel", async (ctx) => {
  const b = await body(ctx, z.object({ reason: z.string().min(3).max(300) }));
  return visits.cancelAuthorization(ctx.actor, param(ctx, "id"), b.reason);
});

// ───────────── claims ─────────────
const ClaimStatus = z.enum(["SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "DISPUTED", "SETTLED"]);
add("GET", "/v1/claims", async ({ actor, url }) => {
  const status = url.searchParams.getAll("status").map((s) => ClaimStatus.parse(s));
  return { items: await claims.listClaims(actor, { status: status.length ? status : undefined }) };
});
add("POST", "/v1/claims", async (ctx) => {
  const b = await body(ctx, claims.ClaimEvidenceInput.extend({ authorizationId: uuid }));
  return created(await claims.submitClaim(ctx.actor, b.authorizationId, b));
});
add("GET", "/v1/claims/{id}", async (ctx) => claims.getClaim(ctx.actor, param(ctx, "id")));
add("POST", "/v1/claims/{id}/review", async (ctx) => claims.startReview(ctx.actor, param(ctx, "id")));
add("POST", "/v1/claims/{id}/approve", async (ctx) => claims.approveClaim(ctx.actor, param(ctx, "id")));
add("POST", "/v1/claims/{id}/reject", async (ctx) => claims.rejectClaim(ctx.actor, param(ctx, "id"), await jsonBody(ctx.req)));
add("POST", "/v1/claims/{id}/adjust", async (ctx) => created(await claims.adjustClaim(ctx.actor, param(ctx, "id"), await jsonBody(ctx.req))));
add("POST", "/v1/claims/{id}/dispute", async (ctx) => claims.disputeClaim(ctx.actor, param(ctx, "id"), await jsonBody(ctx.req)));

// ───────────── settlements ─────────────
add("GET", "/v1/settlements", async ({ actor }) => ({ items: await settlements.listSettlements(actor) }));
add("POST", "/v1/settlements", async (ctx) => created(await settlements.createSettlement(ctx.actor, await jsonBody(ctx.req))));
add("GET", "/v1/settlements/ledger", async ({ actor, url }) => (url.searchParams.get("format") === "csv" ? csv(await reports.reconciliationCsv(actor), "provider-payable-ledger.csv") : { items: await settlements.payableLedger(actor) }));
add("GET", "/v1/settlements/{id}", async (ctx) => settlements.getSettlement(ctx.actor, param(ctx, "id")));
add("POST", "/v1/settlements/{id}/approve", async (ctx) => settlements.approveSettlement(ctx.actor, param(ctx, "id")));
add("POST", "/v1/settlements/{id}/cancel", async (ctx) => {
  const b = await body(ctx, z.object({ reason: z.string().min(3).max(300) }));
  return settlements.cancelSettlement(ctx.actor, param(ctx, "id"), b.reason);
});
add("POST", "/v1/settlements/{id}/payment", async (ctx) => settlements.recordPayment(ctx.actor, param(ctx, "id"), await jsonBody(ctx.req)));
add("POST", "/v1/settlements/{id}/reconcile", async (ctx) => settlements.reconcileSettlement(ctx.actor, param(ctx, "id"), await jsonBody(ctx.req)));
add("POST", "/v1/settlements/{id}/confirm-receipt", async (ctx) => settlements.providerConfirmReceipt(ctx.actor, param(ctx, "id")));
add("POST", "/v1/settlements/{id}/payment-instructions", async (ctx) => payments.issuePaymentInstructions(ctx.actor, param(ctx, "id")));
add("POST", "/v1/settlements/{id}/resolve-exception", async (ctx) => {
  const b = await body(ctx, z.object({ resolution: z.string().min(5).max(500) }));
  return payments.resolveSettlementException(ctx.actor, param(ctx, "id"), b.resolution);
});

// ───────────── verified payments ─────────────
add("GET", "/v1/payments/status", async ({ actor }) => {
  void actor;
  return paymentsStatus();
});
add("GET", "/v1/payments/banks", async ({ actor }) => ({ items: await payments.listBanks(actor) }));
add("GET", "/v1/payments/payout-accounts", async ({ actor }) => ({ items: await payments.listPayoutAccounts(actor) }));
add("POST", "/v1/payments/payout-accounts", async (ctx) => created(await payments.addPayoutAccount(ctx.actor, await jsonBody(ctx.req))));
add("POST", "/v1/payments/payout-accounts/{id}/cancel", async (ctx) => payments.cancelPayoutChange(ctx.actor, param(ctx, "id")));
add("POST", "/v1/payments/payout-accounts/{id}/review", async (ctx) => {
  const b = await body(ctx, z.object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().min(3).max(300) }));
  return payments.reviewPayoutAccount(ctx.actor, param(ctx, "id"), b);
});
add("GET", "/v1/payments/credits", async ({ actor, url }) => ({ items: await payments.listCredits(actor, { status: url.searchParams.get("status") ?? undefined }) }));
add("POST", "/v1/payments/credits/{id}/assign", async (ctx) => {
  const b = await body(ctx, z.object({ settlementId: uuid }));
  return payments.creditView(await payments.assignCredit(ctx.actor, param(ctx, "id"), b.settlementId));
});
add("POST", "/v1/payments/credits/{id}/resolve", async (ctx) => {
  const b = await body(ctx, z.object({ resolution: z.string().min(5).max(500) }));
  return payments.creditView(await payments.resolveCredit(ctx.actor, param(ctx, "id"), b.resolution));
});
add(
  "POST",
  "/v1/payments/webhooks/{partner}",
  async (ctx) => {
    const key = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).parse(ctx.params.partner);
    const raw = (await readBodyCapped(ctx.req, 256 * 1024)).toString("utf8");
    const r = await payments.receivePaymentWebhook(key, ctx.req.headers, raw, ctx.ip);
    return json(r, 200);
  },
  "webhook",
);

// ───────────── imports ─────────────
add("POST", "/v1/imports", async (ctx) => {
  // The body is read with a hard cap BEFORE multipart parsing, so an oversized upload never fills memory.
  const raw = await readBodyCapped(ctx.req, config().IMPORT_MAX_BYTES + 256 * 1024);
  const form = await new Response(new Uint8Array(raw), { headers: { "content-type": ctx.req.headers.get("content-type") ?? "" } }).formData().catch(() => {
    throw new AppError("VALIDATION_FAILED", "Send the file as multipart/form-data field 'file'");
  });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION_FAILED", "Missing 'file'");
  const mappingRaw = form.get("mapping");
  let mapping: Record<string, string> | undefined;
  try {
    mapping = typeof mappingRaw === "string" && mappingRaw ? z.record(z.string().max(100)).parse(JSON.parse(mappingRaw)) : undefined;
  } catch {
    throw new AppError("VALIDATION_FAILED", "'mapping' must be a JSON object of column names");
  }
  const dup = form.get("duplicatePhones");
  const options = { duplicatePhones: dup === "REJECT" ? ("REJECT" as const) : ("FLAG" as const) };
  return created(await imports.previewImport(ctx.actor, { fileName: file.name, data: Buffer.from(await file.arrayBuffer()), mapping, clientMime: file.type || null, options }));
});
add("GET", "/v1/imports", async ({ actor }) => ({ items: await imports.listImports(actor) }));
add("GET", "/v1/imports/{id}", async (ctx) => imports.getImport(ctx.actor, param(ctx, "id")));
add("GET", "/v1/imports/{id}/rows", async (ctx) =>
  imports.listImportRows(ctx.actor, param(ctx, "id"), { status: ctx.url.searchParams.get("status") ?? undefined, limit: Number(ctx.url.searchParams.get("limit") ?? 200), offset: Number(ctx.url.searchParams.get("offset") ?? 0) }),
);
add("GET", "/v1/imports/{id}/errors.csv", async (ctx) => csv(imports.errorsToCsv((await imports.getImport(ctx.actor, param(ctx, "id"))).errors), "import-errors.csv"));
add("GET", "/v1/imports/{id}/report.csv", async (ctx) => csv(await imports.importReportCsv(ctx.actor, param(ctx, "id")), "import-report.csv"));
add("POST", "/v1/imports/{id}/apply", async (ctx) => {
  const b = await body(ctx, z.object({ acceptIdentityChanges: z.boolean().optional() }));
  const r = await imports.applyImport(ctx.actor, param(ctx, "id"), b);
  return json(r, r.status === "QUEUED" || r.status === "PROCESSING" ? 202 : 200);
});
add("POST", "/v1/imports/{id}/apply-held", async (ctx) => imports.applyHeldRows(ctx.actor, param(ctx, "id")));
add("POST", "/v1/imports/{id}/cancel", async (ctx) => imports.cancelImport(ctx.actor, param(ctx, "id")));

// ───────────── integrations ─────────────
add("GET", "/v1/integrations/health", async ({ actor }) => integrations.integrationHealth(actor));
add("GET", "/v1/integrations", async ({ actor }) => ({ items: await integrations.listAllIntegrations(actor) }));
add("POST", "/v1/integrations", async (ctx) => created(await integrations.upsertIntegration(ctx.actor, await jsonBody(ctx.req))));
add("PUT", "/v1/integrations/{id}", async (ctx) => integrations.upsertIntegration(ctx.actor, await jsonBody(ctx.req), param(ctx, "id")));
add(
  "POST",
  "/v1/integrations/{id}/webhook",
  async (ctx) => {
    const raw = await ctx.req.text();
    if (raw.length > 2 * 1024 * 1024) throw new AppError("VALIDATION_FAILED", "Payload too large");
    const r = await integrations.receiveWebhook(param(ctx, "id"), ctx.req.headers, raw);
    return json(r, r.status === "DUPLICATE" ? 200 : 202);
  },
  "webhook",
);

// ───────────── audit, reports, admin ─────────────
add("GET", "/v1/audit", async ({ actor, url }) =>
  ({ items: await orgs.listAudit(actor, { entityType: url.searchParams.get("entityType") ?? undefined, entityId: url.searchParams.get("entityId") ?? undefined, orgId: url.searchParams.get("orgId") ?? undefined }) }),
);
add("GET", "/v1/reports/metrics", async ({ actor, url }) => reports.productMetrics(actor, Number(url.searchParams.get("days") ?? 30)));
add("GET", "/v1/reports/utilisation.csv", async ({ actor }) => csv(await reports.utilisationCsv(actor), "utilisation.csv"));
add("GET", "/v1/reports/reconciliation.csv", async ({ actor }) => csv(await reports.reconciliationCsv(actor), "reconciliation.csv"));
add("POST", "/v1/admin/housekeeping", async ({ actor }) => {
  requirePlatformAdmin(actor);
  const r = await visits.expireStale();
  await pruneRateLimits();
  await simulator.purgeSimulatorMessages();
  const staging = await imports.purgeImportStaging();
  const pay = await payments.paymentsHousekeeping();
  return { ...r, ...staging, ...pay };
});
add("GET", "/v1/admin/integrity", async ({ actor }) => integrity.integrityReportForAdmin(actor));

// ───────────── member self-service (no app) ─────────────
add(
  "POST",
  "/v1/member-access/start",
  async (ctx) => {
    const b = await body(ctx, z.object({ memberRef: z.string().max(20), phone: z.string().max(20) }));
    return memberPortal.startMemberAccess({ ...b, ip: ctx.ip });
  },
  "public",
);
add(
  "POST",
  "/v1/member-access/verify",
  async (ctx) => {
    const b = await body(ctx, z.object({ challengeId: uuid, code: z.string().max(10) }));
    const s = await memberPortal.completeMemberAccess(b.challengeId, b.code);
    return json({ ok: true, expiresInSeconds: s.maxAgeSeconds }, 200, { "set-cookie": sessionCookie(s.token, s.maxAgeSeconds, memberPortal.MEMBER_COOKIE) });
  },
  "public",
);
add("GET", "/v1/member-access/me", async (ctx) => memberPortal.memberOverview(memberIdFrom(ctx)), "member");
add("POST", "/v1/member-access/qr", async (ctx) => {
  const r = await memberPortal.memberQr(memberIdFrom(ctx));
  return { qrSvg: r.qrSvg, qrPayload: r.qrPayload, expiresAt: r.expiresAt };
}, "member");
add("POST", "/v1/member-access/logout", async () => json({ ok: true }, 200, { "set-cookie": clearCookie(memberPortal.MEMBER_COOKIE) }), "public");

// ───────────── phone simulator (only while SMS is simulated) ─────────────
add(
  "GET",
  "/v1/simulator/messages",
  async (ctx) => {
    const { actor } = await authenticate(ctx.req);
    simulator.assertSimulatorAccess(actor);
    const phone = ctx.url.searchParams.get("phone") ?? undefined;
    return { sms: smsStatus(), phones: await simulator.simulatorPhones(), messages: await simulator.simulatorMessages(phone) };
  },
  "public",
);

// ───────────── bank simulator (only while payments are simulated) ─────────────
add(
  "GET",
  "/v1/simulator/bank",
  async (ctx) => {
    const { actor } = await authenticate(ctx.req);
    payments.assertBankSimulatorAccess(actor);
    return payments.simOverview();
  },
  "public",
);
add(
  "POST",
  "/v1/simulator/bank/accounts",
  async (ctx) => {
    const { actor } = await authenticate(ctx.req);
    payments.assertBankSimulatorAccess(actor);
    return created(await payments.simCreateBankAccount(await jsonBody(ctx.req)));
  },
  "public",
);
add(
  "POST",
  "/v1/simulator/bank/transfers",
  async (ctx) => {
    const { actor } = await authenticate(ctx.req);
    payments.assertBankSimulatorAccess(actor);
    return created(await payments.simTransfer(await jsonBody(ctx.req)));
  },
  "public",
);

function memberIdFrom(ctx: ApiContext): string {
  const id = memberPortal.verifyMemberSessionToken(readCookie(ctx.req, memberPortal.MEMBER_COOKIE));
  if (!id) throw new AppError("UNAUTHENTICATED", "Please verify your phone again");
  return id;
}

export const ROUTES = routes.map((r) => ({ method: r.method, pattern: r.pattern, auth: r.auth }));

/** Dispatches a Request whose path starts with /v1 (or /api/v1). */
export async function handle(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api(?=\/v1)/, "").replace(/\/$/, "");
    const candidates = routes.filter((r) => r.regex.test(path));
    if (candidates.length === 0) throw new AppError("NOT_FOUND", "No such endpoint");
    const route = candidates.find((r) => r.method === req.method);
    if (!route) return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }, 405, { allow: candidates.map((c) => c.method).join(", ") });
    const m = path.match(route.regex)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const ctx: ApiContext = { req, url, params, ip: clientIp(req), actor: null, viaCookie: false };
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);

    if (route.auth === "user") {
      const { actor, viaCookie } = await authenticate(req);
      if (!actor) throw new AppError("UNAUTHENTICATED", "Sign in required");
      if (viaCookie && mutating) assertSameOrigin(req);
      const out = await (route.handler as Handler)({ ...ctx, actor, viaCookie });
      return out instanceof Response ? out : json(out);
    }
    if (route.auth === "member" && mutating) assertSameOrigin(req);
    if (route.auth === "public" && mutating) assertSameOriginIfPresent(req);
    const out = await (route.handler as PublicHandler)(ctx);
    return out instanceof Response ? out : json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
