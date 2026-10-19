/**
 * Member file imports (CSV / .xlsx) — a controlled pipeline:
 *
 *  1. receive    size-capped body (router), safe display name, nothing written to disk
 *  2. inspect    real file type from its bytes; zip directory checks for .xlsx (file-guard)
 *  3. scan       malware scan when configured (scanner)
 *  4. parse      row / column / cell limits; values are plain text, formulas never evaluated
 *  5. validate   required fields, formats, dates, plan codes, phone numbers (tabular.normalizeRows)
 *  6. analyse    duplicates inside the file and against this HMO's existing members; classify each row
 *                NEW / UPDATE / UNCHANGED / CONFLICT, plus warnings for review (analyseRows)
 *  7. stage      importable rows stored encrypted in import_rows; report returned (preview)
 *  8. apply      queued as a background job; applied in batches, each row marked in the same
 *                transaction as its effect (idempotent across retries, crashes and double clicks)
 *  9. finish     APPLIED / PARTIALLY_APPLIED / FAILED with per-row results and an audit record
 *
 * Partial acceptance is the existing business rule: invalid rows are reported and skipped, valid rows
 * are applied. Rows that would change a member's NAME are held (CONFLICT) until the HMO accepts them.
 * Nothing in the file can affect another HMO: every lookup and write is scoped to the caller's HMO.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { audit } from "../audit";
import { hmoScope, requirePermission } from "../auth/guards";
import type { Actor } from "../auth/session";
import { config } from "../config";
import { decryptField, encryptField, phoneHash, sha256Hex } from "../crypto";
import { AppError, isUniqueViolation, notFound } from "../errors";
import { rateLimit } from "../rate-limit";
import { normalizeRows, parseInspected, resolveMapping, type FieldMapping, type StagedRecord } from "../connectors/tabular";
import type { NormalizedMemberRecord, RowError } from "../connectors/types";
import { claimJobFor, enqueueJob, isTransientError, kickWorker, registerJobHandler, runClaimedJob, type JobContext } from "../jobs/queue";
import { inspectUpload } from "../uploads/file-guard";
import { scanUploadOrReject } from "../uploads/scanner";
import { applyMemberRecordsDetailed, emptySummary, mergeSummary, sameName, type SyncSummary } from "./member-sync";
import { csvCell } from "./reports";

export const IMPORT_JOB_KIND = "IMPORT_APPLY";
const HELD_PAYLOAD_RETENTION_DAYS = 30;

export const PreviewOptions = z.object({
  /** FLAG (default): shared phone numbers are applied and listed for review. REJECT: such rows are not applied. */
  duplicatePhones: z.enum(["FLAG", "REJECT"]).default("FLAG"),
});
export type PreviewOptionsInput = z.input<typeof PreviewOptions>;

type Classification = "NEW" | "UPDATE" | "UNCHANGED" | "CONFLICT";
export type RowWarning = RowError;
type Analysed = { rec: StagedRecord; classification: Classification; changedFields: string[]; warnings: string[] };
type StagedPayload = { record: Omit<NormalizedMemberRecord, "coverageStart" | "coverageEnd"> & { coverageStart: string; coverageEnd: string | null }; raw: Record<string, string> };

const upperKey = (n: string) => n.toUpperCase();
const looseKey = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, "");

// ───────────────────────── analysis: duplicates and conflicts ─────────────────────────

/**
 * Duplicate and conflict rules (see the integration guide for the external description):
 * In the file
 *  - same member number (ignoring case) + plan + coverage start twice  → error DUPLICATE_IN_FILE (tabular)
 *  - same member number with a different name or phone                  → error CONFLICT_IN_FILE / PHONE_CONFLICT_IN_FILE
 *  - member number differing only by letter case                        → treated as the same member; warning
 *  - member numbers differing only by punctuation (HM-001 / HM001)      → warning POSSIBLE_DUPLICATE_IN_FILE
 *  - one phone number on several member numbers                         → warning PHONE_SHARED_IN_FILE (error if REJECT)
 * Against this HMO's existing members (never other HMOs)
 *  - same member number, different name                                 → CONFLICT, held until the HMO accepts
 *  - same member number, letter case differs                            → matches; stored spelling kept; warning
 *  - number differing only by punctuation from an existing member       → warning POSSIBLE_DUPLICATE_MEMBER
 *  - phone already on a different member                                → warning PHONE_ON_OTHER_MEMBER (error if REJECT)
 *  - overlapping coverage on the same plan with another start date      → warning OVERLAPPING_COVERAGE
 */
