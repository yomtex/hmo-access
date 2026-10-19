/**
 * The sample files published in docs/integration/samples must behave exactly as the HMO integration
 * guide says, so the guide cannot drift from the code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { createPlan } from "@/lib/server/services/catalog";
import { applyImport, previewImport } from "@/lib/server/services/imports";
import { receiveWebhook, signWebhook, upsertIntegration } from "@/lib/server/services/integrations";
import { installSms, makeHmo, platformAdmin } from "./helpers/factory";

const sample = (f: string) => readFileSync(path.resolve(__dirname, "../docs/integration/samples", f));
let hmo: Awaited<ReturnType<typeof makeHmo>>;

beforeAll(async () => {
  installSms();
  hmo = await makeHmo("Samples");
  await createPlan(hmo.admin, { code: "CORP-GOLD", name: "Corporate Gold" });
  await createPlan(hmo.admin, { code: "CORP-SILVER", name: "Corporate Silver" });
});

describe("published integration samples", () => {
  it("members-valid.csv: 6 rows, no errors, all new", async () => {
    const p = await previewImport(hmo.admin, { fileName: "members-valid.csv", data: sample("members-valid.csv") });
    expect(p.errors).toEqual([]);
    expect(p.counts).toEqual({ new: 6, update: 0, unchanged: 0, conflict: 0 });
    const r = await applyImport(hmo.admin, p.job.id);
    expect(r.status).toBe("APPLIED");
  });

  it("members-valid.xlsx (header aliases, Excel date cells): the same 6 members, unchanged", async () => {
    const p = await previewImport(hmo.admin, { fileName: "members-valid.xlsx", data: sample("members-valid.xlsx") });
    expect(p.errors).toEqual([]);
    expect(p.counts).toEqual({ new: 0, update: 0, unchanged: 6, conflict: 0 });
  });

  it("members-with-errors.csv: exactly the errors listed in the guide", async () => {
    const p = await previewImport(hmo.admin, { fileName: "members-with-errors.csv", data: sample("members-with-errors.csv") });
    const got = p.errors.map((e) => `${e.row}:${e.code}`);
    expect(got).toEqual(["3:REQUIRED", "4:INVALID_PHONE", "5:UNKNOWN_PLAN", "6:INVALID_DATE", "7:END_BEFORE_START", "8:INVALID_STATUS", "9:INVALID_FORMAT", "10:DUPLICATE_IN_FILE", "11:CONFLICT_IN_FILE", "12:INVALID_FORMAT"]);
    expect(p.counts.new).toBe(1); // row 2 only
  });

  it("webhook-members-upsert.json is accepted when correctly signed", async () => {
    const p = await platformAdmin();
    process.env.SAMPLES_WEBHOOK_SECRET = "sample-secret-for-tests-only-0123456789";
    const integ = await upsertIntegration(p, { hmoOrgId: hmo.org.id, kind: "WEBHOOK", name: "Samples push", status: "ACTIVE", secretRef: "SAMPLES_WEBHOOK_SECRET" });
    const body = sample("webhook-members-upsert.json").toString("utf8");
    const headers = new Headers({ "x-hmoa-event-id": "samples-0001", "x-hmoa-signature": `sha256=${signWebhook(process.env.SAMPLES_WEBHOOK_SECRET, body)}` });
    const r = await receiveWebhook(integ.id, headers, body);
    expect(r.status).toBe("PROCESSED");
    const m = await db.query.members.findFirst({ where: eq(schema.members.memberNumber, "SHD/2026/4104") });
    const cov = await db.query.planMemberships.findFirst({ where: eq(schema.planMemberships.memberId, m!.id) });
    expect(cov?.status).toBe("SUSPENDED");
  });
});
