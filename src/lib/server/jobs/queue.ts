/**
 * Durable background jobs on PostgreSQL — no extra infrastructure.
 *
 * - enqueue() is idempotent per (kind, refId): a job for the same thing is never queued twice.
 * - Workers claim one job at a time with FOR UPDATE SKIP LOCKED and hold a lease (locked_until).
 *   A worker that crashes simply stops renewing the lease; once it lapses another worker resumes the
 *   job. Handlers must therefore be idempotent (the import handler marks each row in the same
 *   transaction as its effect, so resumed work skips finished rows).
 * - Transient failures are retried with exponential backoff up to max_attempts; then the job is FAILED
 *   and the handler's onGiveUp() records the failure on the business object.
 *
 * Where jobs run: `npm run worker` (recommended in production, can be scaled to several processes),
 * and — when JOBS_RUN_IN_WEB=true (default) — inside the web process right after a request that
 * queued work. Both use the same claim/lease logic, so running both is safe.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/db/client";
import { config } from "../config";

export type JobRow = typeof schema.backgroundJobs.$inferSelect;
export type JobContext = { job: JobRow; workerId: string; renewLease: () => Promise<void> };
export type JobHandler = { run: (ctx: JobContext) => Promise<void>; onGiveUp?: (job: JobRow, error: string) => Promise<void> };

export const LEASE_MS = 60_000;
const handlers = new Map<string, JobHandler>();
export function registerJobHandler(kind: string, h: JobHandler) {
  handlers.set(kind, h);
}

export const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Queues a job (or re-queues a finished one when `requeue` is set). Safe to call repeatedly. */
export async function enqueueJob(tx: DbOrTx, kind: string, refId: string, opts: { orgId?: string | null; requeue?: boolean; maxAttempts?: number } = {}) {
  await tx.execute(sql`
    INSERT INTO background_jobs (kind, ref_id, org_id, max_attempts) VALUES (${kind}, ${refId}, ${opts.orgId ?? null}, ${opts.maxAttempts ?? 5})
    ON CONFLICT (kind, ref_id) DO ${opts.requeue ? sql`UPDATE SET status = 'QUEUED', attempts = 0, run_after = now(), last_error = NULL, finished_at = NULL, updated_at = now() WHERE background_jobs.status IN ('SUCCEEDED','FAILED')` : sql`NOTHING`}`);
}

function claimSql(where: ReturnType<typeof sql>, workerId: string, leaseMs: number) {
  return sql`
    UPDATE background_jobs SET status = 'RUNNING', attempts = attempts + 1, locked_by = ${workerId},
      locked_until = now() + (${leaseMs} * interval '1 millisecond'), updated_at = now()
    WHERE id = (
      SELECT id FROM background_jobs
      WHERE ${where} AND ((status = 'QUEUED' AND run_after <= now()) OR (status = 'RUNNING' AND locked_until < now()))
      ORDER BY run_after, created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING *`;
}

type RawJob = { id: string; kind: string; ref_id: string; org_id: string | null; status: string; attempts: number; max_attempts: number; run_after: Date; locked_by: string | null; locked_until: Date | null; last_error: string | null; created_at: Date; updated_at: Date; finished_at: Date | null };
const toJob = (r: RawJob): JobRow => ({ id: r.id, kind: r.kind, refId: r.ref_id, orgId: r.org_id, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, runAfter: r.run_after, lockedBy: r.locked_by, lockedUntil: r.locked_until, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at });

export async function claimNextJob(workerId = WORKER_ID, leaseMs = LEASE_MS): Promise<JobRow | null> {
  const r = await db.execute<RawJob>(claimSql(sql`true`, workerId, leaseMs));
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

export async function claimJobFor(kind: string, refId: string, workerId = WORKER_ID, leaseMs = LEASE_MS): Promise<JobRow | null> {
  const r = await db.execute<RawJob>(claimSql(sql`kind = ${kind} AND ref_id = ${refId}`, workerId, leaseMs));
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

/** PostgreSQL / network errors worth retrying: serialization, deadlock, lock timeout, connection loss. */
export function isTransientError(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
  if (!code) return false;
  return ["40001", "40P01", "55P03", "57P01", "57P02", "57P03", "53300", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "PARTNER_UNAVAILABLE"].includes(code) || code.startsWith("08");
}

/** Runs one claimed job to completion, retry or failure. Never throws. */
export async function runClaimedJob(job: JobRow, workerId = WORKER_ID, leaseMs = LEASE_MS): Promise<"SUCCEEDED" | "RETRY" | "FAILED"> {
  const handler = handlers.get(job.kind);
  const renewLease = async () => {
    await db.execute(sql`UPDATE background_jobs SET locked_until = now() + (${leaseMs} * interval '1 millisecond'), updated_at = now() WHERE id = ${job.id} AND locked_by = ${workerId}`);
  };
  try {
    if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
    await handler.run({ job, workerId, renewLease });
    await db.execute(sql`UPDATE background_jobs SET status = 'SUCCEEDED', finished_at = now(), locked_until = NULL, updated_at = now() WHERE id = ${job.id} AND locked_by = ${workerId}`);
    return "SUCCEEDED";
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    const transient = isTransientError(e);
    if (transient && job.attempts < job.maxAttempts) {
      const backoffMs = Math.min(5 * 60_000, 2_000 * 2 ** (job.attempts - 1));
      await db.execute(sql`UPDATE background_jobs SET status = 'QUEUED', run_after = now() + (${backoffMs} * interval '1 millisecond'), last_error = ${message}, locked_until = NULL, locked_by = NULL, updated_at = now() WHERE id = ${job.id}`);
      return "RETRY";
    }
    await db.execute(sql`UPDATE background_jobs SET status = 'FAILED', finished_at = now(), last_error = ${message}, locked_until = NULL, updated_at = now() WHERE id = ${job.id}`);
    await handler?.onGiveUp?.(job, transient ? "Gave up after repeated temporary failures" : "Processing error").catch(() => undefined);
    return "FAILED";
  }
}

/** Processes jobs until none are ready (or `maxJobs` reached). Returns how many ran. */
export async function runJobsUntilIdle(opts: { maxJobs?: number; workerId?: string; leaseMs?: number } = {}): Promise<number> {
  let n = 0;
  while (n < (opts.maxJobs ?? 100)) {
    const job = await claimNextJob(opts.workerId, opts.leaseMs);
    if (!job) break;
    await runClaimedJob(job, opts.workerId, opts.leaseMs);
    n++;
  }
  return n;
}

let kicking: Promise<unknown> | null = null;
/** Starts processing queued work in this process without blocking the caller (one runner at a time). */
export function kickWorker(): void {
  if (config().JOBS_RUN_IN_WEB !== "true" || kicking) return;
  kicking = new Promise((r) => setImmediate(r))
    .then(() => runJobsUntilIdle())
    .catch((e) => console.error("background job runner:", e instanceof Error ? e.message : e))
    .finally(() => {
      kicking = null;
    });
}
