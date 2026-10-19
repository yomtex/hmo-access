/**
 * Benefit-period window computation.
 *
 * Boundaries are computed in the benefit's IANA timezone (default Africa/Lagos) and returned as UTC
 * instants. Windows are half-open: [start, end). A usage record counts toward a window when
 * start <= usedAt < end. `null` start means "unbounded in the past"; `null` end means "open-ended".
 */
import type { Period, Weekday } from "./benefit-rules";
import { WEEKDAYS } from "./benefit-rules";

export type Window = { start: Date | null; end: Date | null };

type LocalParts = { year: number; month: number; day: number; weekday: number /* 0=Mon..6=Sun */ };

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function partsOf(instant: Date, tz: string) {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(instant)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_INDEX[out.weekday],
  };
}

export function localParts(instant: Date, tz: string): LocalParts {
  const p = partsOf(instant, tz);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
}

/** Offset (ms) of `tz` from UTC at `instant`. */
function tzOffsetMs(instant: Date, tz: string): number {
  const p = partsOf(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight on the given local calendar date in `tz` (DST-safe for whole-hour shifts). */
export function localMidnightUtc(year: number, month: number, day: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  // Re-evaluate once in case the offset differs at the resulting instant (DST transition).
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

/** Calendar arithmetic on local dates, normalised through Date.UTC. */
function addLocalDays(y: number, m: number, d: number, days: number): [number, number, number] {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

export function computeWindow(
  period: Period,
  now: Date,
  tz: string,
  coverage: { start: Date; end: Date | null },
): Window {
  const lp = localParts(now, tz);
  switch (period.type) {
    case "DAY": {
      const start = localMidnightUtc(lp.year, lp.month, lp.day, tz);
      const [y, m, d] = addLocalDays(lp.year, lp.month, lp.day, 1);
      return { start, end: localMidnightUtc(y, m, d, tz) };
    }
    case "WEEK": {
      const startIdx = WEEKDAYS.indexOf(period.weekStartsOn as Weekday);
      const back = (lp.weekday - startIdx + 7) % 7;
      const [sy, sm, sd] = addLocalDays(lp.year, lp.month, lp.day, -back);
      const [ey, em, ed] = addLocalDays(sy, sm, sd, 7);
      return { start: localMidnightUtc(sy, sm, sd, tz), end: localMidnightUtc(ey, em, ed, tz) };
    }
    case "MONTH": {
      const start = localMidnightUtc(lp.year, lp.month, 1, tz);
      const ny = lp.month === 12 ? lp.year + 1 : lp.year;
      const nm = lp.month === 12 ? 1 : lp.month + 1;
      return { start, end: localMidnightUtc(ny, nm, 1, tz) };
    }
    case "YEAR": {
      if (period.anchor === "CALENDAR") {
        return { start: localMidnightUtc(lp.year, 1, 1, tz), end: localMidnightUtc(lp.year + 1, 1, 1, tz) };
      }
      // Coverage-anniversary year. Anniversaries on 29 Feb fall back to 28 Feb in non-leap years.
      const c = localParts(coverage.start, tz);
      const anniversary = (y: number) => {
        const dim = new Date(Date.UTC(y, c.month, 0)).getUTCDate();
        return localMidnightUtc(y, c.month, Math.min(c.day, dim), tz);
      };
      let y = lp.year;
      if (anniversary(y) > now) y -= 1;
      return { start: anniversary(y), end: anniversary(y + 1) };
    }
    case "ROLLING_DAYS":
      return { start: new Date(now.getTime() - period.days * 86_400_000), end: null };
    case "CUSTOM": {
      const [sy, sm, sd] = period.start.split("-").map(Number);
      const [ey, em, ed] = period.end.split("-").map(Number);
      const [ny, nm, nd] = addLocalDays(ey, em, ed, 1); // inclusive end date
      return { start: localMidnightUtc(sy, sm, sd, tz), end: localMidnightUtc(ny, nm, nd, tz) };
    }
    case "COVERAGE_TERM":
      return { start: coverage.start, end: coverage.end };
    case "LIFETIME":
      return { start: null, end: null };
  }
}

export function inWindow(at: Date, w: Window): boolean {
  return (w.start === null || at >= w.start) && (w.end === null || at < w.end);
}
