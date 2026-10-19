/**
 * Scheduled maintenance (run every 5–15 minutes from cron / a scheduler):
 * expires stale check-ins and authorizations (releasing allowance), prunes rate-limit buckets,
 * purges simulator texts and old import staging, activates payout-account changes whose hold has
 * passed, and re-queues payment credits the partner could not confirm yet.
 *
 *   npm run housekeeping
 */
import { pool } from "../src/db/client";
import { pruneRateLimits } from "../src/lib/server/rate-limit";
import { purgeImportStaging } from "../src/lib/server/services/imports";
import { paymentsHousekeeping } from "../src/lib/server/services/payments";
import { purgeSimulatorMessages } from "../src/lib/server/services/simulator";
import { expireStale } from "../src/lib/server/services/visits";

async function main() {
  const visits = await expireStale();
  await pruneRateLimits();
  await purgeSimulatorMessages();
  const staging = await purgeImportStaging();
  const pay = await paymentsHousekeeping();
  console.log(JSON.stringify({ at: new Date().toISOString(), ...visits, ...staging, ...pay }));
  await pool.end();
}
main().catch(async (e) => {
  console.error("housekeeping failed:", e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