export async function analyseRows(hmoOrgId: string, valid: StagedRecord[], options: z.infer<typeof PreviewOptions>) {
  const errors: RowError[] = [];
  const warnings: RowWarning[] = [];
  const rowWarnings = new Map<number, string[]>();
  const warn = (row: number, field: string, code: string, message: string, asError = false) => {
    (asError ? errors : warnings).push({ row, field, code, message });
    if (!asError) rowWarnings.set(row, [...(rowWarnings.get(row) ?? []), code]);
  };
  const rejected = new Set<number>();

  // In-file consistency of each member number.
  const firstByKey = new Map<string, StagedRecord>();
  for (const v of valid) {
    const k = upperKey(v.memberNumber);
    const first = firstByKey.get(k);
    if (!first) {
      firstByKey.set(k, v);
      continue;
    }
    if (!sameName(first.firstName, v.firstName) || !sameName(first.lastName, v.lastName)) {
      errors.push({ row: v.row, field: "first_name", code: "CONFLICT_IN_FILE", message: `Member number is on row ${first.row} with a different name` });
      rejected.add(v.row);
    } else if ((first.phone ?? null) !== (v.phone ?? null)) {
      errors.push({ row: v.row, field: "phone", code: "PHONE_CONFLICT_IN_FILE", message: `Member number is on row ${first.row} with a different phone number` });
      rejected.add(v.row);
    }
    if (v.memberNumber !== first.memberNumber) {
      warn(v.row, "member_number", "MEMBER_NUMBER_CASE_VARIANT", `Same member as row ${first.row} (letter case differs); treated as one member`);
      v.memberNumber = first.memberNumber;
    }
  }
  const keep = valid.filter((v) => !rejected.has(v.row));

  // Shared phones and look-alike numbers inside the file.
  const keysByPhone = new Map<string, Set<string>>();
  const keysByLoose = new Map<string, Set<string>>();
  for (const v of keep) {
    if (v.phone) keysByPhone.set(v.phone, (keysByPhone.get(v.phone) ?? new Set()).add(upperKey(v.memberNumber)));
    keysByLoose.set(looseKey(v.memberNumber), (keysByLoose.get(looseKey(v.memberNumber)) ?? new Set()).add(upperKey(v.memberNumber)));
  }
  for (const v of keep) {
    if (v.phone && keysByPhone.get(v.phone)!.size > 1) {
      warn(v.row, "phone", "PHONE_SHARED_IN_FILE", `This phone number is used by ${keysByPhone.get(v.phone)!.size} different member numbers in the file`, options.duplicatePhones === "REJECT");
      if (options.duplicatePhones === "REJECT") rejected.add(v.row);
    }
    if (keysByLoose.get(looseKey(v.memberNumber))!.size > 1) warn(v.row, "member_number", "POSSIBLE_DUPLICATE_IN_FILE", "Another member number in the file differs only by punctuation; check it is not the same person");
  }

  // Against existing members of THIS HMO only.
  const live = keep.filter((v) => !rejected.has(v.row));
  const keys = [...new Set(live.map((v) => upperKey(v.memberNumber)))];
  const looses = [...new Set(live.map((v) => looseKey(v.memberNumber)))];
  const hashes = [...new Set(live.filter((v) => v.phone).map((v) => phoneHash(v.phone!)))];
  type Existing = { id: string; member_number: string; k: string; lk: string; first_name: string; last_name: string; phone_hash: string | null };
  const existing = new Map<string, Existing>();
  const byLoose = new Map<string, Existing[]>();
  const byPhone = new Map<string, string[]>();
  for (let i = 0; i < Math.max(keys.length, looses.length, hashes.length); i += 1000) {
    const kChunk = keys.slice(i, i + 1000);
    const lChunk = looses.slice(i, i + 1000);
    const hChunk = hashes.slice(i, i + 1000);
    if (kChunk.length) {
      const r = await db.execute<Existing>(sql`SELECT id, member_number, upper(member_number) AS k, '' AS lk, first_name, last_name, phone_hash FROM members WHERE hmo_org_id = ${hmoOrgId} AND upper(member_number) IN (${sql.join(kChunk.map((k) => sql`${k}`), sql`, `)})`);
      for (const e of r.rows) existing.set(e.k, e);
    }
    if (lChunk.length) {
      const r = await db.execute<Existing>(sql`SELECT id, member_number, upper(member_number) AS k, regexp_replace(upper(member_number), '[^A-Z0-9]', '', 'g') AS lk, first_name, last_name, phone_hash FROM members
        WHERE hmo_org_id = ${hmoOrgId} AND regexp_replace(upper(member_number), '[^A-Z0-9]', '', 'g') IN (${sql.join(lChunk.map((k) => sql`${k}`), sql`, `)})`);
      for (const e of r.rows) byLoose.set(e.lk, [...(byLoose.get(e.lk) ?? []), e]);
    }
    if (hChunk.length) {
      const r = await db.execute<{ k: string; phone_hash: string }>(sql`SELECT upper(member_number) AS k, phone_hash FROM members WHERE hmo_org_id = ${hmoOrgId} AND phone_hash IN (${sql.join(hChunk.map((h) => sql`${h}`), sql`, `)})`);
      for (const e of r.rows) byPhone.set(e.phone_hash, [...(byPhone.get(e.phone_hash) ?? []), e.k]);
    }
  }
  const memberIds = [...existing.values()].map((e) => e.id);
  const coverages = memberIds.length
    ? await db
        .select({ memberId: schema.planMemberships.memberId, planCode: schema.plans.code, start: schema.planMemberships.coverageStart, end: schema.planMemberships.coverageEnd, status: schema.planMemberships.status, group: schema.planMemberships.memberGroup })
        .from(schema.planMemberships)
        .innerJoin(schema.plans, eq(schema.plans.id, schema.planMemberships.planId))
        .where(and(eq(schema.planMemberships.hmoOrgId, hmoOrgId), inArray(schema.planMemberships.memberId, memberIds)))
    : [];

  const analysed: Analysed[] = [];
  for (const v of live) {
    const k = upperKey(v.memberNumber);
    const ex = existing.get(k);
    const hash = v.phone ? phoneHash(v.phone) : null;
    if (hash) {
      const others = (byPhone.get(hash) ?? []).filter((x) => x !== k);
      if (others.length) {
        warn(v.row, "phone", "PHONE_ON_OTHER_MEMBER", `This phone number already belongs to ${others.length} other member(s) of your HMO`, options.duplicatePhones === "REJECT");
        if (options.duplicatePhones === "REJECT") continue;
      }
    }
    const looks = (byLoose.get(looseKey(v.memberNumber)) ?? []).filter((e) => e.k !== k);
    if (looks.length) warn(v.row, "member_number", "POSSIBLE_DUPLICATE_MEMBER", `Looks like existing member number ${looks[0].member_number.slice(0, 64)} (differs only by punctuation)`);

    if (!ex) {
      analysed.push({ rec: v, classification: "NEW", changedFields: [], warnings: rowWarnings.get(v.row) ?? [] });
      continue;
    }
    if (ex.member_number !== v.memberNumber) warn(v.row, "member_number", "MEMBER_NUMBER_CASE_VARIANT", `Matches existing member ${ex.member_number.slice(0, 64)} (letter case differs); the stored number is kept`);
    const nameFields = [!sameName(ex.first_name, v.firstName) ? "first_name" : null, !sameName(ex.last_name, v.lastName) ? "last_name" : null].filter(Boolean) as string[];
    if (nameFields.length) {
      analysed.push({ rec: v, classification: "CONFLICT", changedFields: nameFields, warnings: rowWarnings.get(v.row) ?? [] });
      continue;
    }
    const changed: string[] = [];
    if ((ex.phone_hash ?? null) !== hash) changed.push("phone");
    const mine = coverages.filter((c) => c.memberId === ex.id && c.planCode === v.planCode);
    const same = mine.find((c) => c.start.getTime() === v.coverageStart.getTime());
    if (!same) {
      changed.push("coverage");
      const vEnd = v.coverageEnd?.getTime() ?? Infinity;
      if (mine.some((c) => c.start.getTime() < vEnd && v.coverageStart.getTime() < (c.end?.getTime() ?? Infinity))) {
        warn(v.row, "coverage_start", "OVERLAPPING_COVERAGE", "Overlaps an existing coverage period on the same plan with a different start date");
      }
    } else if ((same.end?.getTime() ?? null) !== (v.coverageEnd?.getTime() ?? null) || same.status !== v.coverageStatus || (same.group ?? null) !== (v.memberGroup ?? null)) {
      changed.push("coverage");
    }
    analysed.push({ rec: v, classification: changed.length ? "UPDATE" : "UNCHANGED", changedFields: changed, warnings: rowWarnings.get(v.row) ?? [] });
  }
  for (const a of analysed) a.warnings = rowWarnings.get(a.rec.row) ?? [];
  return { analysed, errors, warnings };
}

