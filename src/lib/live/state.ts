import { num, toFlowSnapshot, topConsumers } from "../transform";
import type { Circuit } from "../types";
import type { LiveSnapshot } from "./types";

/**
 * Pure state for the MQTT live feed and the logic to fold Homie messages into
 * it. No I/O here, so the parsing is exhaustively unit-tested.
 *
 * Homie value topics look like `${prefix}/${device}/${node}/${property}` with
 * the raw value as the (string) payload. System nodes map to panel tables; any
 * other node is a circuit (matching the collector's routing).
 */

/**
 * Nodes of the panel device itself. Anything else under the panel is treated as
 * a circuit, so this list must stay complete: the panel's `status` node carries
 * a `relay` property for the *main* relay, and omitting it puts the whole-panel
 * disconnect into the per-circuit list as a breaker named "status".
 *
 * The first six are the pre-r202633 layout; the rest are the nodes that
 * firmware exposes on the panel now that circuits have moved to their own
 * devices.
 */
export const SYSTEM_NODES = new Set([
  "core",
  "lugs-upstream",
  "lugs-downstream",
  "power-flows",
  "pcs",
  "bess",
  "unknown",
  // r202633+ panel nodes
  "info",
  "door",
  "status",
  "meter",
  "breaker",
  "shed",
  "shed-forecast",
]);

export interface LiveState {
  /** Raw power-flows channels: site, grid, pv, battery (same signs as QuestDB). */
  flow: Record<string, number>;
  /** Battery node: soc, soe (numbers), grid_state (string), connected (bool). */
  bess: Record<string, unknown>;
  /** circuitId → consumption watts (positive = drawing power). */
  circuitWatts: Map<string, number>;
  /** circuitId → relay state (e.g. CLOSED/OPEN), upper-cased. */
  circuitRelay: Map<string, string>;
  /**
   * circuitId → whether SPAN marks the relay settable (from the Homie
   * `$description`). Authoritative source for whether control is even allowed.
   */
  circuitSettable: Map<string, boolean>;
  /**
   * circuitId → the panel's live `switch/relay-controllable` value. Where
   * `settable` is a static schema fact, this is the panel's runtime answer to
   * "may this relay be operated right now", so control requires both.
   */
  circuitControllable: Map<string, boolean>;
  /**
   * Child device id → its declared Homie type ("circuit", "lugs", "bess",
   * "mid"). Firmware r202633+ publishes each of these as its own device, and
   * the type is what says which state a message belongs in — mirroring the
   * collector's routing rather than guessing from the device id's shape.
   */
  childTypes: Map<string, string>;
}

export function emptyLiveState(): LiveState {
  return {
    flow: {},
    bess: {},
    circuitWatts: new Map(),
    circuitRelay: new Map(),
    circuitSettable: new Map(),
    circuitControllable: new Map(),
    childTypes: new Map(),
  };
}

/**
 * Fold the panel's Homie `$description` (a JSON document) into state, recording
 * which circuit relays SPAN marks settable. System nodes (core, bess, …) are
 * ignored. Returns true if anything was recorded.
 */
export function applyDescription(state: LiveState, payload: string): boolean {
  let doc: unknown;
  try {
    doc = JSON.parse(payload);
  } catch {
    return false;
  }
  const nodes = (doc as { nodes?: Record<string, unknown> })?.nodes;
  if (!nodes || typeof nodes !== "object") return false;
  let changed = false;
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (SYSTEM_NODES.has(nodeId)) continue;
    const relay = (node as { properties?: Record<string, { settable?: unknown }> })
      ?.properties?.relay;
    if (!relay) continue;
    state.circuitSettable.set(nodeId, relay.settable === true);
    changed = true;
  }
  return changed;
}

/** Vendor namespace on every Homie device type, e.g. energy.ebus.device.circuit. */
const CHILD_TYPE_PREFIX = "energy.ebus.device.";

/**
 * Fold a *child* device's `$description` into state (firmware r202633+).
 *
 * Records the device's declared type, which is what routes its later messages,
 * and for a circuit records whether SPAN marks its relay settable. Under this
 * firmware the panel's own `$description` no longer lists circuits at all, so
 * this is the only place `circuitSettable` can come from — without it every
 * breaker reads as uncontrollable and the control UI is dead.
 */
