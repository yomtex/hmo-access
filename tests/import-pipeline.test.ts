/**
 * Import pipeline: duplicate and conflict rules, held identity changes, background processing in
 * batches, retries / crashes / concurrent workers without double-applying, partial failures and
 * rollback.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { resetConfigCache } from "@/lib/server/config";
import { claimJobFor, runClaimedJob, runJobsUntilIdle } from "@/lib/server/jobs/queue";
import { applyHeldRows, applyImport, getImport, IMPORT_JOB_KIND, listImportRows, previewImport, processImportJob, setImportRowHookForTests } from "@/lib/server/services/imports";
import { csvOf, installSms, makeHmo, makeCatalog, makeWorld, phone, uid, type MemberRow } from "./helpers/factory";

type World = Awaited<ReturnType<typeof makeWorld>>;
let w: World;
const mk = (over: Partial<MemberRow> = {}): MemberRow => ({ member_number: `P-${uid()}`, first_name: "Kemi", last_name: "Adewale", phone: phone(), plan_code: w.plan.code, coverage_start: "2024-01-01", ...over });
const preview = (rows: MemberRow[], options?: { duplicatePhones?: "FLAG" | "REJECT" }) => previewImport(w.hmo.admin, { fileName: `f-${uid()}.csv`, data: csvOf(rows), options });
const membersOf = (hmoOrgId: string) => db.select().from(schema.members).where(eq(schema.members.hmoOrgId, hmoOrgId));

beforeAll(async () => {
  installSms();
  w = await makeWorld({ members: 1 });
});
afterEach(() => {
  setImportRowHookForTests(null);
  delete process.env.IMPORT_INLINE_MAX_ROWS;
  delete process.env.IMPORT_BATCH_SIZE;
  resetConfigCache();
});

describe("duplicates inside the file", () => {
  it("normalises phone formats and flags one phone on several members (FLAG) or refuses those rows (REJECT)", async () => {
    const shared = "0803 555 0101";
    const rows = [mk({ phone: shared }), mk({ phone: "+234 803-555-0101" }), mk({ phone: "(0803) 5550101" })];
    const flagged = await preview(rows);
    expect(flagged.errors).toEqual([]);
    expect(flagged.warnings.filter((x) => x.code === "PHONE_SHARED_IN_FILE")).toHaveLength(3);
    expect(flagged.job.validRows).toBe(3);

    const rejected = await preview(rows.map((r) => ({ ...r, member_number: `${r.member_number}X` })), { duplicatePhones: "REJECT" });
    expect(rejected.errors.filter((x) => x.code === "PHONE_SHARED_IN_FILE")).toHaveLength(3);
    expect(rejected.job.validRows).toBe(0);
  });

  it("rejects invalid phone numbers and inconsistent formats it cannot normalise", async () => {
    const p = await preview([mk({ phone: "0801234567" }), mk({ phone: "0803ABC4567" }), mk({ phone: "+234 803 123 45678 9" })]);
    expect(p.errors.filter((x) => x.code === "INVALID_PHONE")).toHaveLength(3);
  });

  it("treats member numbers differing only by case or surrounding spaces as one member; conflicting details are errors", async () => {
    const num = `cs-${uid()}`;
    const base = mk({ member_number: num });
    const p = await preview([base, { ...base, member_number: `  ${num.toUpperCase()} `, plan_code: w.plan.code, coverage_start: "2025-01-01" }, { ...base, member_number: num.toUpperCase(), first_name: "Different", coverage_start: "2026-01-01" }]);
    expect(p.warnings.map((x) => x.code)).toContain("MEMBER_NUMBER_CASE_VARIANT");
    expect(p.errors.map((x) => x.code)).toEqual(["CONFLICT_IN_FILE"]);
    expect(p.job.validRows).toBe(2);
    await applyImport(w.hmo.admin, p.job.id);
    const created = (await membersOf(w.hmo.org.id)).filter((m) => m.memberNumber.toUpperCase() === num.toUpperCase());
    expect(created).toHaveLength(1);
  });

  it("flags member numbers that differ only by punctuation, without merging them", async () => {
    const n = uid().toUpperCase();
    const p = await preview([mk({ member_number: `HM-${n}` }), mk({ member_number: `HM${n}` })]);
    expect(p.warnings.filter((x) => x.code === "POSSIBLE_DUPLICATE_IN_FILE")).toHaveLength(2);
    await applyImport(w.hmo.admin, p.job.id);
    const m = (await membersOf(w.hmo.org.id)).filter((x) => x.memberNumber.endsWith(n));
    expect(m).toHaveLength(2);
  });

  it("reports missing required fields and invalid types per row", async () => {
    const p = await preview([mk({ first_name: "" }), mk({ coverage_start: "31/02/2024" }), mk({ plan_code: "NOPE" }), mk({ status: "MAYBE" })]);
    expect(p.errors.map((x) => x.code).sort()).toEqual(["INVALID_DATE", "INVALID_STATUS", "REQUIRED", "UNKNOWN_PLAN"]);
    expect(p.job.validRows).toBe(0);
  });
});

describe("duplicates against existing records of the same HMO only", () => {
  it("classifies rows as NEW, UPDATE, UNCHANGED and holds name changes as CONFLICT", async () => {
    const a = mk();
    const b = mk();
    const c = mk();
    await applyImport(w.hmo.admin, (await preview([a, b, c])).job.id);
    const p = await preview([a, { ...b, phone: phone() }, { ...c, last_name: "Somebody-Else" }, mk()]);
    expect(p.counts).toEqual({ new: 1, update: 1, unchanged: 1, conflict: 1 });
    expect(p.conflicts[0]).toMatchObject({ memberNumber: c.member_number, fields: ["last_name"] });

    const r = await applyImport(w.hmo.admin, p.job.id);
    expect(r.status).toBe("PARTIALLY_APPLIED");
    expect(r.progress).toMatchObject({ appliedRows: 3, heldRows: 1, failedRows: 0 });
    const held = (await membersOf(w.hmo.org.id)).find((m) => m.memberNumber === c.member_number)!;
    expect(held.lastName).toBe("Adewale"); // never silently overwritten

    const after = await applyHeldRows(w.hmo.admin, p.job.id);
    expect(after.status).toBe("APPLIED");
    expect((await membersOf(w.hmo.org.id)).find((m) => m.memberNumber === c.member_number)!.lastName).toBe("Somebody-Else");
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entityId, held.id), eq(schema.auditEvents.action, "member.identity_changed")));
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0].metadata)).not.toContain("Somebody");
  });

  it("accepting name changes needs members:write permission", async () => {
    const p = await preview([mk()]);
    const viewer = { ...w.hmo.admin, permissions: new Set([...w.hmo.admin.permissions].filter((x) => x !== "members:write")) };
    await expect(applyImport(viewer, p.job.id, { acceptIdentityChanges: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("matches an existing member regardless of letter case and keeps the stored number", async () => {
    const a = mk({ member_number: `LC-${uid().toUpperCase()}` });
    await applyImport(w.hmo.admin, (await preview([a])).job.id);
    const p = await preview([{ ...a, member_number: a.member_number.toLowerCase(), coverage_start: "2025-06-01" }]);
    expect(p.counts.update).toBe(1);
    expect(p.warnings.map((x) => x.code)).toContain("MEMBER_NUMBER_CASE_VARIANT");
    await applyImport(w.hmo.admin, p.job.id);
    const ms = (await membersOf(w.hmo.org.id)).filter((m) => m.memberNumber.toUpperCase() === a.member_number);
    expect(ms.map((m) => m.memberNumber)).toEqual([a.member_number]);
  });

  it("flags a phone already used by another member of the same HMO, and ignores other HMOs", async () => {
    const shared = phone();
    await applyImport(w.hmo.admin, (await preview([mk({ phone: shared })])).job.id);
    const p = await preview([mk({ phone: shared })]);
    expect(p.warnings.map((x) => x.code)).toContain("PHONE_ON_OTHER_MEMBER");

    // Another HMO with the same phone and even the same member number: no cross-HMO warning, no leak.
    const other = await makeHmo("Other");
    const cat = await makeCatalog(other.admin);
    const q = await previewImport(other.admin, { fileName: "o.csv", data: csvOf([{ ...mk({ phone: shared }), member_number: w.members[0].memberNumber, plan_code: cat.plan.code }]) });
    expect(q.warnings).toEqual([]);
    expect(q.counts).toEqual({ new: 1, update: 0, unchanged: 0, conflict: 0 });
  });

  it("flags overlapping coverage periods on the same plan", async () => {
    const a = mk({ coverage_start: "2024-01-01", coverage_end: "2024-12-31" });
    await applyImport(w.hmo.admin, (await preview([a])).job.id);
    const p = await preview([{ ...a, coverage_start: "2024-06-01", coverage_end: "2025-05-31" }]);
    expect(p.warnings.map((x) => x.code)).toContain("OVERLAPPING_COVERAGE");
  });
});

describe("background processing", () => {
  it("large files are queued, processed in batches by the worker, and report progress", async () => {
    process.env.IMPORT_INLINE_MAX_ROWS = "10";
    process.env.IMPORT_BATCH_SIZE = "7";
    resetConfigCache();
    const rows = Array.from({ length: 40 }, () => mk());
    const p = await preview(rows);
    const r = await applyImport(w.hmo.admin, p.job.id);
    expect(r.status).toBe("QUEUED");
    expect(r.summary).toBeNull();
    // The same click again is idempotent while queued.
    expect((await applyImport(w.hmo.admin, p.job.id)).idempotentReplay).toBe(true);

    await runJobsUntilIdle();
    const done = await getImport(w.hmo.admin, p.job.id);
    expect(done.status).toBe("APPLIED");
    expect(done.progress).toMatchObject({ totalRows: 40, processedRows: 40, appliedRows: 40 });
    expect((done.summary as { membersCreated: number }).membersCreated).toBe(40);
    const staged = await db.select().from(schema.importRows).where(eq(schema.importRows.importJobId, p.job.id));
    expect(staged.every((s) => s.payloadEnc === null)).toBe(true); // staging cleared after use
  });

  it("an interrupted job resumes where it stopped, without applying any row twice", async () => {
    process.env.IMPORT_INLINE_MAX_ROWS = "0";
    process.env.IMPORT_BATCH_SIZE = "5";
    resetConfigCache();
    const p = await preview(Array.from({ length: 23 }, () => mk()));
    await applyImport(w.hmo.admin, p.job.id);
    // Worker 1 claims the job, applies two batches and "crashes" (stops without finishing).
    const claimed = await claimJobFor(IMPORT_JOB_KIND, p.job.id, "worker-1", 60_000);
    await processImportJob({ importJobId: p.job.id, renewLease: async () => undefined, maxBatches: 2 });
    expect((await getImport(w.hmo.admin, p.job.id)).progress.processedRows).toBe(10);
    // Its lease runs out; worker 2 picks the job up and finishes.
    await db.execute(sql`UPDATE background_jobs SET locked_until = now() - interval '1 second' WHERE id = ${claimed!.id}`);
    expect(await runJobsUntilIdle({ workerId: "worker-2" })).toBe(1);
    const done = await getImport(w.hmo.admin, p.job.id);
    expect(done.status).toBe("APPLIED");
    expect(done.progress.appliedRows).toBe(23);
    const n = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM members WHERE source_import_id = ${p.job.id}`);
    expect(n.rows[0].n).toBe(23);
  });

  it("two workers processing the same job at once never apply a row twice", async () => {
    process.env.IMPORT_INLINE_MAX_ROWS = "0";
    process.env.IMPORT_BATCH_SIZE = "4";
    resetConfigCache();
    const p = await preview(Array.from({ length: 30 }, () => mk()));
    await applyImport(w.hmo.admin, p.job.id);
    await Promise.all([1, 2, 3].map(() => processImportJob({ importJobId: p.job.id, renewLease: async () => undefined })));
    const done = await getImport(w.hmo.admin, p.job.id);
    expect(done.progress.appliedRows).toBe(30);
    const n = await db.execute<{ n: number; cov: number }>(sql`SELECT count(DISTINCT m.id)::int AS n, count(pm.id)::int AS cov FROM members m JOIN plan_memberships pm ON pm.member_id = m.id WHERE m.source_import_id = ${p.job.id}`);
    expect(n.rows[0]).toEqual({ n: 30, cov: 30 });
  });

  it("a failing row fails alone: its batch is retried row by row and the others are applied", async () => {
    process.env.IMPORT_BATCH_SIZE = "10";
    resetConfigCache();
    const p = await preview(Array.from({ length: 12 }, () => mk()));
    setImportRowHookForTests((rowNumber) => {
      if (rowNumber === 5) throw new Error("simulated processing error with Kemi +2348031234567");
    });
    const r = await applyImport(w.hmo.admin, p.job.id);
    expect(r.status).toBe("PARTIALLY_APPLIED");
    expect(r.progress).toMatchObject({ appliedRows: 11, failedRows: 1 });
    const failed = await listImportRows(w.hmo.admin, p.job.id, { status: "FAILED" });
    expect(failed.items.map((x) => x.row)).toEqual([5]);
    expect(JSON.stringify(failed.items)).not.toMatch(/Kemi|\+234/); // no personal data in stored errors
    const n = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM members WHERE source_import_id = ${p.job.id}`);
    expect(n.rows[0].n).toBe(11);
  });

  it("transient database errors roll the batch back and the job is retried later; nothing is half-applied", async () => {
    process.env.IMPORT_BATCH_SIZE = "50";
    process.env.IMPORT_INLINE_MAX_ROWS = "0";
    resetConfigCache();
    const p = await preview(Array.from({ length: 6 }, () => mk()));
    await applyImport(w.hmo.admin, p.job.id);
    let fail = true;
    setImportRowHookForTests((rowNumber) => {
      if (fail && rowNumber === 4) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    });
    const job = await claimJobFor(IMPORT_JOB_KIND, p.job.id);
    expect(await runClaimedJob(job!)).toBe("RETRY");
    const mid = await getImport(w.hmo.admin, p.job.id);
    expect(mid.progress.appliedRows).toBe(0); // the whole batch rolled back
    const n0 = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM members WHERE source_import_id = ${p.job.id}`);
    expect(n0.rows[0].n).toBe(0);
    fail = false;
    await db.execute(sql`UPDATE background_jobs SET run_after = now() WHERE kind = ${IMPORT_JOB_KIND} AND ref_id = ${p.job.id}`);
    await runJobsUntilIdle();
    expect((await getImport(w.hmo.admin, p.job.id)).status).toBe("APPLIED");
  });

  it("gives up after repeated transient failures, marks the import, and can be resumed by applying again", async () => {
    process.env.IMPORT_INLINE_MAX_ROWS = "0";
    resetConfigCache();
    const p = await preview(Array.from({ length: 3 }, () => mk()));
    await applyImport(w.hmo.admin, p.job.id);
    await db.execute(sql`UPDATE background_jobs SET max_attempts = 1 WHERE kind = ${IMPORT_JOB_KIND} AND ref_id = ${p.job.id}`);
    setImportRowHookForTests(() => {
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    });
    await runJobsUntilIdle();
    const failed = await getImport(w.hmo.admin, p.job.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.lastError).toMatch(/temporary failures/);
    setImportRowHookForTests(null);
    process.env.IMPORT_INLINE_MAX_ROWS = "500";
    resetConfigCache();
    const resumed = await applyImport(w.hmo.admin, p.job.id);
    expect(resumed.status).toBe("APPLIED");
    expect(resumed.progress.appliedRows).toBe(3);
  });
});