// ───────────────────────── step 1: preview ─────────────────────────

/** Parse, validate, analyse and stage. Nothing about members changes. Returns the validation report. */
export async function previewImport(actor: Actor, input: { fileName: string; data: Buffer; mapping?: FieldMapping; clientMime?: string | null; options?: PreviewOptionsInput }) {
  const hmoOrgId = hmoScope(actor, "imports:manage");
  const c = config();
  const options = PreviewOptions.parse(input.options ?? {});
  await rateLimit(`imports:org:${hmoOrgId}`, 60, 3600);
  const fileSha256 = sha256Hex(input.data);

  let inspected: ReturnType<typeof inspectUpload>;
  let scanStatus: string;
  let table: Awaited<ReturnType<typeof parseInspected>>;
  try {
    inspected = inspectUpload({ fileName: input.fileName, data: input.data, maxBytes: c.IMPORT_MAX_BYTES });
    scanStatus = (await scanUploadOrReject(input.data)).status;
    table = await parseInspected(inspected, input.data, { maxBytes: c.IMPORT_MAX_BYTES, maxRows: c.IMPORT_MAX_ROWS });
  } catch (e) {
    // Rejected files are recorded (hash and reason only — never content) and not kept.
    if (e instanceof AppError) {
      await audit(db, { orgId: hmoOrgId, actorUserId: actor.userId, action: "import.rejected", entityType: "import_job", entityId: null, metadata: { fileSha256, bytes: input.data.length, reason: e.message, stage: (e.details as { stage?: string } | undefined)?.stage ?? "parse", clientMime: input.clientMime?.slice(0, 100) ?? null } });
    }
    throw e;
  }
  const { mapping, missing } = resolveMapping(table.headers, input.mapping);

  let analysed: Analysed[] = [];
  let errors: RowError[] = [];
  let warnings: RowWarning[] = [];
  if (missing.length > 0) {
    errors = missing.map((f) => ({ row: 1, field: f, code: "COLUMN_NOT_FOUND", message: `No column found for ${f}` }));
  } else {
    const plans = await db.select({ code: schema.plans.code }).from(schema.plans).where(eq(schema.plans.hmoOrgId, hmoOrgId));
    const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, hmoOrgId) });
    const norm = normalizeRows(table.rows, mapping, { knownPlanCodes: new Set(plans.map((p) => p.code)), timezone: org?.timezone ?? "Africa/Lagos" });
    const a = await analyseRows(hmoOrgId, norm.valid, options);
    analysed = a.analysed;
    errors = [...norm.errors, ...a.errors].sort((x, y) => x.row - y.row);
    warnings = a.warnings.sort((x, y) => x.row - y.row);
  }
  const counts = { new: 0, update: 0, unchanged: 0, conflict: 0 };
  for (const a of analysed) counts[a.classification.toLowerCase() as keyof typeof counts]++;
  const errorRowNumbers = new Set(errors.map((e) => e.row));

  const alreadyApplied = await db.query.importJobs.findFirst({
    where: and(eq(schema.importJobs.hmoOrgId, hmoOrgId), eq(schema.importJobs.appliedFileSha, fileSha256)),
    columns: { id: true },
  });

  const job = await db.transaction(async (tx) => {
    const [j] = await tx
      .insert(schema.importJobs)
      .values({
        hmoOrgId,
        fileName: inspected.displayName,
        fileSha256,
        status: missing.length > 0 ? "FAILED" : "PREVIEWED",
        mapping,
        totalRows: table.rows.length,
        validRows: analysed.length,
        errorRows: missing.length > 0 ? table.rows.length : errorRowNumbers.size,
        warningRows: new Set(warnings.map((w) => w.row)).size,
        conflictRows: counts.conflict,
        errors: errors.slice(0, 5000),
        warnings: warnings.slice(0, 5000),
        summary: { preview: counts },
        options,
        detectedType: inspected.detectedType,
        clientMime: input.clientMime?.slice(0, 100) ?? null,
        scanStatus,
        createdById: actor.userId,
      })
      .returning();
    await stageRows(tx, j.id, hmoOrgId, analysed);
    await audit(tx, {
      orgId: hmoOrgId,
      actorUserId: actor.userId,
      action: "import.previewed",
      entityType: "import_job",
      entityId: j.id,
      metadata: { fileName: j.fileName, fileSha256, detectedType: inspected.detectedType, scanStatus, totalRows: j.totalRows, validRows: j.validRows, errorRows: j.errorRows, warningRows: j.warningRows, ...counts },
    });
    return j;
  });

  return {
    job: publicJob(job),
    mapping,
    missingColumns: missing,
    counts,
    errors: errors.slice(0, 500),
    warnings: warnings.slice(0, 500),
    conflicts: analysed.filter((a) => a.classification === "CONFLICT").slice(0, 200).map((a) => ({ row: a.rec.row, memberNumber: a.rec.memberNumber, fields: a.changedFields, message: "Would change the name of an existing member; held until you accept name changes" })),
    previewRows: analysed.slice(0, 25).map(({ rec: v, classification, warnings: w }) => ({ row: v.row, memberNumber: v.memberNumber, name: `${v.firstName} ${v.lastName}`, planCode: v.planCode, coverageStart: v.coverageStart, coverageEnd: v.coverageEnd, status: v.coverageStatus, memberGroup: v.memberGroup, classification, warnings: w })),
    duplicateOfAppliedJob: alreadyApplied?.id ?? null,
  };
}