export function applyChildDescription(
  state: LiveState,
  deviceId: string,
  payload: string,
): boolean {
  let doc: unknown;
  try {
    doc = JSON.parse(payload);
  } catch {
    return false;
  }
  const d = doc as {
    type?: unknown;
    nodes?: Record<string, { properties?: Record<string, { settable?: unknown }> }>;
  };
  if (typeof d?.type !== "string" || !d.type.startsWith(CHILD_TYPE_PREFIX)) return false;

  const type = d.type.slice(CHILD_TYPE_PREFIX.length);
  state.childTypes.set(deviceId, type);

  if (type === "circuit") {
    const relay = d.nodes?.switch?.properties?.relay;
    state.circuitSettable.set(deviceId, relay?.settable === true);
  }
  return true;
}

/**
 * Fold one child-device message into state. `rest` is the topic with the shared
 * prefix stripped, i.e. `<deviceId>/<node>/<property>`.
 *
 * Messages arriving before that device's `$description` are ignored rather than
 * guessed at: an unknown type could put a whole-house lugs reading into the
 * per-circuit map. Descriptions are retained, so they arrive first on connect.
 */
export function applyChildMessage(state: LiveState, rest: string, payload: string): boolean {
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0) return false;
  const deviceId = rest.slice(0, firstSlash);
  const sub = rest.slice(firstSlash + 1);

  if (sub === "$description") return applyChildDescription(state, deviceId, payload);
  if (sub.startsWith("$")) return false;

  const slash = sub.indexOf("/");
  if (slash < 0) return false;
  const node = sub.slice(0, slash);
  const property = sub.slice(slash + 1);
  if (!property || property.startsWith("$") || property.includes("/")) return false;

  const type = state.childTypes.get(deviceId);
  if (!type) return false;

  if (type === "circuit") {
    if (node === "meter" && property === "active-power") {
      const v = num(payload);
      if (v === null) return false;
      // active-power is negative for consumption; negate to a positive draw.
      state.circuitWatts.set(deviceId, Math.round(-v));
      return true;
    }
    if (node === "switch" && property === "relay") {
      state.circuitRelay.set(deviceId, payload.toUpperCase());
      return true;
    }
    if (node === "switch" && property === "relay-controllable") {
      state.circuitControllable.set(deviceId, payload === "true" || payload === "1");
      return true;
    }
    return false;
  }

  if (type === "bess") {
    if (node === "soc" && (property === "soc" || property === "soe")) {
      const v = num(payload);
      if (v === null) return false;
      state.bess[property] = v;
      return true;
    }
    if (node === "status" && property === "communication-state") {
      state.bess.communication_state = payload;
      return true;
    }
    return false;
  }

  if (type === "mid" && node === "grid" && property === "islanding-state") {
    state.bess.islanding_state = payload;
    return true;
  }

  return false;
}

/**
 * The Homie topic that operates a circuit's relay.
 *
 * r202633+ circuits are their own device with a `switch` node
 * (`<prefix>/<circuit>/switch/relay/set`); before that they were nodes of the
 * panel (`<prefix>/<panel>/<circuit>/relay/set`). We know which because a
 * circuit only lands in `childTypes` via its own `$description`. Getting this
 * wrong is silent — the broker accepts a publish to a topic nothing is
 * listening on and the breaker simply never moves.
 */
export function relayCommandTopic(
  state: LiveState,
  prefix: string,
  deviceId: string,
  circuitId: string,
): string {
  return state.childTypes.get(circuitId) === "circuit"
    ? `${prefix}/${circuitId}/switch/relay/set`
    : `${prefix}/${deviceId}/${circuitId}/relay/set`;
}

/** True once all four flow channels have been seen (avoids a partial frame). */
export function isFlowReady(state: LiveState): boolean {
  const f = state.flow;
  return ["site", "grid", "pv", "battery"].every((k) => k in f);
}

/**
 * Fold one MQTT message into the state. Returns true if the state changed.
 * `topic` must be the full Homie topic; `payload` the decoded string value.
 */
