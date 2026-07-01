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

/** Sources charted as a diverging bar: a positive flow up, a negative flow down. */
function isDiverging(source: StatSource): boolean {
  return source === "battery" || source === "grid";
}

interface ChartDatum {
  ts: string;
  value?: number; // home / solar single bar
  pos?: number; // diverging: above zero (discharged / imported)
  neg?: number; // diverging: below zero (charged / exported), stored negative
  soc?: number | null;
  cmpValue?: number; // previous-period single bar
  cmpPos?: number;
  cmpNeg?: number;
}

/** Positive (up) flow for a diverging source at a point/compare point. */
function upFlow(source: StatSource, p: { dischargedKWh?: number; importedKWh?: number }): number {
  return (source === "battery" ? p.dischargedKWh : p.importedKWh) ?? 0;
}
/** Negative (down) flow magnitude for a diverging source. */
function downFlow(source: StatSource, p: { chargedKWh?: number; exportedKWh?: number }): number {
  return (source === "battery" ? p.chargedKWh : p.exportedKWh) ?? 0;
}

function buildData(
  series: EnergySeries,
  soc?: { ts: string; soc: number | null }[],
  compare?: EnergySeries,
): ChartDatum[] {
  const socByTs = new Map((soc ?? []).map((p) => [p.ts, p.soc]));
  const cmp = compare?.points;
  const div = isDiverging(series.source);
  return series.points.map((p, i) => {
    const c = cmp?.[i];
    const base: ChartDatum = { ts: p.ts, soc: socByTs.get(p.ts) ?? null };
    if (div) {
      base.pos = upFlow(series.source, p);
      base.neg = -downFlow(series.source, p);
      if (c) {
        base.cmpPos = upFlow(series.source, c);
        base.cmpNeg = -downFlow(series.source, c);
      }
    } else {
      base.value = p.kWh;
      if (c) base.cmpValue = c.kWh;
    }
    return base;
  });
}

const COMPARE_FILL = "#ffffff";
const COMPARE_OPACITY = 0.4;
const DOWN_OPACITY = 0.55;
/** Below this many buckets we mark the SOC line with dots (the daily look). */
const SOC_DOT_LIMIT = 40;

function labelForKey(key: string, source: StatSource): string {
  const up = source === "battery" ? "Discharged" : source === "grid" ? "Imported" : "Energy";
  const down = source === "battery" ? "Charged" : "Exported";
  switch (key) {
    case "pos":
    case "value":
      return up;
    case "neg":
      return down;
    case "cmpValue":
    case "cmpPos":
      return `Prev. ${up.toLowerCase()}`;
    case "cmpNeg":
      return `Prev. ${down.toLowerCase()}`;
    case "soc":
      return "Charge";
    default:
      return key;
  }
}

// Order tooltip rows: current flows first, previous next, SOC last.
const KEY_RANK: Record<string, number> = {
  value: 0,
  pos: 0,
  neg: 1,
  cmpValue: 2,
  cmpPos: 2,
  cmpNeg: 3,
  soc: 4,
};

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
  const rows = [...payload]
    .filter((p) => p.value != null)
    .sort((a, b) => (KEY_RANK[String(a.dataKey)] ?? 9) - (KEY_RANK[String(b.dataKey)] ?? 9));
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted">{fmt(String(label))}</div>
      {rows.map((p, i) => {
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

  // Battery / grid: one diverging bar per bucket (flow up, other flow down),
  // previous period grouped to the left. Battery adds a SOC line overlay.
  if (isDiverging(series.source)) {
    const hasSoc = series.source === "battery" && !!soc && soc.length > 0;
    const showDots = data.length <= SOC_DOT_LIMIT;
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke={GRID_LINE} vertical={false} />
          <XAxis dataKey="ts" tickFormatter={fmt} {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} width={40} />
          {hasSoc && <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} hide />}
          <ReferenceLine y={0} stroke={AXIS} />
          <Tooltip
            content={(p) => <ChartTooltip {...p} bucket={series.bucket} source={series.source} />}
            cursor={{ fill: "#ffffff08" }}
          />
          {compare && (
            <>
              <Bar dataKey="cmpPos" stackId="prev" fill={COMPARE_FILL} fillOpacity={COMPARE_OPACITY} radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="cmpNeg" stackId="prev" fill={COMPARE_FILL} fillOpacity={COMPARE_OPACITY * 0.6} radius={[0, 0, 3, 3]} maxBarSize={22} />
            </>
          )}
          <Bar dataKey="pos" stackId="cur" fill={color} radius={[3, 3, 0, 0]} maxBarSize={22} />
          <Bar dataKey="neg" stackId="cur" fill={color} fillOpacity={DOWN_OPACITY} radius={[0, 0, 3, 3]} maxBarSize={22} />
          {hasSoc && (
            <Line
              yAxisId="soc"
              type="monotone"
              dataKey="soc"
              stroke={SOURCE_COLOR.battery}
              strokeWidth={2}
              dot={showDots ? { r: 2.5, fill: SOURCE_COLOR.battery, strokeWidth: 0 } : false}
              activeDot={{ r: 4 }}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  // Home / solar: single value bars, previous period grouped to the left.
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
        {compare && (
          <Bar dataKey="cmpValue" fill={COMPARE_FILL} fillOpacity={COMPARE_OPACITY} radius={[3, 3, 0, 0]} maxBarSize={22} />
        )}
        <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={22}>
          {data.map((d, i) => (
            <Cell key={i} fill={(d.value ?? 0) < 0 ? NEGATIVE : color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
