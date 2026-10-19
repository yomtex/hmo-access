import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { login, resolveSession, logout } from "@/lib/server/auth/session";
import { RestMemberConnector } from "@/lib/server/connectors/http";
import { checkEligibility, setLiveConnectorResolverForTests } from "@/lib/server/services/eligibility";
import { integrationHealth, receiveWebhook, signWebhook, upsertIntegration } from "@/lib/server/services/integrations";
import { setOrganizationStatus, inviteStaff, setStaffStatus } from "@/lib/server/services/organizations";
import { authorizeVisit, createVisitIntent } from "@/lib/server/services/visits";
import { installSms, makeWorld, phone, platformAdmin, uid } from "./helpers/factory";

describe("HMO live connector (reference REST adapter)", () => {
  let server: http.Server;
  let base: string;
  let mode: "ok" | "hang" | "500" | "suspended" = "ok";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (mode === "hang") return; // never respond
      if (mode === "500") return res.writeHead(500).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: mode === "suspended" ? "SUSPENDED" : "ACTIVE" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    setLiveConnectorResolverForTests(null);
    server.closeAllConnections();
    server.close();
  });

  it("timeouts and errors make eligibility UNVERIFIABLE (fail closed) and block authorization", async () => {
    installSms();
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 5, period: { type: "WEEK" } }], memberConfirmation: "NONE" } });
    const connector = new RestMemberConnector({ baseUrl: base, memberPath: "/members/{memberNumber}", timeoutMs: 300, realtimeLookup: true, fieldMap: { memberStatus: "status" } }, undefined);
    setLiveConnectorResolverForTests(async (hmoOrgId) => (hmoOrgId === w.hmo.org.id ? connector : null));
    const lookup = { method: "MEMBER_REF" as const, memberRef: w.members[0].shortRef };

    mode = "ok";
    const ok = await checkEligibility(w.provider.desk, { lookup });
    expect(ok.results[0].decision).toBe("ELIGIBLE");
    const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: ok.results[0].eligibilityCheckId });

    mode = "hang";
    const t0 = Date.now();
    const down = await checkEligibility(w.provider.desk, { lookup });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(down.results[0].decision).toBe("UNVERIFIABLE");
    expect(down.results[0].reasons.map((r) => r.code)).toContain("SOURCE_UNAVAILABLE");
    // Authorization rechecks the source: an outage between check and authorization blocks it.
    await expect(authorizeVisit(w.provider.desk, intent.id, "idem-timeout-0001")).rejects.toMatchObject({ code: "NOT_ELIGIBLE", retryable: true });

    mode = "500";
    expect((await checkEligibility(w.provider.desk, { lookup })).results[0].decision).toBe("UNVERIFIABLE");

    mode = "suspended";
    const s = await checkEligibility(w.provider.desk, { lookup });
    expect(s.results[0].decision).toBe("INELIGIBLE");
    expect(s.results[0].reasons.map((r) => r.code)).toContain("MEMBER_SUSPENDED");
    setLiveConnectorResolverForTests(null);
  });

  it("stale imported data is UNVERIFIABLE", async () => {
    installSms();
    const w = await makeWorld();
    await db.update(schema.members).set({ lastSyncedAt: new Date(Date.now() - 400 * 3600_000) }).where(eq(schema.members.id, w.members[0].id));
    const r = await checkEligibility(w.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef } });
    expect(r.results[0].decision).toBe("UNVERIFIABLE");
    expect(r.results[0].reasons.map((x) => x.code)).toContain("DATA_STALE");
    const health = await integrationHealth(w.hmo.admin);
    expect(health.members.stale).toBe(1);
  });
});

