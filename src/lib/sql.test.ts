import { describe, it, expect } from "vitest";
import {
  escapeLiteral,
  latestDeviceSql,
  latestFlowSql,
  latestBatterySql,
  circuitsLatestSql,
  flowSeriesSql,
  socSeriesSql,
  circuitEnergySql,
  circuitSeriesSql,
  flowTotalsSql,
} from "./sql";
import type { TimeWindow } from "./time";

const TZ = "America/Denver";
const WINDOW: TimeWindow = {
  from: "2026-06-27T06:00:00.000Z",
  to: "2026-06-28T06:00:00.000Z",
  bucket: "hour",
};

describe("escapeLiteral", () => {
  it("doubles single quotes", () => {
    expect(escapeLiteral("a'b")).toBe("a''b");
  });
});

describe("latest queries", () => {
  it("latestDeviceSql uses LATEST ON", () => {
    expect(latestDeviceSql()).toContain("LATEST ON ts PARTITION BY device_id");
  });

  it("latestFlowSql selects the four raw channels", () => {
    const sql = latestFlowSql("dev1");
    expect(sql).toContain("site");
    expect(sql).toContain("grid");
    expect(sql).toContain("pv");
    expect(sql).toContain("battery");
    expect(sql).toContain("WHERE device_id = 'dev1'");
    expect(sql).toContain("LATEST ON ts PARTITION BY device_id");
  });

  it("omits the WHERE clause when no device id", () => {
    expect(latestFlowSql(null)).not.toContain("WHERE");
  });

  it("latestBatterySql reads soc/soe/grid_state", () => {
    const sql = latestBatterySql("dev1");
    expect(sql).toContain("soc");
    expect(sql).toContain("grid_state");
    expect(sql).toContain("connected");
  });
});

describe("circuitsLatestSql", () => {
  it("wraps LATEST ON in a subquery and orders by draw", () => {
    const sql = circuitsLatestSql("dev1");
    expect(sql).toContain("LATEST ON ts PARTITION BY circuit_id");
    expect(sql).toMatch(/SELECT \* FROM \([\s\S]*\) ORDER BY active_power ASC/);
  });
});

describe("flowSeriesSql", () => {
  const sql = flowSeriesSql(WINDOW, TZ, "dev1");
  it("filters by device and time window", () => {
    expect(sql).toContain("device_id = 'dev1'");
    expect(sql).toContain("ts >= '2026-06-27T06:00:00.000Z'");
    expect(sql).toContain("ts < '2026-06-28T06:00:00.000Z'");
  });
  it("samples hourly aligned to the panel timezone", () => {
    expect(sql).toContain("SAMPLE BY 1h");
    expect(sql).toContain("ALIGN TO CALENDAR TIME ZONE 'America/Denver'");
  });
  it("includes battery charge/discharge split and count", () => {
    expect(sql).toContain("batt_charge_sum");
    expect(sql).toContain("batt_discharge_sum");
    expect(sql).toContain("grid_import_sum");
    expect(sql).toContain("count() n");
  });
  it("uses the right unit for daily/monthly buckets", () => {
    expect(flowSeriesSql({ ...WINDOW, bucket: "day" }, TZ, null)).toContain(
      "SAMPLE BY 1d",
    );
    expect(flowSeriesSql({ ...WINDOW, bucket: "month" }, TZ, null)).toContain(
      "SAMPLE BY 1M",
    );
  });
});

describe("socSeriesSql", () => {
  it("reads soc from panel_bess with linear fill", () => {
    const sql = socSeriesSql(WINDOW, TZ, "dev1");
    expect(sql).toContain("avg(soc)");
    expect(sql).toContain("avg(soe)");
    expect(sql).toContain("panel_bess");
    expect(sql).toContain("FILL(LINEAR)");
  });
});

describe("circuitEnergySql", () => {
  it("sums per-circuit energy within the window", () => {
    const sql = circuitEnergySql(WINDOW, "dev1");
    expect(sql).toContain("node_type = 'circuit'");
    expect(sql).toContain("sum(imported_wh)");
    expect(sql).toContain("GROUP BY node_id, name");
  });
});

describe("circuitSeriesSql", () => {
  it("samples one circuit's energy, tz-aligned with zero fill", () => {
    const sql = circuitSeriesSql("abc123", WINDOW, TZ, "dev1");
    expect(sql).toContain("node_id = 'abc123'");
    expect(sql).toContain("node_type = 'circuit'");
    expect(sql).toContain("sum(exported_wh)");
    expect(sql).toContain("SAMPLE BY 1h FILL(0)");
    expect(sql).toContain("ALIGN TO CALENDAR TIME ZONE 'America/Denver'");
  });
  it("escapes the circuit id", () => {
    expect(circuitSeriesSql("a'b", WINDOW, TZ, null)).toContain("node_id = 'a''b'");
  });
});

describe("flowTotalsSql", () => {
  it("aggregates the whole window without SAMPLE BY", () => {
    const sql = flowTotalsSql(WINDOW, "dev1");
    expect(sql).not.toContain("SAMPLE BY");
    expect(sql).toContain("avg(site)");
    expect(sql).toContain("count() n");
  });
});
