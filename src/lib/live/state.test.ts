import { describe, it, expect } from "vitest";
import {
  emptyLiveState,
  applyMessage,
  buildSnapshot,
  isFlowReady,
  relayCommandTopic,
} from "./state";

const PREFIX = "ebus/5";
const DEV = "ab-1234-00xy1";
const apply = (s: ReturnType<typeof emptyLiveState>, topic: string, payload: string) =>
  applyMessage(s, PREFIX, DEV, topic, payload);

// Firmware r202633+: circuits, the BESS and the MID are sibling devices under
// the shared prefix rather than nodes of the panel.
const CIRCUIT = "2e94d24ec65d46b2bafcb86afc4140c4";
const BESS = "ab-1234-00xy1-tg1";
const MID = "ab-1234-00xy1-tg1-mid";

const circuitDesc = (settable: boolean) =>
  JSON.stringify({
    homie: "5.0",
    type: "energy.ebus.device.circuit",
    nodes: {
      switch: {
        properties: {
          relay: { datatype: "enum", settable },
          "relay-controllable": { datatype: "boolean" },
        },
      },
    },
  });

describe("applyMessage — r202633 child devices", () => {
  it("ignores a child's values until its $description declares the type", () => {
    const s = emptyLiveState();
    // Guessing here would let a whole-house lugs reading land in circuitWatts.
    expect(apply(s, `ebus/5/${CIRCUIT}/meter/active-power`, "-450")).toBe(false);
    expect(s.circuitWatts.size).toBe(0);
  });

  it("records circuit power and relay once the device is known", () => {
    const s = emptyLiveState();
    apply(s, `ebus/5/${CIRCUIT}/$description`, circuitDesc(true));
    expect(s.childTypes.get(CIRCUIT)).toBe("circuit");

    expect(apply(s, `ebus/5/${CIRCUIT}/meter/active-power`, "-450.4")).toBe(true);
    expect(s.circuitWatts.get(CIRCUIT)).toBe(450); // negated to a positive draw
    expect(apply(s, `ebus/5/${CIRCUIT}/switch/relay`, "closed")).toBe(true);
    expect(s.circuitRelay.get(CIRCUIT)).toBe("CLOSED");
  });

  it("takes the relay settable flag from the child $description", () => {
    // The regression: the panel's own $description no longer lists circuits, so
    // this is the only source. Without it every breaker is uncontrollable.
    const s = emptyLiveState();
    apply(s, `ebus/5/${CIRCUIT}/$description`, circuitDesc(true));
    expect(s.circuitSettable.get(CIRCUIT)).toBe(true);

    const s2 = emptyLiveState();
    apply(s2, `ebus/5/${CIRCUIT}/$description`, circuitDesc(false));
    expect(s2.circuitSettable.get(CIRCUIT)).toBe(false);
  });

  it("reads battery soc/soe and comms state off the BESS device", () => {
    const s = emptyLiveState();
    apply(s, `ebus/5/${BESS}/$description`, JSON.stringify({ type: "energy.ebus.device.bess" }));
    apply(s, `ebus/5/${BESS}/soc/soc`, "100.0");
    apply(s, `ebus/5/${BESS}/soc/soe`, "13.5");
    apply(s, `ebus/5/${BESS}/status/communication-state`, "OK");
    expect(s.bess.soc).toBe(100);
    expect(s.bess.soe).toBe(13.5);
    expect(s.bess.communication_state).toBe("OK");
  });

  it("reads grid state off the MID device", () => {
    const s = emptyLiveState();
    apply(s, `ebus/5/${MID}/$description`, JSON.stringify({ type: "energy.ebus.device.mid" }));
    apply(s, `ebus/5/${MID}/grid/islanding-state`, "ON_GRID");
    expect(s.bess.islanding_state).toBe("ON_GRID");
  });

  it("ignores command sub-topics echoed back on the wildcard", () => {
    const s = emptyLiveState();
    apply(s, `ebus/5/${CIRCUIT}/$description`, circuitDesc(true));
    expect(apply(s, `ebus/5/${CIRCUIT}/switch/relay/set`, "OPEN")).toBe(false);
    expect(apply(s, `ebus/5/${CIRCUIT}/switch/$name`, "switch")).toBe(false);
  });
});

