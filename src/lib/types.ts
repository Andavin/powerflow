/**
 * Powerflow domain model.
 *
 * Sign conventions (normalised away from QuestDB's raw `power_flows`):
 *   - solarW  >= 0           : instantaneous PV production
 *   - gridW   signed         : + importing from grid, - exporting to grid
 *   - batteryW signed        : + discharging to home, - charging from home
 *   - homeW   >= 0           : household load
 * Invariant: homeW = solarW + gridW + batteryW
 */

export type StatSource = "home" | "solar" | "battery" | "grid";
export type StatRange = "today" | "week" | "month" | "year";
export type Bucket = "hour" | "day" | "month";

export interface FlowSnapshot {
  ts: string;
  homeW: number;
  solarW: number;
  gridW: number;
  batteryW: number;
  batterySoc: number | null;
  gridState: string | null;
  batteryConnected: boolean | null;
}

export interface Circuit {
  id: string;
  name: string;
  watts: number;
  relayState: string;
  isOn: boolean;
  space: number | null;
  breakerRating: number | null;
  sheddable: boolean;
  alwaysOn: boolean;
  /**
   * Whether the app may toggle this circuit's relay. SPAN-authoritative and
   * default-deny: true only when the panel marks the relay settable AND the
   * circuit is not always-on. Never reflects the app's own control flag.
   */
  controllable: boolean;
}

export interface TopConsumer {
  id: string;
  name: string;
  watts: number;
  /** Fraction of total home load, 0..1. */
  share: number;
}

/** A single time bucket in an energy series. */
export interface EnergyPoint {
  /** ISO timestamp marking the start of the bucket. */
  ts: string;
  /** Energy in this bucket, kWh. For battery this is net (see charge/discharge). */
  kWh: number;
  /** Battery only: energy charged (>=0). */
  chargedKWh?: number;
  /** Battery only: energy discharged (>=0). */
  dischargedKWh?: number;
  /** Grid only: energy imported from the grid (>=0). */
  importedKWh?: number;
  /** Grid only: energy exported to the grid (>=0). */
  exportedKWh?: number;
  /** Battery state-of-charge at bucket end, % (when available). */
  soc?: number | null;
}

export interface EnergySeries {
  source: StatSource;
  range: StatRange | "custom";
  bucket: Bucket;
  /** Inclusive ISO start of the window. */
  from: string;
  /** Exclusive ISO end of the window. */
  to: string;
  points: EnergyPoint[];
  /** Aggregate totals over the window, kWh. */
  totals: {
    kWh: number;
    chargedKWh?: number;
    dischargedKWh?: number;
    importedKWh?: number;
    exportedKWh?: number;
  };
}

/** Per-circuit energy with source attribution, for the Stats list. */
export interface CircuitEnergy {
  id: string;
  name: string;
  kWh: number;
  /** Source mix as fractions 0..1 (solar/battery/grid), best-effort. */
  mix: { solar: number; battery: number; grid: number };
}

export interface BatteryState {
  ts: string;
  soc: number | null;
  soe: number | null;
  gridState: string | null;
  connected: boolean | null;
}
