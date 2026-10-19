/** HTTP layer: auth, CSRF, error shapes, idempotency headers, multipart import — via the real router. */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { handle, ROUTES } from "@/lib/server/api/router";
import { inviteStaff } from "@/lib/server/services/organizations";
import { csvOf, installSms, makeWorld, phone, uid, type CapturingSms } from "./helpers/factory";

const BASE = "http://localhost:3000";
type Opts = { token?: string; cookie?: string; origin?: string; body?: unknown; headers?: Record<string, string> };
async function call(method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin) headers.origin = o.origin;
  let body: BodyInit | undefined;
  if (o.body instanceof FormData) body = o.body;
  else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  const res = await handle(new Request(BASE + path, { method, headers, body }));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

describe("REST API v1", () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  let sms: CapturingSms;
  let deskToken: string;
  let hmoToken: string;

  beforeAll(async () => {
    sms = installSms();
    w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 3, period: { type: "WEEK" } }] } });
    const desk = await inviteStaff(w.provider.admin, { email: `api-desk-${uid()}@test.local`, name: "API Desk", roleKey: "PROVIDER_FRONT_DESK", locationIds: [w.provider.locations[0].id] });
    const hmoUser = await inviteStaff(w.hmo.admin, { email: `api-hmo-${uid()}@test.local`, name: "API HMO", roleKey: "HMO_ADMIN" });
    const l1 = await call("POST", "/v1/auth/login", { body: { email: desk.email, password: desk.temporaryPassword }, headers: { "x-forwarded-for": `9.9.9.${Math.floor(Math.random() * 200)}` } });
    expect(l1.status).toBe(200);
    expect(l1.headers.get("set-cookie")).toMatch(/hmoa_session=.*HttpOnly; SameSite=Lax/);
    deskToken = l1.json.token;
    const l2 = await call("POST", "/v1/auth/login", { body: { email: hmoUser.email, password: hmoUser.temporaryPassword }, headers: { "x-forwarded-for": `9.9.8.${Math.floor(Math.random() * 200)}` } });
    hmoToken = l2.json.token;
    await call("POST", "/v1/auth/select-location", { token: deskToken, body: { locationId: w.provider.locations[0].id } });
  });

  it("requires authentication and returns consistent error shapes", async () => {
    const r = await call("GET", "/v1/members");
    expect(r.status).toBe(401);
    expect(r.json.error).toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await call("GET", "/v1/nope", { token: deskToken })).status).toBe(404);
    expect((await call("DELETE", "/v1/members", { token: hmoToken })).status).toBe(405);
    const bad = await call("POST", "/v1/eligibility/checks", { token: deskToken, body: { lookup: { method: "FAX" } } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("VALIDATION_FAILED");
    expect((await call("GET", "/v1/members", { token: deskToken })).status).toBe(403);
  });

  it("runs check → intent → OTP → authorize over HTTP with idempotency", async () => {
    const check = await call("POST", "/v1/eligibility/checks", { token: deskToken, body: { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef } } });
    expect(check.status).toBe(200);
    expect(check.json.results[0].decision).toBe("ELIGIBLE");
    const intent = await call("POST", "/v1/visit-intents", { token: deskToken, body: { eligibilityCheckId: check.json.results[0].eligibilityCheckId } });
    expect(intent.status).toBe(201);
    expect(intent.json.otp.status).toBe("SENT");
    const verify = await call("POST", `/v1/visit-intents/${intent.json.id}/otp/verify`, { token: deskToken, body: { code: sms.lastCode() } });
    expect(verify.json.status).toBe("CONFIRMED");
    expect((await call("POST", `/v1/visit-intents/${intent.json.id}/authorize`, { token: deskToken })).status).toBe(422);
    const a1 = await call("POST", `/v1/visit-intents/${intent.json.id}/authorize`, { token: deskToken, headers: { "idempotency-key": "http-idem-00001" } });
    const a2 = await call("POST", `/v1/visit-intents/${intent.json.id}/authorize`, { token: deskToken, headers: { "idempotency-key": "http-idem-00001" } });
    expect(a1.status).toBe(201);
    expect(a2.status).toBe(200);
    expect(a2.json.authorization.reference).toBe(a1.json.authorization.reference);
    const done = await call("POST", `/v1/authorizations/${a1.json.authorization.id}/complete`, { token: deskToken, body: { attendanceConfirmed: true } });
    expect(done.json.claim.status).toBe("SUBMITTED");
    const receipt = await call("GET", `/v1/authorizations/receipts/${a1.json.authorization.reference}`, { token: deskToken });
    expect(receipt.json.status).toBe("COMPLETED");
  });

  it("rejects cross-site cookie-authenticated writes (CSRF) but allows same-origin", async () => {
    const cookie = `hmoa_session=${encodeURIComponent(hmoToken)}`;
    const evil = await call("POST", "/v1/plans", { cookie, origin: "https://evil.example", body: { code: "EVIL", name: "Evil plan" } });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe("CSRF_REJECTED");
    const none = await call("POST", "/v1/plans", { cookie, body: { code: "EVIL2", name: "Evil plan" } });
    expect(none.status).toBe(403);
    const ok = await call("POST", "/v1/plans", { cookie, origin: BASE, body: { code: `SAME${uid().toUpperCase()}`, name: "Same-origin plan" } });
    expect(ok.status).toBe(201);
    // Browsers send Sec-Fetch-Site; it takes precedence and cannot be forged by page scripts.
    expect((await call("POST", "/v1/plans", { cookie, headers: { "sec-fetch-site": "cross-site" }, origin: BASE, body: { code: "EVIL3", name: "Evil plan" } })).status).toBe(403);
    expect((await call("POST", "/v1/plans", { cookie, headers: { "sec-fetch-site": "same-origin" }, body: { code: `SFS${uid().toUpperCase()}`, name: "Fetch-metadata plan" } })).status).toBe(201);
    expect((await call("POST", "/v1/plans", { cookie, origin: "null", body: { code: "EVIL4", name: "Evil plan" } })).status).toBe(403);
    // Reads with the cookie are fine without Origin.
    expect((await call("GET", "/v1/plans", { cookie })).status).toBe(200);
  });

  it("uploads a member file as multipart and applies it", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(csvOf([{ member_number: `API-${uid()}`, first_name: "Ife", last_name: "Oluwa", phone: phone(), plan_code: w.plan.code, coverage_start: "2025-01-01" }]))]), "api.csv");
    const p = await call("POST", "/v1/imports", { token: hmoToken, body: fd });
    expect(p.status).toBe(201);
    expect(p.json.job.validRows).toBe(1);
    const a = await call("POST", `/v1/imports/${p.json.job.id}/apply`, { token: hmoToken });
    expect(a.json.summary.membersCreated).toBe(1);
    const errs = await call("GET", `/v1/imports/${p.json.job.id}/errors.csv`, { token: hmoToken });
    expect(errs.status).toBe(200);
  });

  it("validates benefit rules without saving and exposes metrics and CSV exports", async () => {
    const v = await call("POST", "/v1/benefits/validate-rules", { token: hmoToken, body: { limits: [{ metric: "VISITS", maximum: 5, period: { type: "MONTH" } }] } });
    expect(v.json).toMatchObject({ valid: true, summary: "5 visits per calendar month" });
    const bad = await call("POST", "/v1/benefits/validate-rules", { token: hmoToken, body: {} });
    expect(bad.json.valid).toBe(false);
    const m = await call("GET", "/v1/reports/metrics", { token: hmoToken });
    expect(m.json.completedVisits).toBeGreaterThanOrEqual(1);
    expect(m.json.revenuePerCustomer).toBeNull();
    const csv = await call("GET", "/v1/reports/utilisation.csv", { token: hmoToken });
    expect(String(csv.json)).toContain("authorization_ref");
  });

  it("does not leak internals on unexpected errors", async () => {
    const r = await call("GET", "/v1/members/not-a-uuid", { token: hmoToken });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json)).not.toMatch(/stack|at .*\.ts/);
  });

  it("openapi.yaml parses and documents exactly the implemented routes", async () => {
    const fs = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const spec = parse(await fs.readFile(new URL("../docs/api/openapi.yaml", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();
    const implemented = ROUTES.map((r) => `${r.method} ${r.pattern}`).sort();
    expect(documented).toEqual(implemented);
  });

  it("password change needs the current password, enforces the policy and signs out other sessions", async () => {
    const u = await inviteStaff(w.hmo.admin, { email: `api-pw-${uid()}@test.local`, name: "Pw User", roleKey: "HMO_VIEWER" });
    const a = await call("POST", "/v1/auth/login", { body: { email: u.email, password: u.temporaryPassword }, headers: { "x-forwarded-for": "9.9.7.2" } });
    const b = await call("POST", "/v1/auth/login", { body: { email: u.email, password: u.temporaryPassword }, headers: { "x-forwarded-for": "9.9.7.2" } });
    expect((await call("POST", "/v1/auth/password", { token: a.json.token, body: { currentPassword: "wrong", newPassword: "a-much-better-password-1" } })).status).toBe(401);
    expect((await call("POST", "/v1/auth/password", { token: a.json.token, body: { currentPassword: u.temporaryPassword, newPassword: "short" } })).status).toBe(422);
    expect((await call("POST", "/v1/auth/password", { token: a.json.token, body: { currentPassword: u.temporaryPassword, newPassword: "a-much-better-password-1" } })).status).toBe(200);
    expect((await call("GET", "/v1/auth/me", { token: a.json.token })).status).toBe(200);
    expect((await call("GET", "/v1/auth/me", { token: b.json.token })).status).toBe(401);
    expect((await call("POST", "/v1/auth/login", { body: { email: u.email, password: "a-much-better-password-1" }, headers: { "x-forwarded-for": "9.9.7.3" } })).status).toBe(200);
  });

  it("logout revokes the bearer token", async () => {
    const u = await inviteStaff(w.hmo.admin, { email: `api-tmp-${uid()}@test.local`, name: "Temp", roleKey: "HMO_VIEWER" });
    const l = await call("POST", "/v1/auth/login", { body: { email: u.email, password: u.temporaryPassword }, headers: { "x-forwarded-for": "9.9.7.1" } });
    expect((await call("GET", "/v1/auth/me", { token: l.json.token })).status).toBe(200);
    await call("POST", "/v1/auth/logout", { token: l.json.token });
    expect((await call("GET", "/v1/auth/me", { token: l.json.token })).status).toBe(401);
    const user = await db.query.users.findFirst({ where: eq(schema.users.email, u.email) });
    expect(user?.passwordHash.startsWith("$argon2id$")).toBe(true);
  });
});
