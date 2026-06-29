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

  it("captures circuit relay state", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/nj-2338-00fq1/abc123/relay", "open")).toBe(true);
    expect(s.circuitRelay.get("abc123")).toBe("OPEN");
  });

  it("ignores unrelated circuit properties", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/nj-2338-00fq1/abc123/breaker_rating", "20")).toBe(false);
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
  const circuitMeta = (over: Partial<import("../types").Circuit>): import("../types").Circuit => ({
    id: "?",
    name: "?",
    watts: 0,
    relayState: "CLOSED",
    isOn: true,
    space: null,
    breakerRating: null,
    sheddable: false,
    alwaysOn: false,
    ...over,
  });

  it("normalises flow signs, ranks top consumers, and lists circuits", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/site", "5274");
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/grid", "-7");
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/pv", "-2192");
    apply(s, "ebus/5/nj-2338-00fq1/power-flows/battery", "-3075");
    apply(s, "ebus/5/nj-2338-00fq1/bess/soc", "56");
    apply(s, "ebus/5/nj-2338-00fq1/ev/active_power", "-3965");
    apply(s, "ebus/5/nj-2338-00fq1/fridge/active_power", "-120");
    apply(s, "ebus/5/nj-2338-00fq1/fridge/relay", "OPEN");

    const meta = new Map([
      ["ev", circuitMeta({ id: "ev", name: "EV Charger", space: 1 })],
      ["fridge", circuitMeta({ id: "fridge", name: "Fridge", alwaysOn: true })],
    ]);
    const snap = buildSnapshot(s, meta, Date.parse("2026-06-28T02:10:00Z"));

    expect(snap.flow.homeW).toBe(5274);
    expect(snap.flow.solarW).toBe(2192);
    expect(snap.flow.batteryW).toBe(3075); // discharging
    expect(snap.flow.batterySoc).toBe(56);
    expect(snap.top[0]).toMatchObject({ id: "ev", name: "EV Charger", watts: 3965 });
    expect(snap.top[0].share).toBeCloseTo(3965 / (3965 + 120), 5);

    // Full circuit list with live watts + relay merged onto metadata.
    expect(snap.circuits).toHaveLength(2);
    const fridge = snap.circuits.find((c) => c.id === "fridge")!;
    expect(fridge).toMatchObject({ name: "Fridge", watts: 120, isOn: false, alwaysOn: true });
  });

  it("falls back to the circuit id when no metadata is known", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/nj-2338-00fq1/xyz/active_power", "-500");
    const snap = buildSnapshot(s, new Map());
    expect(snap.top[0].name).toBe("xyz");
    expect(snap.circuits[0].id).toBe("xyz");
  });
});
