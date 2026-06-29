import type {
  BatteryState,
  Circuit,
  CircuitEnergy,
  EnergyPoint,
  EnergySeries,
  FlowSnapshot,
  StatSource,
} from "./types";
import type { TimeWindow } from "./time";
import type { Repository, SocPoint } from "./repository";
import { topConsumers } from "./transform";

/**
 * Deterministic in-memory repository.
 *
 * Used for tests and offline demos: it synthesises believable energy data from
 * a fixed reference clock so the UI renders identically every run (stable
 * Playwright snapshots) with no database.
 */

// Fixed reference instant: 2026-06-27 20:37 local (America/Denver).
const REF_NOW = Date.UTC(2026, 5, 28, 2, 37, 0);

const CIRCUIT_DEFS: Array<[string, string, number]> = [
  ["ev", "EV Charger", 3965],
  ["bed_w", "West Bedroom Outlets", 396],
  ["garage", "Garage, Attic, Crawl & Network", 294],
  ["air", "Air Handler", 170],
  ["sub", "Subpanel", 143],
  ["erv", "ERV", 126],
  ["living", "Living Room Outlets", 123],
  ["kitchen_e", "East Kitchen Outlets", 88],
  ["fridge", "Fridge", 74],
  ["heatpump", "Heat Pump", 61],
  ["boiler", "Boiler", 33],
  ["pantry", "Pantry Outlets", 12],
  ["master", "Master Bedroom Outlets", 9],
  ["outdoor", "Outdoor Outlets", 0],
  ["powder", "Powder Bathroom Outlets", 0],
  ["septic", "Septic Pump", 0],
];

/** Cheap deterministic hash → [0,1). */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Local hour (America/Denver ≈ UTC-6 in summer) for an instant. */
function localHour(ms: number): number {
  return ((new Date(ms).getUTCHours() - 6 + 24) % 24) + new Date(ms).getUTCMinutes() / 60;
}

/** Solar bell curve in watts for a given local hour (0 at night). */
function solarW(hour: number, scale = 1): number {
  if (hour < 5.5 || hour > 20.5) return 0;
  const x = (hour - 13) / 4.2; // peak ~1pm
  return Math.max(0, Math.round(5200 * Math.exp(-x * x) * scale));
}

function homeW(hour: number, jitter: number): number {
  // Base load + morning/evening humps + EV charging overnight.
  const base = 600 + 250 * Math.sin((hour / 24) * Math.PI * 2 - 1);
  const evening = hour > 17 && hour < 23 ? 1400 : 0;
  const overnightEv = hour < 4 ? 6000 : 0;
  return Math.max(150, Math.round(base + evening + overnightEv + jitter * 300));
}

export class MockRepository implements Repository {
  async getFlow(): Promise<FlowSnapshot> {
    const hour = localHour(REF_NOW);
    const solar = solarW(hour);
    const home = homeW(hour, 0.2);
    // Evening: solar low, battery discharging to cover the load.
    const grid = 7;
    const battery = home - solar - grid;
    return {
      ts: new Date(REF_NOW).toISOString(),
      homeW: home,
      solarW: solar,
      gridW: grid,
      batteryW: battery,
      batterySoc: 56,
      gridState: "ON_GRID",
      batteryConnected: true,
    };
  }

  async getCircuits(): Promise<Circuit[]> {
    return CIRCUIT_DEFS.map(([id, name, watts], i) => ({
      id,
      name,
      watts,
      relayState: "CLOSED",
      isOn: true,
      space: i + 1,
      breakerRating: watts > 1000 ? 50 : 20,
      sheddable: i > 2,
      alwaysOn: id === "fridge",
    })).sort((a, b) => b.watts - a.watts);
  }

  async getBattery(): Promise<BatteryState> {
    return {
      ts: new Date(REF_NOW).toISOString(),
      soc: 56,
      soe: 8.4,
      gridState: "ON_GRID",
      connected: true,
    };
  }