export function applyMessage(
  state: LiveState,
  prefix: string,
  deviceId: string,
  topic: string,
  payload: string,
): boolean {
  const base = `${prefix}/${deviceId}/`;
  if (!topic.startsWith(base)) {
    // Firmware r202633+ publishes circuits, the lugs meters, the BESS and the
    // MID as sibling devices under the same prefix rather than as nodes of the
    // panel. Those are the only other topics we subscribe to.
    const shared = `${prefix}/`;
    if (!topic.startsWith(shared)) return false;
    return applyChildMessage(state, topic.slice(shared.length), payload);
  }
  const rest = topic.slice(base.length);
  // The device-level description carries per-circuit settable flags.
  if (rest === "$description") return applyDescription(state, payload);
  const slash = rest.indexOf("/");
  if (slash < 0) return false;
  const node = rest.slice(0, slash);
  const property = rest.slice(slash + 1);
  // Skip Homie attribute topics ($name, $description, $target, …).
  if (!property || property.startsWith("$") || property.includes("/$")) return false;
  // The panel publishes property names hyphenated (active-power, grid-state);
  // normalise to the underscore keys the rest of the app uses.
  const prop = property.replace(/-/g, "_");

  if (node === "power-flows") {
    const v = num(payload);
    if (v === null) return false;
    state.flow[prop] = v;
    return true;
  }

  if (node === "bess") {
    if (prop === "connected") {
      state.bess.connected = payload === "true" || payload === "1";
    } else if (prop === "soc" || prop === "soe") {
      const v = num(payload);
      if (v === null) return false;
      state.bess[prop] = v;
    } else {
      state.bess[prop] = payload;
    }
    return true;
  }

  // Non-system nodes are circuits.
  if (!SYSTEM_NODES.has(node)) {
    if (prop === "active_power") {
      const v = num(payload);
      if (v === null) return false;
      // active_power is negative for consumption; negate to positive draw.
      state.circuitWatts.set(node, Math.round(-v));
      return true;
    }
    if (prop === "relay") {
      state.circuitRelay.set(node, payload.toUpperCase());
      return true;
    }
  }

  return false;
}

/**
 * Build a client-facing snapshot from current state + circuit metadata
 * (id → Circuit, looked up from QuestDB). Live MQTT values (watts, relay)
 * override the metadata; metadata supplies names, panel slot, breaker, flags.
 */
export function buildSnapshot(
  state: LiveState,
  meta: Map<string, Circuit>,
  nowMs: number = Date.now(),
): LiveSnapshot {
  const ts = new Date(nowMs).toISOString();
  const flow = toFlowSnapshot(
    {
      ts,
      site: state.flow.site ?? 0,
      grid: state.flow.grid ?? 0,
      pv: state.flow.pv ?? 0,
      battery: state.flow.battery ?? 0,
    },
    {
      soc: state.bess.soc,
      soe: state.bess.soe,
      grid_state: state.bess.grid_state,
      connected: state.bess.connected,
      // r202633+ replacements — transform prefers these when present.
      communication_state: state.bess.communication_state,
      islanding_state: state.bess.islanding_state,
    },
  );

  // Every circuit we know of from any source. Keying only off circuitWatts
  // would drop a circuit that has published its relay state but not yet a
  // power reading — it would silently vanish from the list rather than show
  // as idle.
  const ids = new Set<string>([
    ...state.circuitWatts.keys(),
    ...state.circuitRelay.keys(),
    ...state.circuitSettable.keys(),
    ...meta.keys(),
  ]);
  const circuits: Circuit[] = [...ids]
    .map((id) => {
      const m = meta.get(id);
      const relayState = (state.circuitRelay.get(id) ?? m?.relayState ?? "CLOSED").toUpperCase();
      const alwaysOn = m?.alwaysOn ?? false;
      // SPAN-authoritative, default-deny: controllable only when the panel
      // marks the relay settable AND the circuit is not always-on.
      //
      // r202633+ adds a live `switch/relay-controllable` on top of the static
      // `settable` schema flag — the panel's runtime answer to "may this be
      // operated right now". Require both when we have both; a circuit that
      // has published neither stays uncontrollable.
      const liveControllable = state.circuitControllable.get(id);
      const settable =
        (state.circuitSettable.get(id) ?? false) && (liveControllable ?? true);
      return {
        id,
        name: m?.name ?? id,
        watts: state.circuitWatts.get(id) ?? m?.watts ?? 0,
        relayState,
        isOn: relayState !== "OPEN",
        space: m?.space ?? null,
        breakerRating: m?.breakerRating ?? null,
        sheddable: m?.sheddable ?? false,
        alwaysOn,
        controllable: settable && !alwaysOn,
      };
    })
    .sort((a, b) => b.watts - a.watts);

  return { ts, flow, top: topConsumers(circuits, 5), circuits };
}
