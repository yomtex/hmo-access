import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { applyImport, cancelImport, previewImport } from "@/lib/server/services/imports";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { completeVisit } from "@/lib/server/services/visits";
import { connectNetwork, csvOf, installSms, makeCatalog, makeHmo, makeProvider, phone, uid, type CapturingSms } from "./helpers/factory";
import { verifyAndAuthorize } from "./helpers/flow";

describe("member CSV / Excel import", () => {
  let hmo: Awaited<ReturnType<typeof makeHmo>>;
  let cat: Awaited<ReturnType<typeof makeCatalog>>;
  let sms: CapturingSms;
  beforeAll(async () => {
    sms = installSms();
    hmo = await makeHmo();
    cat = await makeCatalog(hmo.admin);
  });

  it("previews with row-level errors and applies only valid rows", async () => {
    const good = { member_number: `E-${uid()}`, first_name: "Chidi", last_name: "Eze", phone: phone(), plan_code: cat.plan.code, coverage_start: "01/01/2025" };
    const data = csvOf([
      good,
      { member_number: `E-${uid()}`, first_name: "Bad", last_name: "Phone", phone: "12", plan_code: cat.plan.code, coverage_start: "2025-01-01" },
      { member_number: `E-${uid()}`, first_name: "No", last_name: "Plan", phone: phone(), plan_code: "NOPE", coverage_start: "2025-01-01" },
      { member_number: `E-${uid()}`, first_name: "Bad", last_name: "Date", phone: phone(), plan_code: cat.plan.code, coverage_start: "31/02/2025" },
      { member_number: `E-${uid()}`, first_name: "Ends", last_name: "Early", phone: phone(), plan_code: cat.plan.code, coverage_start: "2025-05-01", coverage_end: "2025-04-01" },
      { ...good }, // duplicate of row 2
      { member_number: `E-${uid()}`, first_name: "=CMD()", last_name: "Inject", phone: phone(), plan_code: cat.plan.code, coverage_start: "2025-01-01" },
    ]);
    const p = await previewImport(hmo.admin, { fileName: "batch.csv", data });
    expect(p.job.status).toBe("PREVIEWED");
    expect(p.job.totalRows).toBe(7);
    expect(p.job.validRows).toBe(1);
    const codes = p.errors.map((e) => `${e.row}:${e.code}`);
    expect(codes).toEqual(expect.arrayContaining(["3:INVALID_PHONE", "4:UNKNOWN_PLAN", "5:INVALID_DATE", "6:END_BEFORE_START", "7:DUPLICATE_IN_FILE", "8:INVALID_FORMAT"]));

    // Nothing applied by preview.
    expect(await db.query.members.findFirst({ where: and(eq(schema.members.hmoOrgId, hmo.org.id), eq(schema.members.memberNumber, good.member_number)) })).toBeUndefined();

    const r = await applyImport(hmo.admin, p.job.id);
    expect(r.summary).toMatchObject({ membersCreated: 1, coverageCreated: 1 });
    const m = await db.query.members.findFirst({ where: and(eq(schema.members.hmoOrgId, hmo.org.id), eq(schema.members.memberNumber, good.member_number)) });
    expect(m?.phoneEnc).toMatch(/^v1\./); // encrypted at rest
    expect(m?.phoneEnc).not.toContain(good.phone.slice(-6));
    const job = await db.query.importJobs.findFirst({ where: eq(schema.importJobs.id, p.job.id) });
    expect(job?.stagedRows).toBeNull(); // staged PII cleared after apply
  });

  it("is idempotent: re-applying a job or re-uploading identical content changes nothing", async () => {
    const data = csvOf([{ member_number: `E-${uid()}`, first_name: "Ngozi", last_name: "Bello", phone: phone(), plan_code: cat.plan.code, coverage_start: "2025-01-01" }]);
    const p1 = await previewImport(hmo.admin, { fileName: "a.csv", data });
    const r1 = await applyImport(hmo.admin, p1.job.id);
    const r1b = await applyImport(hmo.admin, p1.job.id);
    expect(r1b.idempotentReplay).toBe(true);
    const p2 = await previewImport(hmo.admin, { fileName: "a-again.csv", data });
    expect(p2.duplicateOfAppliedJob).toBe(p1.job.id);
    const r2 = await applyImport(hmo.admin, p2.job.id);
    expect(r2).toMatchObject({ idempotentReplay: true, jobId: r1.jobId });
  });

  it("concurrent applies of the same job apply once", async () => {
    const data = csvOf([{ member_number: `E-${uid()}`, first_name: "Tolu", last_name: "Ade", phone: phone(), plan_code: cat.plan.code, coverage_start: "2025-01-01" }]);
    const p = await previewImport(hmo.admin, { fileName: "c.csv", data });
    const rs = await Promise.all([applyImport(hmo.admin, p.job.id), applyImport(hmo.admin, p.job.id), applyImport(hmo.admin, p.job.id)]);
    expect(rs.filter((r) => !r.idempotentReplay)).toHaveLength(1);
  });

  it("fails clearly when required columns are missing, and can be cancelled", async () => {
    const p = await previewImport(hmo.admin, { fileName: "bad.csv", data: Buffer.from("name,phone\nA,080\n") });
    expect(p.job.status).toBe("FAILED");
    expect(p.missingColumns).toEqual(expect.arrayContaining(["member_number", "plan_code", "coverage_start"]));
    await expect(applyImport(hmo.admin, p.job.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const ok = await previewImport(hmo.admin, { fileName: "x.csv", data: csvOf([{ member_number: `E-${uid()}`, first_name: "A", last_name: "B", phone: phone(), plan_code: cat.plan.code, coverage_start: "2025-01-01" }]) });
    expect((await cancelImport(hmo.admin, ok.job.id)).status).toBe("CANCELLED");
  });

  it("rejects unsupported and oversized files", async () => {
    await expect(previewImport(hmo.admin, { fileName: "m.pdf", data: Buffer.from("x") })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(previewImport(hmo.admin, { fileName: "m.csv", data: Buffer.alloc(6 * 1024 * 1024, 65) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("reads Excel files with header aliases and date cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Enrollees");
    ws.addRow(["Enrollee ID", "First Name", "Surname", "Mobile", "Plan", "Start Date", "Group"]);
    ws.addRow([`X-${uid()}`, "Bola", "Tinubu-Ade", "+2348031234567", cat.plan.code, new Date(Date.UTC(2025, 0, 1)), "ACME LTD"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const p = await previewImport(hmo.admin, { fileName: "enrollees.xlsx", data: buf });
    expect(p.errors).toEqual([]);
    expect(p.previewRows[0]).toMatchObject({ planCode: cat.plan.code, memberGroup: "ACME LTD" });
    expect(p.previewRows[0].coverageStart.toISOString()).toBe("2024-12-31T23:00:00.000Z"); // 1 Jan 00:00 WAT
  });

  it("flags retroactive coverage reductions instead of silently reversing visits", async () => {
    const provider = await makeProvider();
    await connectNetwork(hmo.admin, provider, cat.benefit.id);
    const num = `R-${uid()}`;
    const row = { member_number: num, first_name: "Femi", last_name: "Kuti", phone: phone(), plan_code: cat.plan.code, coverage_start: "2024-01-01" };
    const p1 = await previewImport(hmo.admin, { fileName: "r1.csv", data: csvOf([row]) });
    await applyImport(hmo.admin, p1.job.id);
    const member = (await db.query.members.findFirst({ where: and(eq(schema.members.hmoOrgId, hmo.org.id), eq(schema.members.memberNumber, num)) }))!;
    const { authorization } = await verifyAndAuthorize(provider.desk, member.shortRef, sms);
    await completeVisit(provider.desk, authorization!.id, { attendanceConfirmed: true });

    const p2 = await previewImport(hmo.admin, { fileName: "r2.csv", data: csvOf([{ ...row, coverage_end: "2024-12-31" }]) });
    const r = await applyImport(hmo.admin, p2.job.id);
    expect(r.summary!.retroactiveConflicts).toEqual([{ authorizationRef: authorization!.reference, memberNumber: num, reason: "COVERAGE_END_MOVED_EARLIER" }]);
    const a = await db.query.authorizations.findFirst({ where: eq(schema.authorizations.id, authorization!.id) });
    expect(a?.status).toBe("COMPLETED"); // not silently reversed
    // ...but new eligibility checks now fail.
    const check = await checkEligibility(provider.desk, { lookup: { method: "MEMBER_REF", memberRef: member.shortRef } });
    expect(check.results[0].reasons.map((x) => x.code)).toContain("NO_ACTIVE_COVERAGE");
  });
});