async function stageRows(tx: Tx, importJobId: string, hmoOrgId: string, analysed: Analysed[]) {
  for (let i = 0; i < analysed.length; i += 500) {
    const chunk = analysed.slice(i, i + 500);
    await tx.insert(schema.importRows).values(
      chunk.map(({ rec, classification, changedFields, warnings }) => {
        const { row, raw, coverageStart, coverageEnd, ...r } = rec;
        const payload: StagedPayload = { record: { ...r, coverageStart: coverageStart.toISOString(), coverageEnd: coverageEnd?.toISOString() ?? null }, raw };
        return { importJobId, hmoOrgId, rowNumber: row, memberNumber: rec.memberNumber.slice(0, 64), classification, changedFields, warnings, payloadEnc: encryptField(JSON.stringify(payload)) };
      }),
    );
  }
}

/** Jobs previewed before import_rows existed kept plain staged rows; convert them on apply. */
async function convertLegacyStaging(job: typeof schema.importJobs.$inferSelect) {
  const legacy = (job.stagedRows as (Omit<NormalizedMemberRecord, "coverageStart" | "coverageEnd"> & { row: number; coverageStart: string; coverageEnd: string | null })[] | null) ?? null;
  if (!legacy) return;
  const has = await db.query.importRows.findFirst({ where: eq(schema.importRows.importJobId, job.id), columns: { id: true } });
  if (has) return;
  const valid: StagedRecord[] = legacy.map(({ row, ...r }) => ({ ...r, row, raw: {}, coverageStart: new Date(r.coverageStart), coverageEnd: r.coverageEnd ? new Date(r.coverageEnd) : null }));
  const { analysed } = await analyseRows(job.hmoOrgId, valid, PreviewOptions.parse(job.options ?? {}));
  await db.transaction(async (tx) => {
    await stageRows(tx, job.id, job.hmoOrgId, analysed);
    await tx.update(schema.importJobs).set({ stagedRows: null }).where(eq(schema.importJobs.id, job.id));
  });
}

// ───────────────────────── step 2: apply (queued) ─────────────────────────

export type ApplyResult = { jobId: string; status: string; summary: SyncSummary | null; idempotentReplay: boolean; progress: ReturnType<typeof progressOf> };

