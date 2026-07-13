import type {
  Circuit,
  CircuitEnergy,
  EnergyPoint,
  EnergySeries,
  FlowSnapshot,
  StatSource,
  TopConsumer,
} from "./types";
import type { TimeWindow } from "./time";
import type { Row } from "./questdb";

// Re-exported for existing importers; the canonical definition lives in questdb.ts
// so the low-level client no longer depends on this domain module.
export type { Row };

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

/** Like str() but throws on null — for required columns such as a bucket ts. */
function reqStr(value: unknown, field: string): string {
  const s = str(value);
  if (s === null) throw new Error(`QuestDB row missing required field: ${field}`);
  return s;
}

/**
 * Tesla Powerwall 3 usable energy capacity (kWh). The SPAN app shows the
 * battery percentage as state-of-energy against this usable figure, which is
 * why its number is higher than the panel's raw `bess/soc` field: that `soc`
 * is a non-linear cell metric measured against the larger full pack (~16 kWh
 * at low charge), whereas soe/usable matches SPAN at both ends of the range
 * (100% at full, and e.g. 3.0 kWh / 13.5 = 22% — what SPAN displays).
 */
export const BATTERY_USABLE_KWH = 13.5;

/**
 * Battery percentage the SPAN way: state-of-energy over usable capacity.
 * Falls back to the raw `soc` field when soe is unavailable.
 */
export function batteryPercent(
  soe: number | null,
  socFallback: number | null,
): number | null {
  if (soe !== null && BATTERY_USABLE_KWH > 0) {
    return Math.max(0, Math.min(100, Math.round((soe / BATTERY_USABLE_KWH) * 100)));
  }
  return socFallback !== null ? Math.round(socFallback) : null;
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
    batterySoc: batteryPercent(
      battery ? num(battery.soe) : null,
      battery ? num(battery.soc) : null,
    ),
    gridState: battery ? str(battery.grid_state) : null,
    batteryConnected:
      battery && battery.connected !== undefined
        ? Boolean(battery.connected)
        : null,
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
    // Default-deny: QuestDB metadata can't confirm the relay is settable, so
    // the authoritative value is set from the live MQTT $description in
    // buildSnapshot. Absent that, control stays disabled.
    controllable: false,
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
 * Assemble the EnergySeries envelope from accumulated per-bucket sums. Shared by
 * the live transform and the mock repository so the totals shape (per-source
 * charged/discharged or imported/exported) lives in one place.
 */
export function assembleEnergySeries(
  source: StatSource,
  window: TimeWindow,
  points: EnergyPoint[],
  sums: { total: number; charged?: number; discharged?: number; imported?: number; exported?: number },
): EnergySeries {
  const totals: EnergySeries["totals"] = { kWh: round3(sums.total) };
  if (source === "battery") {
    totals.chargedKWh = round3(sums.charged ?? 0);
    totals.dischargedKWh = round3(sums.discharged ?? 0);
  }
  if (source === "grid") {
    totals.importedKWh = round3(sums.imported ?? 0);
    totals.exportedKWh = round3(sums.exported ?? 0);
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
 * Build an energy series for one source from `flowSeriesSql` rows.
 * Energy is the time integral of (sign-normalised) average power per bucket.
 */
export function seriesFromFlowRows(
  rows: Row[],
  window: TimeWindow,
  source: StatSource,
  nowMs: number,
): EnergySeries {
  const starts = rows.map((r) => new Date(reqStr(r.ts, "ts")).getTime());
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
      ts: reqStr(r.ts, "ts"),
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
      point.importedKWh = round3(imp);
      point.exportedKWh = round3(exp);
      imported += imp;
      exported += exp;
    }
    total += point.kWh;
    return point;
  });

  return assembleEnergySeries(source, window, points, { total, charged, discharged, imported, exported });
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
 * Energy series for a single circuit from `circuitSeriesSql` rows. power_usage
 * already stores energy per period (Wh), so each bucket is just the summed Wh
 * (no average-power integration). Reuses EnergySeries with a neutral "home"
 * source for charting.
 */
export function circuitSeriesFromRows(rows: Row[], window: TimeWindow): EnergySeries {
  let total = 0;
  const points: EnergyPoint[] = rows.map((r) => {
    const kWh = round3(num0(r.wh) / 1000);
    total += kWh;
    return { ts: reqStr(r.ts, "ts"), kWh };
  });
  return assembleEnergySeries("home", window, points, { total });
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

/** Round to 3 decimals (Wh→kWh values carry no meaningful precision beyond it). */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