describe("relayCommandTopic", () => {
  it("uses the child-device switch topic for an r202633 circuit", () => {
    // Publishing the pre-OTA topic on new firmware fails silently: the broker
    // accepts it and the breaker never moves.
    const s = emptyLiveState();
    apply(s, `ebus/5/${CIRCUIT}/$description`, circuitDesc(true));
    expect(relayCommandTopic(s, PREFIX, DEV, CIRCUIT)).toBe(
      `ebus/5/${CIRCUIT}/switch/relay/set`,
    );
  });

  it("falls back to the panel-node topic on older firmware", () => {
    const s = emptyLiveState();
    expect(relayCommandTopic(s, PREFIX, DEV, "circuit-3")).toBe(
      `ebus/5/${DEV}/circuit-3/relay/set`,
    );
  });
});

describe("buildSnapshot — controllability", () => {
  const meta = new Map();

  it("is controllable when settable and the panel says so live", () => {
    const s = emptyLiveState();
    apply(s, `ebus/5/${CIRCUIT}/$description`, circuitDesc(true));
    apply(s, `ebus/5/${CIRCUIT}/switch/relay-controllable`, "true");
    apply(s, `ebus/5/${CIRCUIT}/switch/relay`, "CLOSED");
    const snap = buildSnapshot(s, meta);
    expect(snap.circuits.find((c) => c.id === CIRCUIT)?.controllable).toBe(true);
  });

  it("is not controllable when the panel revokes it at runtime", () => {
    const s = emptyLiveState();
    apply(s, `ebus/5/${CIRCUIT}/$description`, circuitDesc(true));
    apply(s, `ebus/5/${CIRCUIT}/switch/relay-controllable`, "false");
    const snap = buildSnapshot(s, meta);
    expect(snap.circuits.find((c) => c.id === CIRCUIT)?.controllable).toBe(false);
  });

  it("stays default-deny for a circuit that has published nothing", () => {
    const s = emptyLiveState();
    s.circuitWatts.set("unknown-circuit", 10);
    const snap = buildSnapshot(s, meta);
    expect(snap.circuits.find((c) => c.id === "unknown-circuit")?.controllable).toBe(false);
  });
});

describe("applyMessage — power-flows", () => {
  it("captures the four flow channels with raw signs", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/ab-1234-00xy1/power-flows/site", "5274.4")).toBe(true);
    apply(s, "ebus/5/ab-1234-00xy1/power-flows/grid", "-7");
    apply(s, "ebus/5/ab-1234-00xy1/power-flows/pv", "-2192.4");
    apply(s, "ebus/5/ab-1234-00xy1/power-flows/battery", "-3075");
    expect(s.flow).toEqual({ site: 5274.4, grid: -7, pv: -2192.4, battery: -3075 });
    expect(isFlowReady(s)).toBe(true);
  });

  it("is not ready until all four channels are present", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/ab-1234-00xy1/power-flows/site", "100");
    expect(isFlowReady(s)).toBe(false);
  });
});

describe("applyMessage — bess", () => {
  it("coerces soc to number and connected to boolean", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/ab-1234-00xy1/bess/soc", "56.2");
    apply(s, "ebus/5/ab-1234-00xy1/bess/connected", "false");
    expect(s.bess.soc).toBe(56.2);
    // "false" must become boolean false, not truthy string.
    expect(s.bess.connected).toBe(false);
  });

  it("normalises hyphenated property names to underscores", () => {
    const s = emptyLiveState();
    // The panel publishes `grid-state`, not `grid_state`.
    apply(s, "ebus/5/ab-1234-00xy1/bess/grid-state", "ON_GRID");
    expect(s.bess.grid_state).toBe("ON_GRID");
  });
});