/**
 * Queues the staged rows of a previewed job. Idempotent:
 *  - applying the same job again returns its current state (queued, processing or finished);
 *  - applying another job with byte-identical content returns the earlier job (nothing re-applied).
 * Small files (≤ IMPORT_INLINE_MAX_ROWS rows) are processed before the response returns; larger ones
 * return status QUEUED and are processed in the background (poll GET /v1/imports/{id}).
 * A job that FAILED or stopped part-way can be applied again: only rows not yet applied are processed.
 */
export async function applyImport(actor: Actor, jobId: string, opts: { acceptIdentityChanges?: boolean } = {}): Promise<ApplyResult> {
  const hmoOrgId = hmoScope(actor, "imports:manage");
  if (opts.acceptIdentityChanges) requirePermission(actor, "members:write");
  const pre = await db.query.importJobs.findFirst({ where: and(eq(schema.importJobs.id, jobId), eq(schema.importJobs.hmoOrgId, hmoOrgId)) });
  if (!pre) throw notFound("Import job");
  if (pre.status === "PREVIEWED") await convertLegacyStaging(pre);

  let replay = false;
  try {
    replay = await db.transaction(async (tx) => {
      const [job] = await tx.select().from(schema.importJobs).where(and(eq(schema.importJobs.id, jobId), eq(schema.importJobs.hmoOrgId, hmoOrgId))).for("update");
      if (!job) throw notFound("Import job");
      const pending = await tx.$count(schema.importRows, and(eq(schema.importRows.importJobId, job.id), eq(schema.importRows.status, "PENDING")));
      if (job.status === "QUEUED" || job.status === "PROCESSING") return true;
      if ((job.status === "APPLIED" || job.status === "PARTIALLY_APPLIED" || job.status === "FAILED") && pending === 0) {
        if (job.status === "FAILED" && !job.appliedFileSha) throw new AppError("INVALID_STATE", "This import failed validation; fix the file and upload it again");
        return true;
      }
      if (job.status === "CANCELLED") throw new AppError("INVALID_STATE", "Import job is CANCELLED");
      if (job.status === "PREVIEWED") {
        // Claim the file hash first: a concurrent or earlier apply of identical content fails here.
        await tx.update(schema.importJobs).set({ appliedFileSha: job.fileSha256 }).where(eq(schema.importJobs.id, job.id));
      }
      await tx
        .update(schema.importJobs)
        .set({ status: "QUEUED", queuedAt: new Date(), lastError: null, options: { ...((job.options as object) ?? {}), acceptIdentityChanges: !!opts.acceptIdentityChanges || !!(job.options as { acceptIdentityChanges?: boolean } | null)?.acceptIdentityChanges } })
        .where(eq(schema.importJobs.id, job.id));
      await enqueueJob(tx, IMPORT_JOB_KIND, job.id, { orgId: hmoOrgId, requeue: job.status !== "PREVIEWED" });
      await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: job.status === "PREVIEWED" ? "import.queued" : "import.resumed", entityType: "import_job", entityId: job.id, metadata: { rows: pending, acceptIdentityChanges: !!opts.acceptIdentityChanges } });
      return false;
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Identical file already applied by another job: report that job and close this one.
    const prior = await db.query.importJobs.findFirst({ where: and(eq(schema.importJobs.hmoOrgId, hmoOrgId), eq(schema.importJobs.appliedFileSha, pre.fileSha256)) });
    await db.transaction(async (tx) => {
      await tx.update(schema.importJobs).set({ status: "CANCELLED", stagedRows: null, summary: { duplicateOf: prior?.id ?? null } }).where(eq(schema.importJobs.id, pre.id));
      await tx.update(schema.importRows).set({ payloadEnc: null }).where(eq(schema.importRows.importJobId, pre.id));
    });
    const p = prior ?? pre;
    return { jobId: p.id, status: p.status, summary: (p.summary as SyncSummary | null) ?? null, idempotentReplay: true, progress: progressOf(p) };
  }

  if (!replay) {
    if (pre.validRows <= config().IMPORT_INLINE_MAX_ROWS) {
      const claimed = await claimJobFor(IMPORT_JOB_KIND, jobId);
      if (claimed) await runClaimedJob(claimed);
    } else kickWorker();
  }
  const job = (await db.query.importJobs.findFirst({ where: eq(schema.importJobs.id, jobId) }))!;
  return { jobId: job.id, status: job.status, summary: finished(job.status) ? (job.summary as SyncSummary) : null, idempotentReplay: replay, progress: progressOf(job) };
}

/** Accepts the name changes held by a finished import and applies those rows. */
export async function applyHeldRows(actor: Actor, jobId: string) {
  const hmoOrgId = hmoScope(actor, "imports:manage");
  requirePermission(actor, "members:write");
  const released = await db.transaction(async (tx) => {
    const [job] = await tx.select().from(schema.importJobs).where(and(eq(schema.importJobs.id, jobId), eq(schema.importJobs.hmoOrgId, hmoOrgId))).for("update");
    if (!job) throw notFound("Import job");
    if (job.status !== "PARTIALLY_APPLIED" && job.status !== "APPLIED") throw new AppError("INVALID_STATE", `Import job is ${job.status}`);
    const rows = await tx
      .update(schema.importRows)
      .set({ status: "PENDING", outcome: null })
      .where(and(eq(schema.importRows.importJobId, job.id), eq(schema.importRows.status, "HELD"), sql`${schema.importRows.payloadEnc} IS NOT NULL`))
      .returning({ id: schema.importRows.id });
    if (rows.length === 0) throw new AppError("INVALID_STATE", "No held rows to apply (they may have expired after 30 days; upload the rows again)");
    await tx.update(schema.importJobs).set({ status: "QUEUED", queuedAt: new Date(), options: { ...((job.options as object) ?? {}), acceptIdentityChanges: true } }).where(eq(schema.importJobs.id, job.id));
    await enqueueJob(tx, IMPORT_JOB_KIND, job.id, { orgId: hmoOrgId, requeue: true });
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "import.held_rows_accepted", entityType: "import_job", entityId: job.id, metadata: { rows: rows.length } });
    return rows.length;
  });
  const claimed = released <= config().IMPORT_INLINE_MAX_ROWS ? await claimJobFor(IMPORT_JOB_KIND, jobId) : null;
  if (claimed) await runClaimedJob(claimed);
  else kickWorker();
  return getImport(actor, jobId);
}

