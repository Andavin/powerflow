import { describe, it, expect } from "vitest";
import { newWatchState, observeSnapshot, observeFreshness, isOffGrid } from "./watch";

const opts = { batteryLowPercent: 20, staleAfterMs: 5 * 60_000 };
const snap = (gridState: string | null, batterySoc: number | null = 80) => ({ gridState, batterySoc });
const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

describe("isOffGrid", () => {
  it("recognises SPAN's on/off spellings and refuses to guess otherwise", () => {
    expect(isOffGrid("PANEL_ON_GRID")).toBe(false);
    expect(isOffGrid("ON_GRID")).toBe(false);
    expect(isOffGrid("DSM_GRID_UP")).toBe(false);
    expect(isOffGrid("PANEL_OFF_GRID")).toBe(true);
    expect(isOffGrid("DSM_GRID_DOWN")).toBe(true);
    expect(isOffGrid("panel_off_grid")).toBe(true);
    expect(isOffGrid(null)).toBe(null);
    expect(isOffGrid("UNKNOWN")).toBe(null);
    expect(isOffGrid("")).toBe(null);
  });
});

describe("observeSnapshot — grid", () => {
  it("does not announce the state it starts in", () => {
    const s = newWatchState();
    expect(observeSnapshot(s, snap("PANEL_OFF_GRID"), opts)).toEqual([]);
    expect(observeSnapshot(s, snap("PANEL_OFF_GRID"), opts)).toEqual([]);
  });

  it("fires once on the way down and once on the way back", () => {
    const s = newWatchState();
    observeSnapshot(s, snap("PANEL_ON_GRID"), opts);
    expect(kinds(observeSnapshot(s, snap("PANEL_OFF_GRID"), opts))).toEqual(["GRID_DOWN"]);
    expect(observeSnapshot(s, snap("PANEL_OFF_GRID"), opts)).toEqual([]);
    expect(kinds(observeSnapshot(s, snap("PANEL_ON_GRID"), opts))).toEqual(["GRID_RESTORED"]);
    expect(observeSnapshot(s, snap("PANEL_ON_GRID"), opts)).toEqual([]);
  });

  it("ignores unknown / missing grid state without losing its place", () => {
    const s = newWatchState();
    observeSnapshot(s, snap("PANEL_ON_GRID"), opts);
    expect(observeSnapshot(s, snap(null), opts)).toEqual([]);
    expect(observeSnapshot(s, snap("SOMETHING_NEW"), opts)).toEqual([]);
    expect(kinds(observeSnapshot(s, snap("PANEL_OFF_GRID"), opts))).toEqual(["GRID_DOWN"]);
  });
});

describe("observeSnapshot — battery", () => {
  it("does not fire if it starts out already low", () => {
    const s = newWatchState();
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 10), opts)).toEqual([]);
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 9), opts)).toEqual([]);
  });

  it("fires once when SOC crosses below the threshold", () => {
    const s = newWatchState();
    observeSnapshot(s, snap("PANEL_ON_GRID", 25), opts);
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 20), opts)).toEqual([]);
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 19.5), opts)).toEqual([{ kind: "BATTERY_LOW", soc: 19.5 }]);
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 15), opts)).toEqual([]);
  });

  it("re-arms only after SOC climbs clear of the threshold", () => {
    const s = newWatchState();
    observeSnapshot(s, snap("PANEL_ON_GRID", 30), opts);
    observeSnapshot(s, snap("PANEL_ON_GRID", 19), opts);
    // Hovering around the line: no nagging.
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 21), opts)).toEqual([]);
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 19), opts)).toEqual([]);
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 24), opts)).toEqual([]);
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 19), opts)).toEqual([]);
    // Clear of it: armed again.
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 25), opts)).toEqual([]);
    expect(kinds(observeSnapshot(s, snap("PANEL_ON_GRID", 19), opts))).toEqual(["BATTERY_LOW"]);
  });

  it("is disabled by a threshold of 0 and ignores a missing SOC", () => {
    const s = newWatchState();
    observeSnapshot(s, snap("PANEL_ON_GRID", 50), { ...opts, batteryLowPercent: 0 });
    expect(observeSnapshot(s, snap("PANEL_ON_GRID", 1), { ...opts, batteryLowPercent: 0 })).toEqual([]);
    const t = newWatchState();
    observeSnapshot(t, snap("PANEL_ON_GRID", 50), opts);
    expect(observeSnapshot(t, snap("PANEL_ON_GRID", null), opts)).toEqual([]);
    expect(kinds(observeSnapshot(t, snap("PANEL_ON_GRID", 5), opts))).toEqual(["BATTERY_LOW"]);
  });

  it("can report grid and battery in the same snapshot", () => {
    const s = newWatchState();
    observeSnapshot(s, snap("PANEL_ON_GRID", 50), opts);
    expect(kinds(observeSnapshot(s, snap("PANEL_OFF_GRID", 5), opts))).toEqual(["GRID_DOWN", "BATTERY_LOW"]);
  });
});

describe("observeFreshness", () => {
  const T0 = 1_000_000;

  it("waits for stale_after before announcing, then announces once", () => {
    const s = newWatchState();
    expect(observeFreshness(s, { stale: true, ageSeconds: 61, table: "power_flows" }, T0, opts)).toEqual([]);
    expect(observeFreshness(s, { stale: true, ageSeconds: 299, table: "power_flows" }, T0 + 238_000, opts)).toEqual([]);
    expect(observeFreshness(s, { stale: true, ageSeconds: 300, table: "power_flows" }, T0 + 239_000, opts)).toEqual([
      { kind: "DATA_STALE", ageSeconds: 300, table: "power_flows" },
    ]);
    expect(observeFreshness(s, { stale: true, ageSeconds: 360, table: "power_flows" }, T0 + 299_000, opts)).toEqual([]);
  });

  it("announces recovery once, only if the outage was announced", () => {
    const s = newWatchState();
    observeFreshness(s, { stale: true, ageSeconds: 100 }, T0, opts);
    expect(observeFreshness(s, { stale: false }, T0 + 60_000, opts)).toEqual([]); // never announced → nothing to recover from
    observeFreshness(s, { stale: true, ageSeconds: 600 }, T0 + 120_000, opts);
    expect(kinds(observeFreshness(s, { stale: false }, T0 + 180_000, opts))).toEqual(["DATA_RESUMED"]);
    expect(observeFreshness(s, { stale: false }, T0 + 240_000, opts)).toEqual([]);
  });

  it("times an unreachable database from the first failed check", () => {
    const s = newWatchState();
    expect(observeFreshness(s, { stale: true, error: "ECONNREFUSED" }, T0, opts)).toEqual([]);
    expect(observeFreshness(s, { stale: true, error: "ECONNREFUSED" }, T0 + 299_000, opts)).toEqual([]);
    expect(observeFreshness(s, { stale: true, error: "ECONNREFUSED" }, T0 + 300_000, opts)).toEqual([
      { kind: "DATA_STALE", ageSeconds: 300 },
    ]);
  });
});
