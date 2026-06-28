import { describe, it, expect } from "vitest";
import { QuestDbRepository } from "./repository";
import { MockRepository } from "./mock";
import type { QuestDbClient } from "./questdb";
import type { Row } from "./transform";
import type { TimeWindow } from "./time";

const TZ = "America/Denver";
const WINDOW: TimeWindow = {
  from: "2026-06-27T06:00:00.000Z",
  to: "2026-06-28T06:00:00.000Z",
  bucket: "hour",
};

/** A client that returns canned rows based on a matcher against the SQL. */
function fakeClient(handlers: Array<[RegExp, Row[]]>): {
  client: QuestDbClient;
  queries: string[];
} {
  const queries: string[] = [];
  const client: QuestDbClient = {
    async query(sql: string) {
      queries.push(sql);
      for (const [re, rows] of handlers) if (re.test(sql)) return rows;
      return [];
    },
    async queryRaw() {
      throw new Error("not used");
    },
  };
  return { client, queries };
}

describe("QuestDbRepository", () => {
  it("resolves device once and reuses it", async () => {
    const { client, queries } = fakeClient([
      [/LATEST ON ts PARTITION BY device_id/, [{ device_id: "dev-x" }]],
    ]);
    const repo = new QuestDbRepository(client, { timezone: TZ });
    await repo.getFlow();
    await repo.getFlow();
    const deviceLookups = queries.filter((q) => q.includes("FROM power_flows LATEST ON"));
    expect(deviceLookups).toHaveLength(1);
  });

  it("getFlow normalises the latest reading", async () => {
    const { client } = fakeClient([
      [/FROM power_flows LATEST ON/, [{ device_id: "d" }]],
      [/site, grid, pv, battery/, [{ ts: "2026-06-28T02:10:00Z", site: 5274, grid: -7, pv: -2192, battery: -3075 }]],
      [/panel_bess/, [{ ts: "x", soc: 56, soe: 8, grid_state: "ON_GRID", connected: true }]],
    ]);
    const repo = new QuestDbRepository(client, { deviceId: "d", timezone: TZ });
    const snap = await repo.getFlow();
    expect(snap.solarW).toBe(2192);
    expect(snap.batteryW).toBe(3075);
    expect(snap.batterySoc).toBe(56);
  });

  it("getEnergySeries integrates flow rows for the source", async () => {
    const rows: Row[] = [
      { ts: "2026-06-27T06:00:00.000Z", site_w: 1000, pv_w: -2000, grid_w: 0, battery_w: 1000, batt_charge_sum: 0, batt_discharge_sum: 0, grid_import_sum: 0, grid_export_sum: 0, n: 60 },
    ];
    const { client } = fakeClient([[/SAMPLE BY/, rows]]);
    const repo = new QuestDbRepository(client, {
      deviceId: "d",
      timezone: TZ,
      now: () => new Date("2026-06-27T07:00:00.000Z").getTime(),
    });
    const series = await repo.getEnergySeries("solar", WINDOW);
    expect(series.points[0].kWh).toBe(2);
  });
});

describe("MockRepository", () => {
  const repo = new MockRepository();

  it("flow snapshot keeps the home invariant", async () => {
    const f = await repo.getFlow();
    expect(f.solarW + f.gridW + f.batteryW).toBe(f.homeW);
  });

  it("produces a non-empty hourly solar series", async () => {
    const s = await repo.getEnergySeries("solar", WINDOW);
    expect(s.points.length).toBeGreaterThan(0);
    expect(s.totals.kWh).toBeGreaterThan(0);
  });

  it("battery series has charge and discharge totals", async () => {
    const s = await repo.getEnergySeries("battery", WINDOW);
    expect(s.totals.chargedKWh).toBeGreaterThan(0);
    expect(s.totals.dischargedKWh).toBeGreaterThan(0);
  });

  it("returns ranked circuits", async () => {
    const c = await repo.getCircuits();
    expect(c[0].watts).toBeGreaterThanOrEqual(c[1].watts);
  });
});