// ───────────────────────── worker: process an import job ─────────────────────────

let rowHookForTests: ((rowNumber: number) => void) | null = null;
/** Tests only: called before each row is applied; throwing simulates a failing row. */
export function setImportRowHookForTests(fn: typeof rowHookForTests) {
  rowHookForTests = fn;
}

type PendingRow = { id: string; rowNumber: number; payloadEnc: string | null; classification: string };

function decodeRow(r: PendingRow): NormalizedMemberRecord {
  if (!r.payloadEnc) throw new Error("staged payload missing");
  const p = JSON.parse(decryptField(r.payloadEnc)) as StagedPayload;
  return { ...p.record, coverageStart: new Date(p.record.coverageStart), coverageEnd: p.record.coverageEnd ? new Date(p.record.coverageEnd) : null };
}

/** Applies a set of rows in one transaction; each row is marked in the same transaction as its effect. */
async function applyRowsTx(tx: Tx, job: typeof schema.importJobs.$inferSelect, rows: PendingRow[]) {
  const identityPolicy = (job.options as { acceptIdentityChanges?: boolean } | null)?.acceptIdentityChanges ? "UPDATE" : "HOLD";
  for (const r of rows) rowHookForTests?.(r.rowNumber);
  const { summary, outcomes } = await applyMemberRecordsDetailed(tx, job.hmoOrgId, rows.map(decodeRow), { sourceImportId: job.id, actorUserId: job.createdById, identityPolicy });
  const now = new Date();
  for (let i = 0; i < rows.length; i++) {
    const held = outcomes[i] === "HELD_IDENTITY_CONFLICT";
    await tx
      .update(schema.importRows)
      .set({ status: held ? "HELD" : "APPLIED", outcome: outcomes[i], processedAt: now, error: null, ...(held ? {} : { payloadEnc: null }) })
      .where(and(eq(schema.importRows.id, rows[i].id), eq(schema.importRows.status, "PENDING")));
  }
  const [cur] = await tx.select({ summary: schema.importJobs.summary }).from(schema.importJobs).where(eq(schema.importJobs.id, job.id)).for("update");
  const prev = (cur?.summary as (SyncSummary & { preview?: unknown }) | null) ?? null;
  const merged = mergeSummary(prev && "membersCreated" in prev ? prev : emptySummary(), summary);
  await tx.update(schema.importJobs).set({ summary: { ...merged, preview: prev?.preview } }).where(eq(schema.importJobs.id, job.id));
  await refreshCounters(tx, job.id);
}

async function refreshCounters(tx: Tx, importJobId: string) {
  await tx.execute(sql`
    UPDATE import_jobs j SET
      processed_rows = c.processed, applied_rows = c.applied, held_rows = c.held, failed_rows = c.failed
    FROM (SELECT count(*) FILTER (WHERE status <> 'PENDING')::int AS processed, count(*) FILTER (WHERE status = 'APPLIED')::int AS applied,
                 count(*) FILTER (WHERE status = 'HELD')::int AS held, count(*) FILTER (WHERE status = 'FAILED')::int AS failed
          FROM import_rows WHERE import_job_id = ${importJobId}) c
    WHERE j.id = ${importJobId}`);
}

const pendingRowsQuery = (tx: Tx, importJobId: string, limit: number) =>
  tx
    .select({ id: schema.importRows.id, rowNumber: schema.importRows.rowNumber, payloadEnc: schema.importRows.payloadEnc, classification: schema.importRows.classification })
    .from(schema.importRows)
    .where(and(eq(schema.importRows.importJobId, importJobId), eq(schema.importRows.status, "PENDING")))
    .orderBy(asc(schema.importRows.rowNumber))
    .limit(limit)
    .for("update", { skipLocked: true });

/** Error text that is safe to store and show: no row values, no internals. */
function rowErrorCode(e: unknown): string {
  const pg = (e as { cause?: { code?: string; constraint?: string } }).cause;
  if (pg?.code === "23505") return "DUPLICATE_RECORD";
  if (pg?.code === "23503" || pg?.code === "23514") return "INTEGRITY_RULE";
  return "ROW_FAILED";
}

