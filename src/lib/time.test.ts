import { describe, it, expect } from "vitest";
import {
  civilParts,
  wallTimeToUtc,
  resolveRange,
  bucketForSpan,
  sampleByUnit,
} from "./time";

const TZ = "America/Denver";

describe("civilParts", () => {
  it("converts a UTC instant to Denver wall-clock (MDT, summer)", () => {
    // 2026-06-28T02:37:00Z is 2026-06-27 20:37 local (UTC-6, MDT).
    const c = civilParts(new Date("2026-06-28T02:37:00Z"), TZ);
    expect(c).toMatchObject({
      year: 2026,
      month: 6,
      day: 27,
      hour: 20,
      minute: 37,
      weekday: 6, // Saturday
    });
  });

  it("handles MST (winter, UTC-7)", () => {
    const c = civilParts(new Date("2026-01-15T06:30:00Z"), TZ);
    expect(c).toMatchObject({ year: 2026, month: 1, day: 14, hour: 23, minute: 30 });
  });
});

describe("wallTimeToUtc", () => {
  it("maps Denver midnight in summer to 06:00 UTC", () => {
    const utc = wallTimeToUtc(TZ, 2026, 6, 27);
    expect(new Date(utc).toISOString()).toBe("2026-06-27T06:00:00.000Z");
  });

  it("maps Denver midnight in winter to 07:00 UTC", () => {
    const utc = wallTimeToUtc(TZ, 2026, 1, 15);
    expect(new Date(utc).toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });
});

describe("resolveRange", () => {
  const now = new Date("2026-06-28T02:37:00Z"); // local Sat 2026-06-27 20:37

  it("today spans local midnight to next local midnight, hourly", () => {
    const w = resolveRange("today", now, TZ);
    expect(w.from).toBe("2026-06-27T06:00:00.000Z");
    expect(w.to).toBe("2026-06-28T06:00:00.000Z");
    expect(w.bucket).toBe("hour");
  });

  it("week is the calendar week starting Sunday, daily", () => {
    // Sat 6/27 -> week started Sun 6/21.
    const w = resolveRange("week", now, TZ);
    expect(w.from).toBe("2026-06-21T06:00:00.000Z");
    expect(w.to).toBe("2026-06-28T06:00:00.000Z");
    expect(w.bucket).toBe("day");
  });

  it("month is the calendar month, daily", () => {
    const w = resolveRange("month", now, TZ);
    expect(w.from).toBe("2026-06-01T06:00:00.000Z");
    expect(w.to).toBe("2026-07-01T06:00:00.000Z");
    expect(w.bucket).toBe("day");
  });

  it("year is the calendar year, monthly", () => {
    const w = resolveRange("year", now, TZ);
    expect(w.from).toBe("2026-01-01T07:00:00.000Z"); // Jan = MST
    expect(w.to).toBe("2027-01-01T07:00:00.000Z");
    expect(w.bucket).toBe("month");
  });

  it("offset steps whole periods into the past", () => {
    // Previous day.
    expect(resolveRange("today", now, TZ, -1).from).toBe("2026-06-26T06:00:00.000Z");
    expect(resolveRange("today", now, TZ, -1).to).toBe("2026-06-27T06:00:00.000Z");
    // Previous calendar week.
    const lastWeek = resolveRange("week", now, TZ, -1);
    expect(lastWeek.from).toBe("2026-06-14T06:00:00.000Z");
    expect(lastWeek.to).toBe("2026-06-21T06:00:00.000Z");
    // Previous calendar month (May; MDT in summer).
    expect(resolveRange("month", now, TZ, -1).from).toBe("2026-05-01T06:00:00.000Z");
    expect(resolveRange("month", now, TZ, -1).to).toBe("2026-06-01T06:00:00.000Z");
    // Previous year.
    expect(resolveRange("year", now, TZ, -1).from).toBe("2025-01-01T07:00:00.000Z");
  });
});

describe("bucketForSpan", () => {
  const h = (n: number) => n * 3_600_000;
  it("hour for <= 48h", () => {
    expect(bucketForSpan(0, h(48))).toBe("hour");
  });
  it("day for a few weeks", () => {
    expect(bucketForSpan(0, h(24 * 30))).toBe("day");
  });
  it("month for > 3 months", () => {
    expect(bucketForSpan(0, h(24 * 200))).toBe("month");
  });
});

describe("sampleByUnit", () => {
  it("maps buckets to QuestDB units", () => {
    expect(sampleByUnit("hour")).toBe("1h");
    expect(sampleByUnit("day")).toBe("1d");
    expect(sampleByUnit("month")).toBe("1M");
  });
});

describe("wallTimeToUtc — DST transitions", () => {
  // In America/Denver DST, spring-forward is the 2nd Sunday of March: 2026-03-08.
  // At 02:00 local, clocks jump to 03:00 (so 02:30 doesn't exist in wall time).
  // The two-pass offset refinement inside wallTimeToUtc has to handle this.
  it("Denver midnight on spring-forward Sunday resolves under MST offset", () => {
    const utc = wallTimeToUtc(TZ, 2026, 3, 8);
    // 2026-03-08 local midnight is BEFORE the 02:00 jump, so still MST (-7).
    expect(new Date(utc).toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("Denver noon on spring-forward Sunday resolves under MDT offset", () => {
    // After 03:00 local it's MDT (-6).
    const utc = wallTimeToUtc(TZ, 2026, 3, 8, 12);
    expect(new Date(utc).toISOString()).toBe("2026-03-08T18:00:00.000Z");
  });

  // Fall-back for 2026 is 2026-11-01. At 02:00 local, clocks fall to 01:00
  // (so 01:30 exists twice). Ensure a wall-clock midnight still lands right.
  it("Denver midnight on fall-back Sunday resolves under MDT offset", () => {
    // Before 02:00 the offset is still MDT (-6).
    const utc = wallTimeToUtc(TZ, 2026, 11, 1);
    expect(new Date(utc).toISOString()).toBe("2026-11-01T06:00:00.000Z");
  });
});

describe("resolveRange — calendar boundaries", () => {
  it("today spans exactly across the DST transition", () => {
    // Instant on the fall-back day (already past 02:00 wall clock).
    const sundayFallBack = new Date("2026-11-01T19:00:00Z");
    const w = resolveRange("today", sundayFallBack, TZ);
    expect(w.from).toBe("2026-11-01T06:00:00.000Z"); // pre-transition midnight, MDT
    expect(w.to).toBe("2026-11-02T07:00:00.000Z"); // next midnight, MST — 25h span
  });

  it("week when now is Sunday: window starts on that same Sunday", () => {
    // Sunday 2026-05-03 local — weekday=0. The `day - weekday` math must
    // not treat 0 as 'last week'.
    const sunday = new Date("2026-05-03T15:00:00Z");
    const w = resolveRange("week", sunday, TZ);
    expect(w.from).toBe("2026-05-03T06:00:00.000Z");
    expect(w.to).toBe("2026-05-10T06:00:00.000Z");
  });

  it("month rolls Dec → Jan across a year boundary", () => {
    const jan = new Date("2026-01-05T15:00:00Z");
    const w = resolveRange("month", jan, TZ, -1);
    expect(w.from).toBe("2025-12-01T07:00:00.000Z");
    expect(w.to).toBe("2026-01-01T07:00:00.000Z");
  });

  it("year offset -1 walks the calendar year back", () => {
    const w = resolveRange("year", new Date("2026-06-15T00:00:00Z"), TZ, -1);
    expect(w.from).toBe("2025-01-01T07:00:00.000Z");
    expect(w.to).toBe("2026-01-01T07:00:00.000Z");
  });
});
