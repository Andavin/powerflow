"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Segmented, Spinner, StatNumber } from "@/components/primitives";
import { StatsChart } from "@/components/charts/StatsChart";
import { useCircuitStats, useLiveStream } from "@/lib/client/data";
import { resolveRange } from "@/lib/time";
import { PANEL_TZ, addDaysStr, dayRangeWindow, todayStr } from "@/lib/client/tz";
import { splitEnergy, splitPower } from "@/lib/format";
import { SOURCE_COLOR } from "@/lib/palette";
import type { StatRange } from "@/lib/types";

type Mode = StatRange | "custom";

const RANGES = [
  { value: "today" as const, label: "Today" },
  { value: "week" as const, label: "Week" },
  { value: "month" as const, label: "Month" },
  { value: "year" as const, label: "Year" },
  { value: "custom" as const, label: "Custom" },
];

const PERIOD_NOUN: Record<StatRange, string> = {
  today: "day",
  week: "week",
  month: "month",
  year: "year",
};

function fmt(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PANEL_TZ, ...opts }).format(new Date(iso));
}

/** Human label for the period currently in view. */
function periodLabel(range: StatRange, offset: number, from: string, to: string): string {
  switch (range) {
    case "today":
      if (offset === 0) return "Today";
      if (offset === -1) return "Yesterday";
      return fmt(from, { month: "short", day: "numeric", year: "numeric" });
    case "week": {
      const lastDay = new Date(new Date(to).getTime() - 86_400_000).toISOString();
      return `${fmt(from, { month: "short", day: "numeric" })} – ${fmt(lastDay, { month: "short", day: "numeric" })}`;
    }
    case "month":
      return fmt(from, { month: "long", year: "numeric" });
    case "year":
      return fmt(from, { year: "numeric" });
  }
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
    <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
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

export function CircuitDetail({ id }: { id: string }) {
  const { circuits } = useLiveStream();
  const circuit = circuits.find((c) => c.id === id);
  const [range, setRange] = useState<Mode>("today");
  // Period offset for presets: 0 = current, -1 = previous period, etc.
  const [offset, setOffset] = useState(0);
  const [fromC, setFromC] = useState(() => addDaysStr(todayStr(), -6));
  const [toC, setToC] = useState(() => todayStr());

  const now = new Date();
  const isCustom = range === "custom";
  // Selected window, plus the period immediately before it for the change indicator.
  const win = isCustom ? dayRangeWindow(fromC, toC) : resolveRange(range, now, PANEL_TZ, offset);
  const prev = isCustom
    ? (() => {
        const dur = new Date(win.to).getTime() - new Date(win.from).getTime();
        return { from: new Date(new Date(win.from).getTime() - dur).toISOString(), to: win.from };
      })()
    : resolveRange(range, now, PANEL_TZ, offset - 1);

  // Keep the live 30s refresh only for the current preset period.
  const isPresetNow = !isCustom && offset === 0;
  const { data, isLoading } = useCircuitStats(
    id,
    isPresetNow ? range : "custom",
    isPresetNow ? undefined : { from: win.from, to: win.to },
  );
  const { data: prevData } = useCircuitStats(id, "custom", prev);

  const total = data?.series.totals.kWh ?? 0;
  const prevTotal = prevData?.series.totals.kWh ?? 0;
  const delta = prevTotal > 0 ? (total - prevTotal) / prevTotal : null;
  const t = splitEnergy(total);
  const live = circuit ? splitPower(circuit.watts) : null;

  const noun = isCustom ? "period" : PERIOD_NOUN[range];
  const usedWhen = isCustom
    ? "used this period"
    : offset === 0
      ? range === "today"
        ? "used today"
        : `used this ${noun}`
      : offset === -1
        ? range === "today"
          ? "used yesterday"
          : `used last ${noun}`
        : `used in ${periodLabel(range, offset, win.from, win.to)}`;
  const vsLabel = isCustom ? "previous period" : offset === 0 ? `last ${noun}` : `previous ${noun}`;

  function pickRange(value: Mode) {
    setRange(value);
    setOffset(0);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href="/circuits" className="text-sm text-muted hover:text-fg">
        ← Circuits
      </Link>

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{circuit?.name ?? id}</h1>
        {circuit && (
          <div className="flex items-center gap-2">
            <span
              className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                circuit.isOn ? "bg-positive/15 text-positive" : "bg-surface-3 text-faint"
              }`}
            >
              {circuit.isOn ? "On" : "Off"}
            </span>
            {live && <StatNumber value={live.value} unit={live.unit} color={SOURCE_COLOR.home} className="text-lg" />}
          </div>
        )}
      </div>

      <Segmented options={RANGES} value={range} onChange={pickRange} size="sm" ariaLabel="Time range" />

      {/* Period navigation (presets) or a custom date range. */}
      {isCustom ? (
        <div className="flex items-end gap-3">
          <DateField label="From" value={fromC} onChange={setFromC} />
          <DateField label="To" value={toC} onChange={setToC} />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => setOffset((o) => o - 1)}
            aria-label={`Previous ${noun}`}
            className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm text-muted transition hover:bg-surface-3 hover:text-fg"
          >
            ←
          </button>
          <span className="text-sm font-medium tabular-nums">{periodLabel(range, offset, win.from, win.to)}</span>
          <button
            onClick={() => setOffset((o) => Math.min(0, o + 1))}
            disabled={offset >= 0}
            aria-label={`Next ${noun}`}
            className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm text-muted transition hover:bg-surface-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
          >
            →
          </button>
        </div>
      )}

      <Card className="p-5">
        {!data || isLoading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="mb-4">
              <StatNumber value={t.value} unit={t.unit} color={SOURCE_COLOR.home} className="text-4xl" />
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                <span>{usedWhen}</span>
                {delta != null && (
                  <span style={{ color: delta <= 0 ? SOURCE_COLOR.battery : SOURCE_COLOR.solar }}>
                    {delta > 0 ? "↑" : "↓"} {Math.abs(delta * 100).toFixed(0)}% vs {vsLabel}
                  </span>
                )}
              </div>
            </div>
            <StatsChart series={data.series} height={260} />
          </>
        )}
      </Card>
    </div>
  );
}
