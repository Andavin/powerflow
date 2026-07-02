import { describe, it, expect } from "vitest";
import { deriveWindows, periodLabel, periodNoun } from "./period";

const NOW = new Date("2026-06-28T02:37:00Z"); // local Sat 2026-06-27 20:37 MDT

describe("periodNoun", () => {
  it("maps presets to their nouns", () => {
    expect(periodNoun("today")).toBe("day");
    expect(periodNoun("week")).toBe("week");
    expect(periodNoun("month")).toBe("month");
    expect(periodNoun("year")).toBe("year");
  });
  it("custom is 'period'", () => {
    expect(periodNoun("custom")).toBe("period");
  });
});

describe("deriveWindows — preset", () => {
  it("today: prev is yesterday, same duration", () => {
    const { win, prev } = deriveWindows("today", 0, "", "", NOW);
    expect(win.from).toBe("2026-06-27T06:00:00.000Z");
    expect(win.to).toBe("2026-06-28T06:00:00.000Z");
    expect(prev.from).toBe("2026-06-26T06:00:00.000Z");
    expect(prev.to).toBe("2026-06-27T06:00:00.000Z");
  });

  it("today with offset -1: win is yesterday, prev is 2 days ago", () => {
    const { win, prev } = deriveWindows("today", -1, "", "", NOW);
    expect(win.from).toBe("2026-06-26T06:00:00.000Z");
    expect(prev.from).toBe("2026-06-25T06:00:00.000Z");
    expect(prev.to).toBe("2026-06-26T06:00:00.000Z");
  });

  it("week: prev is the previous calendar week", () => {
    const { win, prev } = deriveWindows("week", 0, "", "", NOW);
    expect(win.from).toBe("2026-06-21T06:00:00.000Z");
    expect(win.to).toBe("2026-06-28T06:00:00.000Z");
    expect(prev.from).toBe("2026-06-14T06:00:00.000Z");
    expect(prev.to).toBe("2026-06-21T06:00:00.000Z");
  });

  it("month: prev is the previous calendar month, across the Jan/Dec rollover", () => {
    const jan = new Date("2026-01-15T18:00:00Z"); // local Jan 15 in MST
    const { prev } = deriveWindows("month", 0, "", "", jan);
    expect(prev.from).toBe("2025-12-01T07:00:00.000Z");
    expect(prev.to).toBe("2026-01-01T07:00:00.000Z");
  });
});

describe("deriveWindows — custom", () => {
  it("prev is the same-duration window immediately before win", () => {
    const { win, prev } = deriveWindows("custom", 0, "2026-06-01", "2026-06-07", NOW);
    expect(win.from).toBe("2026-06-01T06:00:00.000Z");
    expect(win.to).toBe("2026-06-08T06:00:00.000Z"); // exclusive end
    // Duration is 7 days. prev spans the 7 days ending at win.from.
    expect(prev.to).toBe(win.from);
    const dur = new Date(win.to).getTime() - new Date(win.from).getTime();
    expect(new Date(prev.to).getTime() - new Date(prev.from).getTime()).toBe(dur);
  });

  it("swaps an inverted range instead of producing negative duration", () => {
    const inverted = deriveWindows("custom", 0, "2026-06-07", "2026-06-01", NOW);
    const canonical = deriveWindows("custom", 0, "2026-06-01", "2026-06-07", NOW);
    expect(inverted.win.from).toBe(canonical.win.from);
    expect(inverted.win.to).toBe(canonical.win.to);
    expect(inverted.prev).toEqual(canonical.prev);
  });
});

describe("periodLabel", () => {
  it("today special cases 0 and -1", () => {
    expect(periodLabel("today", 0, "2026-06-27T06:00:00.000Z", "2026-06-28T06:00:00.000Z")).toBe("Today");
    expect(periodLabel("today", -1, "2026-06-26T06:00:00.000Z", "2026-06-27T06:00:00.000Z")).toBe(
      "Yesterday",
    );
  });
});
