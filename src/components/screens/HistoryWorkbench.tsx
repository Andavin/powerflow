"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, Spinner, StatNumber, ErrorNote } from "@/components/primitives";
import { SOURCE_ICON } from "@/components/icons";
import { useStats } from "@/lib/client/data";
import { addDaysStr, dayCount, dayRangeWindow, todayStr } from "@/lib/client/tz";
import { SOURCE_COLOR, SOURCE_LABEL, AXIS, GRID_LINE } from "@/lib/palette";
import { splitEnergy } from "@/lib/format";
import type { EnergyPoint, EnergySeries, StatSource } from "@/lib/types";

const SOURCES: StatSource[] = ["home", "solar", "battery", "grid"];

function pointValue(source: StatSource, p: EnergyPoint): number {
  if (source === "battery") return p.dischargedKWh ?? 0;
  if (source === "grid") return Math.max(0, p.kWh);
  return p.kWh;
}

function seriesTotal(source: StatSource, series?: EnergySeries): number {
  if (!series) return 0;
  if (source === "battery") return series.totals.dischargedKWh ?? 0;
  if (source === "grid") return series.totals.importedKWh ?? 0;
  return series.totals.kWh;
}

function bucketLabel(iso: string, bucket: string): string {
  const opts: Intl.DateTimeFormatOptions =
    bucket === "hour"
      ? { hour: "numeric", timeZone: "America/Denver" }
      : bucket === "month"
        ? { month: "short", timeZone: "America/Denver" }
        : { month: "short", day: "numeric", timeZone: "America/Denver" };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(iso));
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input
        type="date"
        value={value}
        max={todayStr()}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-battery"
      />
    </label>
  );
}

export function HistoryWorkbench() {
  const [source, setSource] = useState<StatSource>("home");
  const [compare, setCompare] = useState(false);

  const [fromA, setFromA] = useState(() => addDaysStr(todayStr(), -6));
  const [toA, setToA] = useState(() => todayStr());
  const [fromB, setFromB] = useState(() => addDaysStr(todayStr(), -13));
  const [toB, setToB] = useState(() => addDaysStr(todayStr(), -7));

  const windowA = useMemo(() => dayRangeWindow(fromA, toA), [fromA, toA]);
  const windowB = useMemo(() => dayRangeWindow(fromB, toB), [fromB, toB]);

  const a = useStats(source, "custom", { from: windowA.from, to: windowA.to });
  const b = useStats(source, "custom", { from: windowB.from, to: windowB.to });
  const showB = compare && b.data;

  const data = useMemo(() => {
    const ptsA = a.data?.series.points ?? [];
    const ptsB = b.data?.series.points ?? [];
    const len = compare ? Math.max(ptsA.length, ptsB.length) : ptsA.length;
    return Array.from({ length: len }).map((_, i) => ({
      label: ptsA[i] ? bucketLabel(ptsA[i].ts, a.data!.series.bucket) : `#${i + 1}`,
      a: ptsA[i] ? pointValue(source, ptsA[i]) : 0,
      b: compare && ptsB[i] ? pointValue(source, ptsB[i]) : undefined,
    }));
  }, [a.data, b.data, source, compare]);

  const totalA = seriesTotal(source, a.data?.series);
  const totalB = seriesTotal(source, b.data?.series);
  const delta = totalB > 0 ? (totalA - totalB) / totalB : null;

  const color = SOURCE_COLOR[source];
  const tA = splitEnergy(totalA);
  const tB = splitEnergy(totalB);

  function setPreset(days: number) {
    const today = todayStr();
    setFromA(addDaysStr(today, -(days - 1)));
    setToA(today);
  }

  function comparePrevious() {
    const span = dayCount(fromA, toA);
    setFromB(addDaysStr(fromA, -span));
    setToB(addDaysStr(fromA, -1));
    setCompare(true);
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">History</h1>
        <p className="text-sm text-muted">
          Custom timeframes and period-over-period comparisons.
        </p>
      </div>

      {/* Controls */}
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {SOURCES.map((s) => {
            const Icon = SOURCE_ICON[s];
            const active = s === source;
            return (
              <button
                key={s}
                onClick={() => setSource(s)}
                aria-pressed={active}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                  active ? "border-transparent bg-surface-2" : "border-border text-muted hover:text-fg"
                }`}
                style={active ? { color: SOURCE_COLOR[s] } : undefined}
              >
                <Icon width={16} height={16} />
                {SOURCE_LABEL[s]}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <DateField label="From" value={fromA} onChange={setFromA} />
          <DateField label="To" value={toA} onChange={setToA} />
          <div className="flex gap-2">
            <button onClick={() => setPreset(7)} className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted hover:text-fg">
              7 days
            </button>
            <button onClick={() => setPreset(30)} className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted hover:text-fg">
              30 days
            </button>
            <button onClick={() => setPreset(90)} className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted hover:text-fg">
              90 days
            </button>
          </div>
          <button
            onClick={comparePrevious}
            className="rounded-lg border border-border px-3 py-2 text-xs text-muted hover:text-fg"
          >
            Compare to previous period
          </button>
        </div>

        {compare && (
          <div className="flex flex-wrap items-end gap-4 border-t border-border pt-4">
            <span className="text-xs font-medium text-faint">Comparison period</span>
            <DateField label="From" value={fromB} onChange={setFromB} />
            <DateField label="To" value={toB} onChange={setToB} />
            <button onClick={() => setCompare(false)} className="text-xs text-muted hover:text-fg">
              Remove comparison
            </button>
          </div>
        )}
      </Card>

      {(a.error || b.error) && <ErrorNote message={String((a.error || b.error)?.message)} />}

      {/* Totals */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">Selected period</div>
          <StatNumber value={tA.value} unit={tA.unit} color={color} className="text-3xl" />
        </Card>
        {compare && (
          <Card className="p-4">
            <div className="text-xs text-muted">Previous period</div>
            <StatNumber value={tB.value} unit={tB.unit} className="text-3xl" />
          </Card>
        )}
        {compare && delta != null && (
          <Card className="p-4">
            <div className="text-xs text-muted">Change</div>
            <span
              className="text-3xl font-semibold tabular-nums"
              style={{ color: delta <= 0 ? SOURCE_COLOR.battery : SOURCE_COLOR.solar }}
            >
              {delta > 0 ? "+" : ""}
              {(delta * 100).toFixed(0)}%
            </span>
          </Card>
        )}
      </div>

      {/* Chart */}
      <Card className="p-5">
        {a.isLoading && !a.data ? (
          <div className="flex h-[320px] items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={340}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid stroke={GRID_LINE} vertical={false} />
              <XAxis dataKey="label" stroke={AXIS} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={20} />
              <YAxis stroke={AXIS} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
              <Tooltip
                cursor={{ fill: "#ffffff08" }}
                contentStyle={{ background: "#111317", border: "1px solid #2a2e37", borderRadius: 8, fontSize: 12 }}
                formatter={(v: unknown) => `${Number(v ?? 0).toFixed(2)} kWh`}
              />
              <Bar dataKey="a" name="Selected" fill={color} radius={[3, 3, 0, 0]} maxBarSize={28} />
              {showB && <Bar dataKey="b" name="Comparison" fill="#ffffff" fillOpacity={0.55} radius={[3, 3, 0, 0]} maxBarSize={28} />}
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>
    </div>
  );
}