export async function processImportJob(ctx: Pick<JobContext, "renewLease"> & { importJobId: string; batchSize?: number; maxBatches?: number }) {
  const job = await db.query.importJobs.findFirst({ where: eq(schema.importJobs.id, ctx.importJobId) });
  if (!job || job.status === "CANCELLED") return;
  await db.update(schema.importJobs).set({ status: "PROCESSING", startedAt: job.startedAt ?? new Date() }).where(and(eq(schema.importJobs.id, job.id), inArray(schema.importJobs.status, ["QUEUED", "PROCESSING"])));
  const batchSize = ctx.batchSize ?? config().IMPORT_BATCH_SIZE;
  let batches = 0;

  for (;;) {
    if (ctx.maxBatches !== undefined && batches >= ctx.maxBatches) return; // test hook: simulate a worker stopping mid-job
    let isolate = false;
    let empty = false;
    try {
      await db.transaction(async (tx) => {
        const rows = await pendingRowsQuery(tx, job.id, batchSize);
        if (rows.length === 0) {
          empty = true;
          return;
        }
        await applyRowsTx(tx, job, rows);
      });
    } catch (e) {
      if (isTransientError(e)) throw e; // whole job retried with backoff; finished rows are not redone
      isolate = true;
    }
    if (empty) break;
    if (isolate) {
      // A row in the batch failed: the batch rolled back. Apply its rows one by one so only the bad row fails.
      const rows = await db.transaction((tx) => pendingRowsQuery(tx, job.id, batchSize));
      for (const r of rows) {
        try {
          await db.transaction(async (tx) => {
            const [locked] = await pendingRowsQuery(tx, job.id, batchSize).then((xs) => xs.filter((x) => x.id === r.id));
            if (locked) await applyRowsTx(tx, job, [locked]);
          });
        } catch (e) {
          if (isTransientError(e)) throw e;
          await db.transaction(async (tx) => {
            await tx
              .update(schema.importRows)
              .set({ status: "FAILED", outcome: rowErrorCode(e), error: "This row could not be applied; correct it and upload it again", processedAt: new Date(), payloadEnc: null })
              .where(and(eq(schema.importRows.id, r.id), eq(schema.importRows.status, "PENDING")));
            await refreshCounters(tx, job.id);
          });
        }
      }
    }
    batches++;
    await ctx.renewLease();
  }
  await finalizeImport(job.id);
}

async function finalizeImport(importJobId: string, lastError?: string) {
  await db.transaction(async (tx) => {
    await refreshCounters(tx, importJobId);
    const [job] = await tx.select().from(schema.importJobs).where(eq(schema.importJobs.id, importJobId)).for("update");
    const pending = await tx.$count(schema.importRows, and(eq(schema.importRows.importJobId, importJobId), eq(schema.importRows.status, "PENDING")));
    const status = pending === 0 && job.failedRows === 0 && job.heldRows === 0 ? "APPLIED" : job.appliedRows > 0 || job.heldRows > 0 ? "PARTIALLY_APPLIED" : "FAILED";
    const now = new Date();
    await tx.update(schema.importJobs).set({ status, finishedAt: now, appliedAt: job.appliedAt ?? now, stagedRows: null, lastError: lastError ?? null }).where(eq(schema.importJobs.id, importJobId));
    const s = (job.summary as SyncSummary | null) ?? emptySummary();
    await audit(tx, {
      orgId: job.hmoOrgId,
      actorUserId: job.createdById,
      action: status === "APPLIED" ? "import.applied" : status === "PARTIALLY_APPLIED" ? "import.partially_applied" : "import.failed",
      entityType: "import_job",
      entityId: job.id,
      metadata: { appliedRows: job.appliedRows, heldRows: job.heldRows, failedRows: job.failedRows, notProcessed: pending, membersCreated: s.membersCreated, membersUpdated: s.membersUpdated, coverageCreated: s.coverageCreated, coverageUpdated: s.coverageUpdated, retroactiveConflicts: s.retroactiveConflicts?.length ?? 0, lastError: lastError ?? null },
    });
  });
}

registerJobHandler(IMPORT_JOB_KIND, {
  run: (ctx) => processImportJob({ importJobId: ctx.job.refId, renewLease: ctx.renewLease }),
  onGiveUp: (job, error) => finalizeImport(job.refId, error),
});

// ───────────────────────── reading, cancelling, housekeeping ─────────────────────────

export async function cancelImport(actor: Actor, jobId: string) {
  const hmoOrgId = hmoScope(actor, "imports:manage");
  return db.transaction(async (tx) => {
    const [job] = await tx
      .update(schema.importJobs)
      .set({ status: "CANCELLED", stagedRows: null })
      .where(and(eq(schema.importJobs.id, jobId), eq(schema.importJobs.hmoOrgId, hmoOrgId), eq(schema.importJobs.status, "PREVIEWED")))
      .returning();
    if (!job) throw new AppError("INVALID_STATE", "Only previewed imports can be cancelled");
    await tx.update(schema.importRows).set({ payloadEnc: null }).where(eq(schema.importRows.importJobId, job.id));
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "import.cancelled", entityType: "import_job", entityId: job.id });
    return publicJob(job);
  });
}

export async function listImports(actor: Actor) {
  const hmoOrgId = hmoScope(actor, "imports:manage");
  const rows = await db.select().from(schema.importJobs).where(eq(schema.importJobs.hmoOrgId, hmoOrgId)).orderBy(desc(schema.importJobs.createdAt)).limit(100);
  return rows.map(publicJob);
}

