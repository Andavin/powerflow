import { describe, it, expect } from "vitest";
import {
  toFlowSnapshot,
  toCircuit,
  topConsumers,
  bucketDurationsHours,
  integrate,
  seriesFromFlowRows,
  circuitEnergyFromRows,
  circuitSeriesFromRows,
  homeSourceMix,
  num,
} from "./transform";
import type { TimeWindow } from "./time";

describe("num", () => {
  it("parses numbers and strings, rejects junk", () => {
    expect(num(5)).toBe(5);
    expect(num("5.5")).toBe(5.5);
    expect(num("nope")).toBeNull();
    expect(num(null)).toBeNull();
  });
});

describe("toFlowSnapshot", () => {
  it("normalises signs (negative raw = supplying home)", () => {
    // From a real reading: site=5274, grid=-7, pv=-2192, battery=-3075
    const snap = toFlowSnapshot(
      { ts: "2026-06-28T02:10:00Z", site: 5274, grid: -7, pv: -2192, battery: -3075 },
      { soc: 56, grid_state: "ON_GRID", connected: true },
    );
    expect(snap.homeW).toBe(5274);
    expect(snap.solarW).toBe(2192);
    expect(snap.gridW).toBe(7); // importing
    expect(snap.batteryW).toBe(3075); // discharging
    expect(snap.batterySoc).toBe(56);
    expect(snap.gridState).toBe("ON_GRID");
  });

  it("derives battery % from state-of-energy the SPAN way (soe / usable)", () => {
    // Real reading: soe=3.0 kWh maps to 22% (SPAN), not the raw soc field (18.4).
    const snap = toFlowSnapshot(
      { site: 0, grid: 0, pv: 0, battery: 0 },
      { soc: 18.4, soe: 3.0, grid_state: "ON_GRID", connected: true },
    );
    expect(snap.batterySoc).toBe(22);
  });

  it("falls back to the raw soc field when soe is absent", () => {
    const snap = toFlowSnapshot(
      { site: 0, grid: 0, pv: 0, battery: 0 },
      { soc: 56, grid_state: "ON_GRID", connected: true },
    );
    expect(snap.batterySoc).toBe(56);
  });

  it("preserves the invariant home = solar + grid + battery", () => {
    const snap = toFlowSnapshot({
      site: 5274,
      grid: -7,
      pv: -2192,
      battery: -3075,
    });
    expect(snap.solarW + snap.gridW + snap.batteryW).toBe(snap.homeW);
  });

  it("represents export and charging as negative", () => {
    const snap = toFlowSnapshot({ site: 100, grid: 500, pv: -3000, battery: 2400 });
    expect(snap.gridW).toBe(-500); // exporting to grid
    expect(snap.batteryW).toBe(-2400); // charging
    expect(snap.solarW).toBe(3000);
  });

  it("clamps solar to non-negative", () => {
    expect(toFlowSnapshot({ pv: 12, site: 0, grid: 0, battery: 0 }).solarW).toBe(0);
  });
});

describe("toCircuit", () => {
  it("maps relay CLOSED to on and negates consumption to positive watts", () => {
    // A drawing circuit reports negative active_power (EV charger = -3965).
    const c = toCircuit({
      circuit_id: "c1",
      name: "EV Charger",
      active_power: -3965.5,
      relay: "CLOSED",
    });
    expect(c.isOn).toBe(true);
    expect(c.watts).toBe(3966);
    expect(c.name).toBe("EV Charger");
  });
  it("maps relay OPEN to off", () => {
    expect(toCircuit({ relay: "OPEN", active_power: 0 }).isOn).toBe(false);
  });
});

describe("topConsumers", () => {
  const circuits = [
    { id: "a", name: "EV", watts: 3965 },
    { id: "b", name: "Bed", watts: 396 },
    { id: "c", name: "Off", watts: 0 },
    { id: "d", name: "Neg", watts: -5 },
  ].map((c) => ({ ...c, relayState: "CLOSED", isOn: true, space: null, breakerRating: null, sheddable: false, alwaysOn: false, controllable: true }));

  it("ranks by draw, ignores zero/negative, computes share", () => {
    const top = topConsumers(circuits, 5);
    expect(top.map((t) => t.id)).toEqual(["a", "b"]);
    expect(top[0].share).toBeCloseTo(3965 / (3965 + 396), 5);
  });
});

describe("bucketDurationsHours", () => {
  const h = (n: number) => Date.UTC(2026, 5, 27, n);
  it("uses gaps between starts and clips the last to now", () => {
    const starts = [h(0), h(1), h(2)];
    const dur = bucketDurationsHours(starts, h(24), h(2) + 1_800_000); // now = 2:30
    expect(dur).toEqual([1, 1, 0.5]);
  });
});

