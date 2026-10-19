/**
 * Background worker: processes queued jobs (member imports) from the PostgreSQL job table.
 *
 *   npm run worker
 *
 * Safe to run several copies (jobs are claimed with FOR UPDATE SKIP LOCKED and leased). Stops
 * gracefully on SIGINT/SIGTERM after the current batch; an interrupted job resumes on the next run.
 */
import { pool } from "../src/db/client";
import { runJobsUntilIdle, WORKER_ID } from "../src/lib/server/jobs/queue";
import "../src/lib/server/services/imports"; // registers the IMPORT_APPLY handler
import "../src/lib/server/services/payments"; // registers the PAYMENT_VERIFY handler

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    console.log(`worker ${WORKER_ID}: stopping after the current job…`);
  });
}

async function main() {
  console.log(`worker ${WORKER_ID}: polling every ${POLL_MS} ms`);
  while (!stopping) {
    const n = await runJobsUntilIdle({ maxJobs: 1 }).catch((e) => {
      console.error("worker error:", e instanceof Error ? e.message : e);
      return 0;
    });
    if (n === 0) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await pool.end();
}
main();