  async getEnergySeries(
    source: StatSource,
    window: TimeWindow,
  ): Promise<EnergySeries> {
    const starts = bucketStarts(window);
    let total = 0;
    let charged = 0;
    let discharged = 0;
    let imported = 0;
    let exported = 0;

    const points: EnergyPoint[] = starts.map((ms, i) => {
      const hour = localHour(ms);
      const hours = window.bucket === "hour" ? 1 : window.bucket === "day" ? 24 : 24 * 30;
      const j = rand(ms / 1e7 + i);
      let kWh = 0;
      const point: EnergyPoint = { ts: new Date(ms).toISOString(), kWh: 0 };

      if (source === "solar") {
        kWh = (solarW(window.bucket === "hour" ? hour : 13, window.bucket === "hour" ? 1 : 0.45) / 1000) * hours;
      } else if (source === "home") {
        kWh = (homeW(window.bucket === "hour" ? hour : 12, j) / 1000) * hours;
      } else if (source === "grid") {
        const imp = (homeW(hour, j) * 0.25 / 1000) * hours;
        const exp = source === "grid" && hour > 11 && hour < 16 ? (800 / 1000) * hours : 0;
        imported += imp;
        exported += exp;
        kWh = imp - exp;
      } else {
        // battery: charge midday, discharge evening/night.
        const chargeW = hour > 9 && hour < 16 ? 1500 + j * 800 : 0;
        const dischargeW = hour < 6 || hour > 18 ? 1800 + j * 700 : 0;
        const chg = (chargeW / 1000) * hours;
        const dis = (dischargeW / 1000) * hours;
        point.chargedKWh = round3(chg);
        point.dischargedKWh = round3(dis);
        charged += chg;
        discharged += dis;
        kWh = dis - chg;
      }
      point.kWh = round3(kWh);
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

  async getSocSeries(window: TimeWindow): Promise<SocPoint[]> {
    return bucketStarts(window).map((ms) => {
      const hour = localHour(ms);
      // Charge through the day, discharge overnight.
      const soc = 40 + 35 * Math.sin(((hour - 6) / 24) * Math.PI * 2);
      return { ts: new Date(ms).toISOString(), soc: Math.round(Math.max(10, Math.min(100, soc))) };
    });
  }

  async getCircuitEnergy(window: TimeWindow): Promise<CircuitEnergy[]> {
    const days = Math.max(1, (new Date(window.to).getTime() - new Date(window.from).getTime()) / 86_400_000);
    const mix = { solar: 0.29, battery: 0.39, grid: 0.32 };
    return CIRCUIT_DEFS.filter(([, , w]) => w > 0)
      .map(([id, name, w]) => ({
        id,
        name,
        kWh: round3((w / 1000) * 24 * Math.min(days, 30) * 0.4),
        mix,
      }))
      .sort((a, b) => b.kWh - a.kWh);
  }

  async getCircuitSeries(circuitId: string, window: TimeWindow): Promise<EnergySeries> {
    const def = CIRCUIT_DEFS.find(([id]) => id === circuitId);
    const watts = def?.[2] ?? 100;
    const starts = bucketStarts(window);
    const hours = window.bucket === "hour" ? 1 : window.bucket === "day" ? 24 : 24 * 30;
    let total = 0;
    const points: EnergyPoint[] = starts.map((ms, i) => {
      const j = rand(ms / 1e7 + i);
      const kWh = round3((watts / 1000) * hours * (0.25 + j * 0.4));
      total += kWh;
      return { ts: new Date(ms).toISOString(), kWh };
    });
    return {
      source: "home",
      range: "custom",
      bucket: window.bucket,
      from: window.from,
      to: window.to,
      points,
      totals: { kWh: round3(total) },
    };
  }
}

/** Synthesize bucket-start instants across a window (nominal stepping). */
function bucketStarts(window: TimeWindow): number[] {
  const from = new Date(window.from).getTime();
  const to = Math.min(new Date(window.to).getTime(), REF_NOW + 60_000);
  const step =
    window.bucket === "hour"
      ? 3_600_000
      : window.bucket === "day"
        ? 86_400_000
        : 30 * 86_400_000;
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out.length ? out : [from];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export const _internals = { topConsumers, REF_NOW };