describe("integrate", () => {
  it("converts avg watts over hours into kWh", () => {
    expect(integrate(2000, 1)).toBe(2); // 2kW for 1h = 2kWh
    expect(integrate(1500, 0.5)).toBe(0.75);
  });
});

describe("seriesFromFlowRows", () => {
  const window: TimeWindow = {
    from: "2026-06-27T06:00:00.000Z",
    to: "2026-06-27T09:00:00.000Z",
    bucket: "hour",
  };
  // The *_sum columns are sums over n samples, i.e. avgWatts * n.
  const rows = [
    { ts: "2026-06-27T06:00:00.000Z", site_w: 1000, pv_w: -2000, grid_w: -100, battery_w: 1100, batt_charge_sum: 110000, batt_discharge_sum: 0, grid_import_sum: 10000, grid_export_sum: 0, n: 100 },
    { ts: "2026-06-27T07:00:00.000Z", site_w: 2000, pv_w: -500, grid_w: -1500, battery_w: 0, batt_charge_sum: 0, batt_discharge_sum: 0, grid_import_sum: 150000, grid_export_sum: 0, n: 100 },
  ];
  const now = new Date("2026-06-27T08:00:00.000Z").getTime();

  it("integrates solar production to positive kWh", () => {
    const s = seriesFromFlowRows(rows, window, "solar", now);
    expect(s.points[0].kWh).toBe(2); // 2000W * 1h
    expect(s.points[1].kWh).toBe(0.5);
    expect(s.totals.kWh).toBe(2.5);
  });

  it("home consumption stays positive as-is", () => {
    const s = seriesFromFlowRows(rows, window, "home", now);
    expect(s.points[0].kWh).toBe(1);
    expect(s.points[1].kWh).toBe(2);
  });

  it("battery splits charge vs discharge energy", () => {
    const s = seriesFromFlowRows(rows, window, "battery", now);
    expect(s.points[0].chargedKWh).toBe(1.1);
    expect(s.points[0].dischargedKWh).toBe(0);
    expect(s.totals.chargedKWh).toBe(1.1);
  });

  it("grid tracks import/export totals", () => {
    const s = seriesFromFlowRows(rows, window, "grid", now);
    expect(s.totals.importedKWh).toBeCloseTo(1.6, 5);
    expect(s.totals.exportedKWh).toBe(0);
  });

  it("grid exposes per-bucket import/export for the diverging chart", () => {
    const s = seriesFromFlowRows(rows, window, "grid", now);
    expect(s.points[0].importedKWh).toBeCloseTo(0.1, 5); // 10000/100 W over 1h
    expect(s.points[1].importedKWh).toBeCloseTo(1.5, 5);
    expect(s.points[0].exportedKWh).toBe(0);
  });
});

describe("homeSourceMix + circuitEnergyFromRows", () => {
  it("computes supplying-source fractions", () => {
    const mix = homeSourceMix({
      pv_w: -3000,
      batt_discharge_sum: 100,
      grid_import_sum: 100,
      n: 100,
    });
    // solar 3000, battery 1, grid 1 -> solar ~0.999
    expect(mix.solar).toBeGreaterThan(0.99);
    expect(mix.solar + mix.battery + mix.grid).toBeCloseTo(1, 2);
  });

  it("builds a circuit energy series from summed Wh", () => {
    const window: TimeWindow = {
      from: "2026-06-29T06:00:00.000Z",
      to: "2026-06-29T08:00:00.000Z",
      bucket: "hour",
    };
    const series = circuitSeriesFromRows(
      [
        { ts: "2026-06-29T06:00:00.000Z", wh: 3 },
        { ts: "2026-06-29T07:00:00.000Z", wh: 6474 },
      ],
      window,
    );
    expect(series.points.map((p) => p.kWh)).toEqual([0.003, 6.474]);
    expect(series.totals.kWh).toBe(6.477);
    expect(series.bucket).toBe("hour");
  });

  it("attaches mix and filters zero-energy circuits", () => {
    const mix = { solar: 0.3, battery: 0.5, grid: 0.2 };
    const out = circuitEnergyFromRows(
      [
        { node_id: "a", name: "EV", exported_wh: 42000, imported_wh: 3 },
        { node_id: "b", name: "Idle", exported_wh: 0 },
      ],
      mix,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kWh).toBe(42);
    expect(out[0].mix).toEqual(mix);
  });
});
