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

export const SYSTEM_NODES = new Set([
  "core",
  "lugs-upstream",
  "lugs-downstream",
  "power-flows",
  "pcs",
  "bess",
  "unknown",
]);

export interface LiveState {
  /** Raw power-flows channels: site, grid, pv, battery (same signs as QuestDB). */
  flow: Record<string, number>;
  /** Battery node: soc, soe (numbers), grid_state (string), connected (bool). */
  bess: Record<string, unknown>;
  /** circuitId → consumption watts (positive = drawing power). */
  circuitWatts: Map<string, number>;
}

export function emptyLiveState(): LiveState {
  return { flow: {}, bess: {}, circuitWatts: new Map() };
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
  if (!topic.startsWith(base)) return false;
  const rest = topic.slice(base.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return false;
  const node = rest.slice(0, slash);
  const property = rest.slice(slash + 1);
  // Skip Homie attribute topics ($name, $description, $target, …).
  if (!property || property.startsWith("$") || property.includes("/$")) return false;

  if (node === "power-flows") {
    const v = num(payload);
    if (v === null) return false;
    state.flow[property] = v;
    return true;
  }

  if (node === "bess") {
    if (property === "connected") {
      state.bess.connected = payload === "true" || payload === "1";
    } else if (property === "soc" || property === "soe") {
      const v = num(payload);
      if (v === null) return false;
      state.bess[property] = v;
    } else {
      state.bess[property] = payload;
    }
    return true;
  }

  // Any non-system node carrying active_power is a circuit. active_power is
  // negative for consumption, so negate to positive "drawing" watts.
  if (property === "active_power" && !SYSTEM_NODES.has(node)) {
    const v = num(payload);
    if (v === null) return false;
    state.circuitWatts.set(node, Math.round(-v));
    return true;
  }

  return false;
}

/** Build a client-facing snapshot from current state + cached circuit names. */
export function buildSnapshot(
  state: LiveState,
  names: Map<string, string>,
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
      grid_state: state.bess.grid_state,
      connected: state.bess.connected,
    },
  );

  const circuits: Circuit[] = [...state.circuitWatts.entries()].map(([id, watts]) => ({
    id,
    name: names.get(id) ?? id,
    watts,
    relayState: "CLOSED",
    isOn: true,
    space: null,
    breakerRating: null,
    sheddable: false,
    alwaysOn: false,
  }));

  return { ts, flow, top: topConsumers(circuits, 5) };
}
