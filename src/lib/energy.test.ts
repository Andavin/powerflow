import { describe, it, expect } from "vitest";
import { sourceMetrics, headlineKWh } from "./energy";
import type { EnergySeries, StatSource } from "./types";

function series(source: StatSource, totals: EnergySeries["totals"]): EnergySeries {
  return {
    source,
    range: "today",
    bucket: "hour",
    from: "2026-06-27T06:00:00.000Z",
    to: "2026-06-28T06:00:00.000Z",
    points: [],
    totals,
  };
}

describe("sourceMetrics", () => {
  it("battery: discharged primary, charged secondary", () => {
    const r = sourceMetrics(series("battery", { kWh: 0, dischargedKWh: 4.2, chargedKWh: 5.1 }));
    expect(r.primary).toEqual({ kWh: 4.2, label: "Discharged" });
    expect(r.secondary).toEqual({ kWh: 5.1, label: "Charged" });
  });

  it("battery: falls back to 0 for missing sides", () => {
    const r = sourceMetrics(series("battery", { kWh: 0 }));
    expect(r.primary.kWh).toBe(0);
    expect(r.secondary?.kWh).toBe(0);
  });

  it("grid: imported primary, exported secondary", () => {
    const r = sourceMetrics(series("grid", { kWh: 0, importedKWh: 7, exportedKWh: 3 }));
    expect(r.primary).toEqual({ kWh: 7, label: "Imported" });
    expect(r.secondary).toEqual({ kWh: 3, label: "Exported" });
  });

  it("solar: generated only, no secondary", () => {
    const r = sourceMetrics(series("solar", { kWh: 12.5 }));
    expect(r.primary).toEqual({ kWh: 12.5, label: "Generated" });
    expect(r.secondary).toBeUndefined();
  });

  it("home: consumed only, no secondary", () => {
    const r = sourceMetrics(series("home", { kWh: 18 }));
    expect(r.primary).toEqual({ kWh: 18, label: "Consumed" });
    expect(r.secondary).toBeUndefined();
  });
});

describe("headlineKWh", () => {
  it("returns the primary kWh for a series", () => {
    expect(headlineKWh(series("battery", { kWh: 0, dischargedKWh: 4, chargedKWh: 2 }))).toBe(4);
    expect(headlineKWh(series("grid", { kWh: 0, importedKWh: 9, exportedKWh: 1 }))).toBe(9);
    expect(headlineKWh(series("solar", { kWh: 11 }))).toBe(11);
    expect(headlineKWh(series("home", { kWh: 22 }))).toBe(22);
  });
  it("returns 0 for undefined", () => {
    expect(headlineKWh(undefined)).toBe(0);
  });
});
