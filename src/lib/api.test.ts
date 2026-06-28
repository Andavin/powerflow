import { describe, it, expect } from "vitest";
import { parseStatsQuery, parseSource, BadRequestError } from "./api";

const TZ = "America/Denver";
const NOW = new Date("2026-06-28T02:37:00Z"); // local Sat 2026-06-27 20:37

describe("parseSource", () => {
  it("accepts valid sources, defaults to home", () => {
    expect(parseSource("solar")).toBe("solar");
    expect(parseSource("battery")).toBe("battery");
    expect(parseSource("bogus")).toBe("home");
    expect(parseSource(null)).toBe("home");
  });
});

describe("parseStatsQuery", () => {
  const q = (s: string) => parseStatsQuery(new URLSearchParams(s), NOW, TZ);

  it("defaults to home/today", () => {
    const r = q("");
    expect(r.source).toBe("home");
    expect(r.range).toBe("today");
    expect(r.window.bucket).toBe("hour");
  });

  it("resolves a preset range", () => {
    const r = q("source=solar&range=month");
    expect(r.source).toBe("solar");
    expect(r.range).toBe("month");
    expect(r.window.from).toBe("2026-06-01T06:00:00.000Z");
  });

  it("resolves a custom range and auto-buckets", () => {
    const r = q("source=grid&from=2026-06-01T06:00:00Z&to=2026-06-08T06:00:00Z");
    expect(r.range).toBe("custom");
    expect(r.window.bucket).toBe("day");
  });

  it("rejects half-specified custom ranges", () => {
    expect(() => q("from=2026-06-01T06:00:00Z")).toThrow(BadRequestError);
  });

  it("rejects inverted custom ranges", () => {
    expect(() =>
      q("from=2026-06-08T06:00:00Z&to=2026-06-01T06:00:00Z"),
    ).toThrow(BadRequestError);
  });

  it("rejects invalid timestamps", () => {
    expect(() => q("from=nope&to=nah")).toThrow(BadRequestError);
  });
});
