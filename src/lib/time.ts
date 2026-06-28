import type { Bucket, StatRange } from "./types";

/**
 * Timezone-aware window math, DST-correct, with no external dependencies.
 *
 * QuestDB stores timestamps in UTC; the panel reports in a civil timezone
 * (America/Denver). "Today / week / month / year" must be computed against the
 * panel's wall clock, so we convert wall times to UTC instants here.
 */

export interface TimeWindow {
  /** Inclusive UTC ISO start. */
  from: string;
  /** Exclusive UTC ISO end. */
  to: string;
  bucket: Bucket;
}

interface Civil {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sun..6=Sat
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Civil (wall-clock) fields of an instant in a given timezone. */
export function civilParts(instant: Date, tz: string): Civil {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Offset (localWall - UTC) in ms at the given instant for a timezone. */
function tzOffsetMs(instant: Date, tz: string): number {
  const c = civilParts(instant, tz);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - instant.getTime();
}

/** Convert a wall-clock time in `tz` to the corresponding UTC instant (ms). */
export function wallTimeToUtc(
  tz: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  // Refine for DST: the offset depends on the instant, so iterate once.
  const off1 = tzOffsetMs(new Date(naive), tz);
  let utc = naive - off1;
  const off2 = tzOffsetMs(new Date(utc), tz);
  if (off2 !== off1) utc = naive - off2;
  return utc;
}

/** Start of the local day containing `instant`, as a UTC instant (ms). */
export function startOfDay(instant: Date, tz: string): number {
  const c = civilParts(instant, tz);
  return wallTimeToUtc(tz, c.year, c.month, c.day);
}

/** Add `n` whole local days to a UTC instant, preserving local midnight. */
export function addDays(instant: Date, tz: string, n: number): number {
  const c = civilParts(instant, tz);
  return wallTimeToUtc(tz, c.year, c.month, c.day + n);
}

/** Resolve a preset range to a concrete UTC window + bucket. */
export function resolveRange(
  range: StatRange,
  now: Date,
  tz: string,
): TimeWindow {
  const c = civilParts(now, tz);
  switch (range) {
    case "today": {
      const from = wallTimeToUtc(tz, c.year, c.month, c.day);
      const to = wallTimeToUtc(tz, c.year, c.month, c.day + 1);
      return iso(from, to, "hour");
    }
    case "week": {
      // Calendar week starting Sunday.
      const from = wallTimeToUtc(tz, c.year, c.month, c.day - c.weekday);
      const to = wallTimeToUtc(tz, c.year, c.month, c.day - c.weekday + 7);
      return iso(from, to, "day");
    }
    case "month": {
      const from = wallTimeToUtc(tz, c.year, c.month, 1);
      const to = wallTimeToUtc(tz, c.year, c.month + 1, 1);
      return iso(from, to, "day");
    }
    case "year": {
      const from = wallTimeToUtc(tz, c.year, 1, 1);
      const to = wallTimeToUtc(tz, c.year + 1, 1, 1);
      return iso(from, to, "month");
    }
  }
}

/** Pick a sensible bucket size for an arbitrary custom window. */
export function bucketForSpan(fromMs: number, toMs: number): Bucket {
  const hours = (toMs - fromMs) / 3_600_000;
  if (hours <= 48) return "hour";
  if (hours <= 24 * 92) return "day"; // up to ~3 months
  return "month";
}

export function customWindow(from: Date, to: Date): TimeWindow {
  return iso(from.getTime(), to.getTime(), bucketForSpan(from.getTime(), to.getTime()));
}

function iso(fromMs: number, toMs: number, bucket: Bucket): TimeWindow {
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    bucket,
  };
}

/** QuestDB SAMPLE BY unit literal for a bucket. */
export function sampleByUnit(bucket: Bucket): string {
  switch (bucket) {
    case "hour":
      return "1h";
    case "day":
      return "1d";
    case "month":
      return "1M";
  }
}
