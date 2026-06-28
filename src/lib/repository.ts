import type {
  BatteryState,
  Circuit,
  CircuitEnergy,
  EnergySeries,
  FlowSnapshot,
  StatSource,
} from "./types";
import type { TimeWindow } from "./time";
import type { QuestDbClient } from "./questdb";
import {
  circuitEnergySql,
  circuitsLatestSql,
  flowSeriesSql,
  flowTotalsSql,
  latestBatterySql,
  latestDeviceSql,
  latestFlowSql,
  socSeriesSql,
} from "./sql";
import {
  circuitEnergyFromRows,
  homeSourceMix,
  num,
  seriesFromFlowRows,
  toBatteryState,
  toCircuits,
  toFlowSnapshot,
} from "./transform";

export interface SocPoint {
  ts: string;
  soc: number | null;
}

/** Read model the API routes depend on. Mockable for tests / demo. */
export interface Repository {
  getFlow(): Promise<FlowSnapshot>;
  getCircuits(): Promise<Circuit[]>;
  getBattery(): Promise<BatteryState>;
  getEnergySeries(source: StatSource, window: TimeWindow): Promise<EnergySeries>;
  getSocSeries(window: TimeWindow): Promise<SocPoint[]>;
  getCircuitEnergy(window: TimeWindow): Promise<CircuitEnergy[]>;
}

export interface QuestDbRepositoryOptions {
  deviceId?: string | null;
  timezone: string;
  now?: () => number;
}

export class QuestDbRepository implements Repository {
  private readonly client: QuestDbClient;
  private readonly timezone: string;
  private readonly now: () => number;
  private configuredDevice: string | null;
  private devicePromise: Promise<string | null> | null = null;

  constructor(client: QuestDbClient, opts: QuestDbRepositoryOptions) {
    this.client = client;
    this.timezone = opts.timezone;
    this.now = opts.now ?? Date.now;
    this.configuredDevice = opts.deviceId ?? null;
  }

  /** Resolve and cache the device id (configured, else most-recent). */
  private device(): Promise<string | null> {
    if (this.configuredDevice) return Promise.resolve(this.configuredDevice);
    if (!this.devicePromise) {
      this.devicePromise = this.client.query(latestDeviceSql()).then((rows) => {
        const id = rows[0]?.device_id;
        return id ? String(id) : null;
      });
    }
    return this.devicePromise;
  }

  async getFlow(): Promise<FlowSnapshot> {
    const device = await this.device();
    const [flowRows, batteryRows] = await Promise.all([
      this.client.query(latestFlowSql(device)),
      this.client.query(latestBatterySql(device)),
    ]);
    if (!flowRows[0]) {
      throw new Error("No power_flows data available");
    }
    return toFlowSnapshot(flowRows[0], batteryRows[0] ?? null);
  }

  async getCircuits(): Promise<Circuit[]> {
    const device = await this.device();
    const rows = await this.client.query(circuitsLatestSql(device));
    return toCircuits(rows);
  }

  async getBattery(): Promise<BatteryState> {
    const device = await this.device();
    const rows = await this.client.query(latestBatterySql(device));
    if (!rows[0]) {
      return { ts: new Date(this.now()).toISOString(), soc: null, soe: null, gridState: null, connected: null };
    }
    return toBatteryState(rows[0]);
  }

  async getEnergySeries(
    source: StatSource,
    window: TimeWindow,
  ): Promise<EnergySeries> {
    const device = await this.device();
    const rows = await this.client.query(flowSeriesSql(window, this.timezone, device));
    return seriesFromFlowRows(rows, window, source, this.now());
  }

  async getSocSeries(window: TimeWindow): Promise<SocPoint[]> {
    const device = await this.device();
    const rows = await this.client.query(socSeriesSql(window, this.timezone, device));
    return rows.map((r) => ({ ts: String(r.ts), soc: num(r.soc) }));
  }

  async getCircuitEnergy(window: TimeWindow): Promise<CircuitEnergy[]> {
    const device = await this.device();
    const [circuitRows, totalsRows] = await Promise.all([
      this.client.query(circuitEnergySql(window, device)),
      this.client.query(flowTotalsSql(window, device)),
    ]);
    const mix = totalsRows[0]
      ? homeSourceMix(totalsRows[0])
      : { solar: 0, battery: 0, grid: 0 };
    return circuitEnergyFromRows(circuitRows, mix);
  }
}