describe("applyMessage — circuits", () => {
  it("negates a circuit's active-power into positive draw (hyphenated topic)", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/ab-1234-00xy1/abc123/active-power", "-3965.5");
    expect(s.circuitWatts.get("abc123")).toBe(3966);
  });

  it("ignores active-power from system nodes (e.g. lugs)", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/ab-1234-00xy1/lugs-upstream/active-power", "-50")).toBe(false);
    expect(s.circuitWatts.size).toBe(0);
  });

  it("captures circuit relay state", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/ab-1234-00xy1/abc123/relay", "open")).toBe(true);
    expect(s.circuitRelay.get("abc123")).toBe("OPEN");
  });

  it("ignores unrelated circuit properties", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/ab-1234-00xy1/abc123/breaker_rating", "20")).toBe(false);
  });
});

describe("applyMessage — rejects", () => {
  it("ignores other devices and Homie attributes", () => {
    const s = emptyLiveState();
    expect(apply(s, "ebus/5/other-device/power-flows/site", "1")).toBe(false);
    expect(apply(s, "ebus/5/ab-1234-00xy1/power-flows/$name", "Power Flows")).toBe(false);
    expect(apply(s, "ebus/5/ab-1234-00xy1/abc123/active_power/$target", "x")).toBe(false);
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
    controllable: false,
    ...over,
  });

  it("normalises flow signs, ranks top consumers, and lists circuits", () => {
    const s = emptyLiveState();
    apply(s, "ebus/5/ab-1234-00xy1/power-flows/site", "5274");
    apply(s, "ebus/5/ab-1234-00xy1/power-flows/grid", "-7");
    apply(s, "ebus/5/ab-1234-00xy1/power-flows/pv", "-2192");
    apply(s, "ebus/5/ab-1234-00xy1/power-flows/battery", "-3075");
    apply(s, "ebus/5/ab-1234-00xy1/bess/soc", "56");
    apply(s, "ebus/5/ab-1234-00xy1/ev/active-power", "-3965");
    apply(s, "ebus/5/ab-1234-00xy1/fridge/active-power", "-120");
    apply(s, "ebus/5/ab-1234-00xy1/fridge/relay", "OPEN");

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
    apply(s, "ebus/5/ab-1234-00xy1/xyz/active_power", "-500");
    const snap = buildSnapshot(s, new Map());
    expect(snap.top[0].name).toBe("xyz");
    expect(snap.circuits[0].id).toBe("xyz");
  });

  it("derives controllable default-deny from SPAN settable + always-on", () => {
    const s = emptyLiveState();
    // Flow so the snapshot is well-formed.
    for (const [ch, v] of [["site", "1"], ["grid", "1"], ["pv", "0"], ["battery", "0"]]) {
      apply(s, `ebus/5/ab-1234-00xy1/power-flows/${ch}`, v);
    }
    apply(s, "ebus/5/ab-1234-00xy1/ev/active-power", "-10");
    apply(s, "ebus/5/ab-1234-00xy1/fridge/active-power", "-10");
    apply(s, "ebus/5/ab-1234-00xy1/unknownc/active-power", "-10");
    // SPAN description: ev settable+not-always-on, fridge settable but always-on.
    const desc = JSON.stringify({
      nodes: {
        core: { properties: { relay: { settable: false } } },
        ev: { properties: { relay: { settable: true } } },
        fridge: { properties: { relay: { settable: true } } },
      },
    });
    expect(apply(s, "ebus/5/ab-1234-00xy1/$description", desc)).toBe(true);

    const meta = new Map([
      ["ev", circuitMeta({ id: "ev", name: "EV" })],
      ["fridge", circuitMeta({ id: "fridge", name: "Fridge", alwaysOn: true })],
      ["unknownc", circuitMeta({ id: "unknownc", name: "Mystery" })],
    ]);
    const snap = buildSnapshot(s, meta, Date.parse("2026-06-28T02:10:00Z"));
    const by = (id: string) => snap.circuits.find((c) => c.id === id)!;
    expect(by("ev").controllable).toBe(true); // settable + not always-on
    expect(by("fridge").controllable).toBe(false); // always-on wins
    expect(by("unknownc").controllable).toBe(false); // no settable info → deny
  });
});
