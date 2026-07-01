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
  /** circuitId → relay state (e.g. CLOSED/OPEN), upper-cased. */
  circuitRelay: Map<string, string>;
  /**
   * circuitId → whether SPAN marks the relay settable (from the Homie
   * `$description`). Authoritative source for whether control is even allowed.
   */
  circuitSettable: Map<string, boolean>;
}

export function emptyLiveState(): LiveState {
  return {
    flow: {},
    bess: {},
    circuitWatts: new Map(),
    circuitRelay: new Map(),
    circuitSettable: new Map(),
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
    },
  );

  const ids = new Set<string>([...state.circuitWatts.keys(), ...meta.keys()]);
  const circuits: Circuit[] = [...ids]
    .map((id) => {
      const m = meta.get(id);
      const relayState = (state.circuitRelay.get(id) ?? m?.relayState ?? "CLOSED").toUpperCase();
      const alwaysOn = m?.alwaysOn ?? false;
      // SPAN-authoritative, default-deny: controllable only when the panel
      // marks the relay settable AND the circuit is not always-on.
      const settable = state.circuitSettable.get(id) ?? false;
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
