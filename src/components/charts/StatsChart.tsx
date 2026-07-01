"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Bucket, EnergySeries, StatSource } from "@/lib/types";
import { SOURCE_COLOR, AXIS, GRID_LINE, NEGATIVE } from "@/lib/palette";

function tickFormatter(bucket: Bucket, tz = "America/Denver") {
  const opts: Intl.DateTimeFormatOptions =
    bucket === "hour"
      ? { hour: "numeric", timeZone: tz }
      : bucket === "day"
        ? { month: "short", day: "numeric", timeZone: tz }
        : { month: "short", timeZone: tz };
  const fmt = new Intl.DateTimeFormat("en-US", opts);
  return (iso: string) => fmt.format(new Date(iso));
}

interface ChartDatum {
  ts: string;
  value: number;
  charge?: number;
  discharge?: number;
  soc?: number | null;
  /** Comparison period, aligned by bucket index. */
  cmp?: number;
  cmpDischarge?: number;
}

function buildData(
  series: EnergySeries,
  soc?: { ts: string; soc: number | null }[],
  compare?: EnergySeries,
): ChartDatum[] {
  const socByTs = new Map((soc ?? []).map((p) => [p.ts, p.soc]));
  const cmp = compare?.points;
  return series.points.map((p, i) => ({
    ts: p.ts,
    value: p.kWh,
    charge: p.chargedKWh != null ? -p.chargedKWh : undefined,
    discharge: p.dischargedKWh,
    soc: socByTs.get(p.ts) ?? null,
    cmp: cmp ? cmp[i]?.kWh : undefined,
    cmpDischarge: cmp ? cmp[i]?.dischargedKWh : undefined,
  }));
}

const COMPARE_FILL = "#ffffff";
const COMPARE_OPACITY = 0.4;

// Recharts types its tooltip render-prop loosely (generic ValueType, readonly
// payload). We keep this boundary permissive and normalise defensively below.
/* eslint-disable @typescript-eslint/no-explicit-any */
function ChartTooltip(props: {
  active?: boolean;
  payload?: ReadonlyArray<any>;
  label?: any;
  bucket: Bucket;
  source: StatSource;
}) {
  const { active, payload, label, bucket, source } = props;
  if (!active || !payload?.length || label == null) return null;
  const fmt = tickFormatter(bucket);
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted">{fmt(String(label))}</div>
      {payload.map((p, i) => {
        const key = String(p.dataKey ?? i);
        return (
          <div key={key} className="tabular-nums">
            {labelForKey(key, source)}: {Math.abs(Number(p.value ?? 0)).toFixed(2)}
            {key === "soc" ? "%" : " kWh"}
          </div>
        );
      })}
    </div>
  );
}

function labelForKey(key: string, source: StatSource): string {
  if (key === "charge") return "Charged";
  if (key === "discharge") return "Discharged";
  if (key === "soc") return "Charge";
  if (key === "cmp" || key === "cmpDischarge") return "Previous";
  if (key === "value") return source === "grid" ? "Net" : "Energy";
  return key;
}

export function StatsChart({
  series,
  soc,
  compare,
  height = 240,
}: {
  series: EnergySeries;
  soc?: { ts: string; soc: number | null }[];
  compare?: EnergySeries;
  height?: number;
}) {
  const data = buildData(series, soc, compare);
  const fmt = tickFormatter(series.bucket);
  const color = SOURCE_COLOR[series.source];

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-faint"
        style={{ height }}
      >
        No data for this period.
      </div>
    );
  }

  const axisProps = {
    stroke: AXIS,
    tick: { fill: AXIS, fontSize: 11 },
    tickLine: false,
    axisLine: false,
  };

  // Battery: diverging charge/discharge bars with an optional SOC line overlay.
  if (series.source === "battery") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke={GRID_LINE} vertical={false} />
          <XAxis dataKey="ts" tickFormatter={fmt} {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} width={40} />
          {soc && soc.length > 0 && (
            <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} hide />
          )}
          <ReferenceLine y={0} stroke={AXIS} />
          <Tooltip
            content={(p) => <ChartTooltip {...p} bucket={series.bucket} source="battery" />}
            cursor={{ fill: "#ffffff08" }}
          />
          <Bar dataKey="discharge" fill={color} radius={[3, 3, 0, 0]} maxBarSize={26} />
          <Bar dataKey="charge" fill="#ffffff" fillOpacity={0.85} radius={[0, 0, 3, 3]} maxBarSize={26} />
          {compare && (
            <Bar dataKey="cmpDischarge" fill={COMPARE_FILL} fillOpacity={COMPARE_OPACITY} radius={[3, 3, 0, 0]} maxBarSize={26} />
          )}
          {soc && soc.length > 0 && (
            <Line
              yAxisId="soc"
              type="monotone"
              dataKey="soc"
              stroke={SOURCE_COLOR.battery}
              strokeOpacity={0.5}
              strokeWidth={2}
              dot={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  // Solar / home / grid: single value bars (grid colours export negative).
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID_LINE} vertical={false} />
        <XAxis dataKey="ts" tickFormatter={fmt} {...axisProps} minTickGap={24} />
        <YAxis {...axisProps} width={40} />
        <ReferenceLine y={0} stroke={AXIS} />
        <Tooltip
          content={(p) => <ChartTooltip {...p} bucket={series.bucket} source={series.source} />}
          cursor={{ fill: "#ffffff08" }}
        />
        <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={26}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.value < 0 ? NEGATIVE : color} />
          ))}
        </Bar>
        {compare && (
          <Bar dataKey="cmp" fill={COMPARE_FILL} fillOpacity={COMPARE_OPACITY} radius={[3, 3, 0, 0]} maxBarSize={26} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
