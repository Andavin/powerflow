import { describe, it, expect } from "vitest";
import {
  civilParts,
  wallTimeToUtc,
  startOfDay,
  addDays,
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

describe("startOfDay / addDays", () => {
  const now = new Date("2026-06-28T02:37:00Z"); // local 2026-06-27 20:37
  it("start of local day is previous 06:00 UTC", () => {
    expect(new Date(startOfDay(now, TZ)).toISOString()).toBe(
      "2026-06-27T06:00:00.000Z",
    );
  });
  it("adds local days preserving midnight", () => {
    expect(new Date(addDays(now, TZ, 1)).toISOString()).toBe(
      "2026-06-28T06:00:00.000Z",
    );
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
