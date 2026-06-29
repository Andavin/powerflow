import type {
  BatteryState,
  Circuit,
  CircuitEnergy,
  EnergyPoint,
  EnergySeries,
  FlowSnapshot,
  StatSource,
  TopConsumer,
} from "./types";
import type { TimeWindow } from "./time";

/** A QuestDB row decoded into a column-keyed object. */
export type Row = Record<string, unknown>;

export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function num0(value: unknown): number {
  return num(value) ?? 0;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Normalise a raw `power_flows` row (+ optional battery row) into the signed
 * domain snapshot. Raw convention: negative pv/grid/battery = supplying home.
 *   solarW = -pv (>=0), gridW = -grid (+import), batteryW = -battery (+discharge)
 */
export function toFlowSnapshot(flow: Row, battery?: Row | null): FlowSnapshot {
  const pv = num0(flow.pv);
  const grid = num0(flow.grid);
  const bat = num0(flow.battery);
  const site = num0(flow.site);
  return {
    ts: str(flow.ts) ?? new Date(0).toISOString(),
    homeW: Math.max(0, Math.round(site)),
    solarW: Math.max(0, Math.round(-pv)),
    gridW: Math.round(-grid),
    batteryW: Math.round(-bat),
    batterySoc: battery ? num(battery.soc) : null,
    gridState: battery ? str(battery.grid_state) : null,
    batteryConnected:
      battery && battery.connected !== undefined
        ? Boolean(battery.connected)
        : null,
  };
}

export function toBatteryState(row: Row): BatteryState {
  return {
    ts: str(row.ts) ?? new Date(0).toISOString(),
    soc: num(row.soc),
    soe: num(row.soe),
    gridState: str(row.grid_state),
    connected: row.connected !== undefined ? Boolean(row.connected) : null,
  };
}

export function toCircuit(row: Row): Circuit {
  const relay = (str(row.relay) ?? "").toUpperCase();
  // Per-circuit active_power is negative when the circuit is consuming, so the
  // domain `watts` (positive = drawing power) is the negated raw value.
  const watts = Math.round(-num0(row.active_power));
  return {
    id: str(row.circuit_id) ?? str(row.node_id) ?? "",
    name: str(row.name) ?? "Unknown",
    watts,
    relayState: relay || "UNKNOWN",
    // Treat anything not explicitly OPEN as energised; the panel reports CLOSED
    // for an on circuit.
    isOn: relay !== "OPEN",
    space: num(row.space),
    breakerRating: num(row.breaker_rating),
    sheddable: Boolean(row.sheddable),
    alwaysOn: Boolean(row.always_on),
  };
}

export function toCircuits(rows: Row[]): Circuit[] {
  return rows.map(toCircuit);
}

/**
 * Top current consumers as a share of total home load. Negative/zero draws are
 * ignored. `share` is each circuit's watts over the sum of positive draws.
 */
export function topConsumers(circuits: Circuit[], limit = 5): TopConsumer[] {
  const draws = circuits.filter((c) => c.watts > 0);
  const total = draws.reduce((s, c) => s + c.watts, 0);
  return [...draws]
    .sort((a, b) => b.watts - a.watts)
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      name: c.name,
      watts: c.watts,
      share: total > 0 ? c.watts / total : 0,
    }));
}

/**
 * Duration of each bucket in hours, derived from the bucket start timestamps.
 * The final bucket is clipped to min(window end, now), so the in-progress
 * bucket integrates only the elapsed time rather than a full nominal bucket.
 */
export function bucketDurationsHours(
  startsMs: number[],
  windowEndMs: number,
  nowMs: number,
): number[] {
  const cap = Math.min(windowEndMs, nowMs);
  return startsMs.map((start, i) => {
    const end = i + 1 < startsMs.length ? startsMs[i + 1] : cap;
    return Math.max(0, (end - start) / 3_600_000);
  });
}

const COLUMN_FOR_SOURCE: Record<StatSource, string> = {
  home: "site_w",
  solar: "pv_w",
  grid: "grid_w",
  battery: "battery_w",
};