describe("signed webhook connector", () => {
  it("verifies signatures, applies member updates, and de-duplicates events", async () => {
    const w = await makeWorld();
    process.env.TEST_WEBHOOK_SECRET = "s3cret-for-tests-only-0123456789abcdef";
    const integ = await upsertIntegration(await platformAdmin(), { hmoOrgId: w.hmo.org.id, kind: "WEBHOOK", name: "Push", status: "ACTIVE", secretRef: "TEST_WEBHOOK_SECRET" });
    const num = `W-${uid()}`;
    const body = JSON.stringify({ eventType: "members.upsert", members: [{ memberNumber: num, firstName: "Kemi", lastName: "Adeyemi", phone: phone(), planCode: w.plan.code, coverageStart: "2025-01-01" }] });
    const headers = (sig: string, id = "evt-000001") => new Headers({ "x-hmoa-signature": `sha256=${sig}`, "x-hmoa-event-id": id });

    await expect(receiveWebhook(integ.id, headers("0".repeat(64)), body)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const good = signWebhook(process.env.TEST_WEBHOOK_SECRET, body);
    const r1 = await receiveWebhook(integ.id, headers(good), body);
    expect(r1.status).toBe("PROCESSED");
    const r2 = await receiveWebhook(integ.id, headers(good), body);
    expect(r2.status).toBe("DUPLICATE");
    const m = await db.query.members.findFirst({ where: eq(schema.members.memberNumber, num) });
    expect(m?.hmoOrgId).toBe(w.hmo.org.id);

    // Tampered body fails; failed events can be retried with a valid payload.
    const bad = JSON.stringify({ eventType: "members.upsert", members: [{ memberNumber: "x", firstName: "a", lastName: "b", phone: "1", planCode: "NOPE", coverageStart: "x" }] });
    await expect(receiveWebhook(integ.id, headers(signWebhook(process.env.TEST_WEBHOOK_SECRET, bad), "evt-000002"), bad)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await receiveWebhook(integ.id, headers(good, "evt-000002"), body)).status).toBe("PROCESSED");
  });

  it("only platform admins configure outbound connectors; unimplemented kinds cannot be activated", async () => {
    const w = await makeWorld();
    await expect(upsertIntegration(w.hmo.admin, { hmoOrgId: w.hmo.org.id, kind: "REST_API", name: "x", config: { baseUrl: "http://169.254.169.254" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(upsertIntegration(await platformAdmin(), { hmoOrgId: w.hmo.org.id, kind: "FHIR", name: "FHIR feed", status: "ACTIVE" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("authentication and sessions", () => {
  it("logs in, locks out after repeated failures, and honours logout and suspension", async () => {
    const w = await makeWorld();
    const email = `staff-${uid()}@test.local`;
    const inv = await inviteStaff(w.hmo.admin, { email, name: "Finance Person", roleKey: "HMO_CLAIMS" });
    const ip = `10.0.0.${Math.floor(Math.random() * 250)}`;
    await expect(login(email, "wrong-password-123", ip)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(login(`nobody-${uid()}@test.local`, "whatever-password", ip)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const { token } = await login(email, inv.temporaryPassword!, ip);
    const actor = await resolveSession(token);
    expect(actor?.roleKey).toBe("HMO_CLAIMS");
    expect(actor?.permissions.has("claims:review")).toBe(true);
    expect(actor?.permissions.has("benefits:manage")).toBe(false);

    await logout(token);
    expect(await resolveSession(token)).toBeNull();

    for (let i = 0; i < 5; i++) await login(email, "wrong-password-123", ip).catch(() => undefined);
    await expect(login(email, inv.temporaryPassword!, ip)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });

    // Suspending the organization invalidates existing sessions immediately.
    await db.update(schema.users).set({ lockedUntil: null }).where(eq(schema.users.email, email));
    const { token: t2 } = await login(email, inv.temporaryPassword!, ip);
    await setOrganizationStatus(await platformAdmin(), w.hmo.org.id, "SUSPENDED", "test");
    expect(await resolveSession(t2)).toBeNull();
    await setOrganizationStatus(await platformAdmin(), w.hmo.org.id, "ACTIVE", "test");
    expect(await resolveSession(t2)).not.toBeNull();

    // Disabling a staff member revokes their sessions.
    await setStaffStatus(w.hmo.admin, inv.membershipId, "INACTIVE");
    expect(await resolveSession(t2)).toBeNull();
  });

  it("garbage tokens resolve to nothing", async () => {
    expect(await resolveSession("")).toBeNull();
    expect(await resolveSession("x".repeat(43))).toBeNull();
    expect(await resolveSession(null)).toBeNull();
  });
});