export async function getImport(actor: Actor, jobId: string) {
  const hmoOrgId = hmoScope(actor, "imports:manage");
  const job = await db.query.importJobs.findFirst({ where: and(eq(schema.importJobs.id, jobId), eq(schema.importJobs.hmoOrgId, hmoOrgId)) });
  if (!job) throw notFound("Import job");
  return { ...publicJob(job), errors: job.errors as RowError[], warnings: (job.warnings as RowWarning[] | null) ?? [] };
}

/** Per-row results: which rows were applied, held, failed or still pending. No personal data beyond the HMO's own member number. */
export async function listImportRows(actor: Actor, jobId: string, opts: { status?: string; limit?: number; offset?: number } = {}) {
  const hmoOrgId = hmoScope(actor, "imports:manage");
  const status = opts.status ? z.enum(["PENDING", "APPLIED", "HELD", "FAILED"]).parse(opts.status) : undefined;
  const where = and(eq(schema.importRows.importJobId, jobId), eq(schema.importRows.hmoOrgId, hmoOrgId), status ? eq(schema.importRows.status, status) : undefined);
  const items = await db
    .select({ row: schema.importRows.rowNumber, memberNumber: schema.importRows.memberNumber, classification: schema.importRows.classification, changedFields: schema.importRows.changedFields, warnings: schema.importRows.warnings, status: schema.importRows.status, outcome: schema.importRows.outcome, error: schema.importRows.error, processedAt: schema.importRows.processedAt })
    .from(schema.importRows)
    .where(where)
    .orderBy(asc(schema.importRows.rowNumber))
    .limit(Math.min(opts.limit ?? 200, 1000))
    .offset(opts.offset ?? 0);
  const total = await db.$count(schema.importRows, where);
  return { items, total };
}

/** Full validation and results report as CSV, with spreadsheet formula injection neutralised. */
export async function importReportCsv(actor: Actor, jobId: string): Promise<string> {
  const job = await getImport(actor, jobId);
  const rows = await db
    .select({ row: schema.importRows.rowNumber, memberNumber: schema.importRows.memberNumber, status: schema.importRows.status, outcome: schema.importRows.outcome, classification: schema.importRows.classification, changed: schema.importRows.changedFields })
    .from(schema.importRows)
    .where(and(eq(schema.importRows.importJobId, jobId), inArray(schema.importRows.status, ["HELD", "FAILED", "PENDING"])))
    .orderBy(asc(schema.importRows.rowNumber));
  const lines: unknown[][] = [
    ...job.errors.map((e) => [e.row, "ERROR", e.field, e.code, e.message]),
    ...job.warnings.map((w) => [w.row, "WARNING", w.field, w.code, w.message]),
    ...rows.map((r) => [r.row, r.status === "HELD" ? "HELD" : r.status === "FAILED" ? "FAILED" : "NOT_PROCESSED", r.changed.join(" "), r.outcome ?? r.classification, r.status === "HELD" ? "Name differs from the existing member; accept name changes to apply" : r.status === "FAILED" ? "Could not be applied" : "Not processed yet"]),
  ].sort((a, b) => Number(a[0]) - Number(b[0]));
  return ["row,severity,field,code,message", ...lines.map((l) => l.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

/** CSV of row-level errors (kept for existing clients), formula-injection safe. */
export function errorsToCsv(errors: RowError[]): string {
  return ["row,field,code,message", ...errors.map((e) => [e.row, e.field, e.code, e.message].map(csvCell).join(","))].join("\r\n") + "\r\n";
}

/** Housekeeping: staged personal data is not kept longer than needed. */
export async function purgeImportStaging(now = new Date()) {
  const cutoff = new Date(now.getTime() - HELD_PAYLOAD_RETENTION_DAYS * 86_400_000);
  const held = await db.execute(sql`UPDATE import_rows SET payload_enc = NULL, outcome = 'HELD_EXPIRED' WHERE status = 'HELD' AND payload_enc IS NOT NULL AND processed_at < ${cutoff}`);
  const abandoned = await db.execute(sql`
    UPDATE import_rows r SET payload_enc = NULL FROM import_jobs j
    WHERE r.import_job_id = j.id AND r.payload_enc IS NOT NULL AND j.status IN ('PREVIEWED','CANCELLED') AND j.created_at < ${cutoff}`);
  return { heldPurged: held.rowCount ?? 0, previewPurged: abandoned.rowCount ?? 0 };
}

const finished = (s: string) => s === "APPLIED" || s === "PARTIALLY_APPLIED" || s === "FAILED";
function progressOf(j: typeof schema.importJobs.$inferSelect) {
  return { totalRows: j.validRows, processedRows: j.processedRows, appliedRows: j.appliedRows, heldRows: j.heldRows, failedRows: j.failedRows };
}

function publicJob(j: typeof schema.importJobs.$inferSelect) {
  return {
    id: j.id,
    fileName: j.fileName,
    fileSha256: j.fileSha256,
    status: j.status,
    detectedType: j.detectedType,
    scanStatus: j.scanStatus,
    totalRows: j.totalRows,
    validRows: j.validRows,
    errorRows: j.errorRows,
    warningRows: j.warningRows,
    conflictRows: j.conflictRows,
    progress: progressOf(j),
    summary: j.summary,
    lastError: j.lastError,
    createdAt: j.createdAt,
    queuedAt: j.queuedAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    appliedAt: j.appliedAt,
  };
}