/** Integrate average watts into kWh: avgW/1000 * hours. */
export function integrate(avgW: number, hours: number): number {
  return (avgW / 1000) * hours;
}

/**
 * Build an energy series for one source from `flowSeriesSql` rows.
 * Energy is the time integral of (sign-normalised) average power per bucket.
 */
export function seriesFromFlowRows(
  rows: Row[],
  window: TimeWindow,
  source: StatSource,
  nowMs: number,
): EnergySeries {
  const starts = rows.map((r) => new Date(str(r.ts)!).getTime());
  const hours = bucketDurationsHours(starts, new Date(window.to).getTime(), nowMs);
  const col = COLUMN_FOR_SOURCE[source];

  let total = 0;
  let charged = 0;
  let discharged = 0;
  let imported = 0;
  let exported = 0;

  const points: EnergyPoint[] = rows.map((r, i) => {
    const h = hours[i];
    const raw = num(r[col]);
    // Sign-normalise: home is positive as-is; the others flip sign so that
    // production/import/discharge read positive.
    const signed = raw === null ? 0 : source === "home" ? raw : -raw;
    const n = num0(r.n);

    const point: EnergyPoint = {
      ts: str(r.ts)!,
      kWh: round3(integrate(signed, h)),
    };

    if (source === "battery") {
      const chg = n > 0 ? integrate(num0(r.batt_charge_sum) / n, h) : 0;
      const dis = n > 0 ? integrate(num0(r.batt_discharge_sum) / n, h) : 0;
      point.chargedKWh = round3(chg);
      point.dischargedKWh = round3(dis);
      charged += chg;
      discharged += dis;
    }
    if (source === "grid") {
      const imp = n > 0 ? integrate(num0(r.grid_import_sum) / n, h) : 0;
      const exp = n > 0 ? integrate(num0(r.grid_export_sum) / n, h) : 0;
      imported += imp;
      exported += exp;
    }
    total += point.kWh;
    return point;
  });

  const totals: EnergySeries["totals"] = { kWh: round3(total) };
  if (source === "battery") {
    totals.chargedKWh = round3(charged);
    totals.dischargedKWh = round3(discharged);
  }
  if (source === "grid") {
    totals.importedKWh = round3(imported);
    totals.exportedKWh = round3(exported);
  }

  return {
    source,
    range: "custom",
    bucket: window.bucket,
    from: window.from,
    to: window.to,
    points,
    totals,
  };
}

/**
 * Per-circuit energy with an approximate source mix.
 * Attribution data is not available per circuit, so each circuit inherits the
 * home-wide source mix for the window (a reasonable, clearly-documented proxy).
 */
export function circuitEnergyFromRows(
  rows: Row[],
  mix: { solar: number; battery: number; grid: number },
): CircuitEnergy[] {
  return rows
    .map((r) => ({
      id: str(r.node_id) ?? "",
      name: str(r.name) ?? "Unknown",
      // A circuit's consumption energy is recorded in exported_wh (energy the
      // panel delivered out to the circuit); imported_wh is backfeed (~0 for
      // loads) — mirrors active_power being negative for a drawing circuit.
      kWh: round3(num0(r.exported_wh) / 1000),
      mix,
    }))
    .filter((c) => c.kWh > 0)
    .sort((a, b) => b.kWh - a.kWh);
}

/**
 * Home-wide source mix (fractions that sum to ~1) from a `flowTotalsSql` row.
 * Only supplying sources count: solar, battery discharge, grid import.
 */
export function homeSourceMix(totalsRow: Row): {
  solar: number;
  battery: number;
  grid: number;
} {
  const n = num0(totalsRow.n);
  if (n <= 0) return { solar: 0, battery: 0, grid: 0 };
  const solar = Math.max(0, -num0(totalsRow.pv_w));
  const battery = num0(totalsRow.batt_discharge_sum) / n;
  const grid = num0(totalsRow.grid_import_sum) / n;
  const sum = solar + battery + grid;
  if (sum <= 0) return { solar: 0, battery: 0, grid: 0 };
  return {
    solar: round3(solar / sum),
    battery: round3(battery / sum),
    grid: round3(grid / sum),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
