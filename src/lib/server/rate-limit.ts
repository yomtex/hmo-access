import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { AppError } from "./errors";

/**
 * Fixed-window rate limiter backed by PostgreSQL so limits hold across multiple app instances.
 * Returns the count after increment. Throws RATE_LIMITED when `limit` is exceeded.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<number> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
  const res = await db.execute<{ count: number }>(sql`
    INSERT INTO rate_limit_buckets (key, window_start, count) VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count`);
  const count = Number(res.rows[0]?.count ?? 0);
  if (count > limit) {
    const retryAfter = Math.ceil((windowStart.getTime() + windowSeconds * 1000 - now) / 1000);
    throw new AppError("RATE_LIMITED", "Too many requests; try again later", { details: { retryAfterSeconds: retryAfter } });
  }
  return count;
}

/** Housekeeping: delete expired buckets (run from a scheduled job). */
export async function pruneRateLimits(olderThanSeconds = 86400) {
  await db.execute(sql`DELETE FROM rate_limit_buckets WHERE window_start < now() - make_interval(secs => ${olderThanSeconds})`);
}
