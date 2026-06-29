import { describe, it, expect } from "vitest";
import {
  emptyLiveState,
  applyMessage,
  buildSnapshot,
  isFlowReady,
} from "./state";

const PREFIX = "ebus/5";
const DEV = "nj-2338-00fq1";
const apply = (s: ReturnType<typeof emptyLiveState>, topic: string, payload: string) =>
  applyMessage(s, PREFIX, DEV, topic, payload);

describe("applyMessage — power-flows", () => {
  it("captures the four flow channels with raw signs", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/nj-2338-00fq1/power-flows/site", "5274.4")).toBe(true);
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/grid", "-7");
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/pv", "-2192.4");
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/battery", "-3075");
    expect(s.flow).toEqual({ site: 5274.4, grid: -7, pv: -2192.4, battery: -3075 });
    expect(isFlowReady(s)).toBe(true);
  });

  it("is not ready until all four channels are present", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/site", "100");
    expect(isFlowReady(s)).toBe(false);
  });
});

describe("applyMessage — bess", () => {
  it("coerces soc to number and connected to boolean", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/nj-2338-00fq1/bess/soc", "56.2");
    apply(s, "ebus/5/nj-2338-00fq1/bess/grid_state", "ON_GRID");
    apply(s, "ebus/5/nj-2338-00fq1/bess/connected", "false");
    expect(s.bess.soc).toBe(56.2);
    expect(s.bess.grid_state).toBe("ON_GRID");
    // "false" must become boolean false, not truthy string.
    expect(s.bess.connected).toBe(false);
  });
});

describe("applyMessage — circuits", () => {
  it("negates a circuit's active_power into positive draw", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/nj-2338-00fq1/abc123/active_power", "-3965.5");
    expect(s.circuitWatts.get("abc123")).toBe(3966);
  });

  it("ignores active_power from system nodes (e.g. lugs)", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/nj-2338-00fq1/lugs-upstream/active_power", "-50")).toBe(false);
    expect(s.circuitWatts.size).toBe(0);
  });

  it("ignores non-active_power circuit properties", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/nj-2338-00fq1/abc123/relay", "CLOSED")).toBe(false);
  });
});

describe("applyMessage — rejects", () => {
  it("ignores other devices and Homie attributes", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/other-device/power-flows/site", "1")).toBe(false);
    expect(apply(s, "ebus/5/nj-2338-00fq1/power-flows/$name", "Power Flows")).toBe(false);
    expect(apply(s, "ebus/5/nj-2338-00fq1/abc123/active_power/$target", "x")).toBe(false);
  });
});

describe("buildSnapshot", () => {
  it("normalises flow signs and ranks top consumers by draw", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/site", "5274");
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/grid", "-7");
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/pv", "-2192");
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/battery", "-3075");
    apply(s, "ebus/5/nj-2338-00fq1/bess/soc", "56");
    apply(s, "ebus/5/nj-2338-00fq1/ev/active_power", "-3965");
    apply(s, "ebus/5/nj-2338-00fq1/fridge/active_power", "-120");

    const names = new Map([
      ["ev", "EV Charger"],
      ["fridge", "Fridge"],
    ]);
    const snap = buildSnapshot(s, names, Date.parse("2026-06-28T02:10:00Z"));

    expect(snap.flow.homeW).toBe(5274);
    expect(snap.flow.solarW).toBe(2192);
    expect(snap.flow.batteryW).toBe(3075); // discharging
    expect(snap.flow.batterySoc).toBe(56);
    expect(snap.top[0]).toMatchObject({ id: "ev", name: "EV Charger", watts: 3965 });
    expect(snap.top[0].share).toBeCloseTo(3965 / (3965 + 120), 5);
  });

  it("falls back to the circuit id when no name is known", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/nj-2338-00fq1/xyz/active_power", "-500");
    const snap = buildSnapshot(s, new Map());
    expect(snap.top[0].name).toBe("xyz");
  });
});
