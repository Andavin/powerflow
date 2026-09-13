import type { FlowSnapshot } from "../types";
import type { FreshnessResult } from "../freshness";
import type { NotifyEvent } from "./events";

/**
 * Decides *when* to notify. Pure: every function here is
 * (state, observation, clock) → events, mutating `state` in place so the
 * runner can keep one object across observations while tests drive it with
 * hand-made inputs and fake time.
 *
 * Everything is edge-triggered. Grid and battery prime themselves from the
 * first observation, so a server restart mid-outage does not re-announce what
 * is already true. Staleness deliberately does not: the freshness result
 * carries the real age, so a restart during a long collector outage announces
 * it once more after `staleAfterMs` — the operator may well have restarted
 * the stack expecting that to fix it.
 */

export interface WatchOptions {
  /** Battery SOC (%) below which BATTERY_LOW fires; 0 disables. */
  batteryLowPercent: number;
  /** How long data must be stale before DATA_STALE fires. */
  staleAfterMs: number;
}

/** SOC must climb this far above the threshold before BATTERY_LOW can fire again. */
const BATTERY_REARM_MARGIN = 5;

export interface WatchState {
  /** Last recognised grid state; null until one has been seen. */
  gridOffline: boolean | null;
  /** Whether BATTERY_LOW may fire on the next crossing; null until SOC has been seen. */
  batteryArmed: boolean | null;
  /** When the current stale episode was first seen (for results with no age of their own). */
  staleSince: number | null;
  staleAnnounced: boolean;
}

export function newWatchState(): WatchState {
  return { gridOffline: null, batteryArmed: null, staleSince: null, staleAnnounced: false };
}

/**
 * SPAN's grid state strings, as far as they are known: `PANEL_ON_GRID` /
 * `PANEL_OFF_GRID` (run config) and `DSM_GRID_UP` / `DSM_GRID_DOWN`. Only an
 * explicitly recognised value counts; anything else is null so a firmware
 * surprise can't raise a false "grid down".
 */
export function isOffGrid(gridState: string | null): boolean | null {
  if (!gridState) return null;
  const s = gridState.toUpperCase();
  if (s.includes("OFF_GRID") || s.includes("GRID_DOWN")) return true;
  if (s.includes("ON_GRID") || s.includes("GRID_UP")) return false;
  return null;
}

export function observeSnapshot(
  state: WatchState,
  snapshot: Pick<FlowSnapshot, "gridState" | "batterySoc">,
  opts: WatchOptions,
): NotifyEvent[] {
  const events: NotifyEvent[] = [];

  const off = isOffGrid(snapshot.gridState);
  if (off !== null) {
    if (state.gridOffline !== null && off !== state.gridOffline) {
      events.push({ kind: off ? "GRID_DOWN" : "GRID_RESTORED" });
    }
    state.gridOffline = off;
  }

  const soc = snapshot.batterySoc;
  const threshold = opts.batteryLowPercent;
  if (threshold > 0 && soc !== null) {
    if (state.batteryArmed === null) {
      state.batteryArmed = soc >= threshold;
    } else if (state.batteryArmed && soc < threshold) {
      events.push({ kind: "BATTERY_LOW", soc });
      state.batteryArmed = false;
    } else if (!state.batteryArmed && soc >= threshold + BATTERY_REARM_MARGIN) {
      state.batteryArmed = true;
    }
  }

  return events;
}

export function observeFreshness(
  state: WatchState,
  result: FreshnessResult,
  now: number,
  opts: WatchOptions,
): NotifyEvent[] {
  if (!result.stale) {
    const events: NotifyEvent[] = state.staleAnnounced ? [{ kind: "DATA_RESUMED" }] : [];
    state.staleSince = null;
    state.staleAnnounced = false;
    return events;
  }

  state.staleSince ??= now;
  if (state.staleAnnounced) return [];

  // The probe reports the real age of the data when it can; when it can't (the
  // database itself is unreachable) time the episode from the first failure.
  const ageSeconds = result.ageSeconds ?? Math.round((now - state.staleSince) / 1000);
  if (ageSeconds * 1000 < opts.staleAfterMs) return [];

  state.staleAnnounced = true;
  return [{ kind: "DATA_STALE", ageSeconds, ...(result.table ? { table: result.table } : {}) }];
}
