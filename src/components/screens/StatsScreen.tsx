"use client";
import Link from "next/link";

import { useMemo, useState } from "react";
import { Card, Segmented, Spinner, StatNumber, ErrorNote } from "@/components/primitives";
import { StatsChart } from "@/components/charts/StatsChart";
import { SOURCE_ICON } from "@/components/icons";
import { useStats, useCircuitEnergy } from "@/lib/client/data";
import { resolveRange } from "@/lib/time";
import { PANEL_TZ, addDaysStr, dayRangeWindow, todayStr } from "@/lib/client/tz";
import { SOURCE_COLOR, SOURCE_LABEL } from "@/lib/palette";
import { splitEnergy, formatPercent } from "@/lib/format";
import type { EnergySeries, StatRange, StatSource } from "@/lib/types";

type Mode = StatRange | "custom";
type Window = { from: string; to: string };

const SOURCES: StatSource[] = ["home", "solar", "battery", "grid"];
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

/** The headline kWh for a source (what the change % compares). */
function headlineKWh(series?: EnergySeries): number {
  if (!series) return 0;
  if (series.source === "battery") return series.totals.dischargedKWh ?? 0;
  if (series.source === "grid") return series.totals.importedKWh ?? 0;
  return series.totals.kWh;
}

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

function SourceTabs({
  source,
  onChange,
}: {
  source: StatSource;
  onChange: (s: StatSource) => void;
}) {
  return (
    <div role="tablist" aria-label="Energy source" className="flex justify-center gap-2">
      {SOURCES.map((s) => {
        const Icon = SOURCE_ICON[s];
        const active = s === source;
        return (
          <button
            key={s}
            role="tab"
            aria-selected={active}
            aria-label={SOURCE_LABEL[s]}
            onClick={() => onChange(s)}
            className={`flex h-12 w-12 items-center justify-center rounded-2xl border transition ${
              active ? "border-transparent bg-surface-2" : "border-border text-muted hover:text-fg"
            }`}
            style={active ? { color: SOURCE_COLOR[s] } : undefined}
          >
            <Icon width={24} height={24} />
          </button>
        );
      })}
    </div>
  );
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

function Totals({ series }: { series: EnergySeries }) {
  const color = SOURCE_COLOR[series.source];
  if (series.source === "battery") {
    const d = splitEnergy(series.totals.dischargedKWh ?? 0);
    const c = splitEnergy(series.totals.chargedKWh ?? 0);
    return (
      <div className="flex gap-8">
        <div>
          <StatNumber value={d.value} unit={d.unit} color={color} className="text-3xl" />
          <div className="text-xs text-muted">Discharged</div>
        </div>
        <div>
          <StatNumber value={c.value} unit={c.unit} className="text-3xl" />
          <div className="text-xs text-muted">Charged</div>
        </div>
      </div>
    );
  }
  if (series.source === "grid") {
    const imp = splitEnergy(series.totals.importedKWh ?? 0);
    const exp = splitEnergy(series.totals.exportedKWh ?? 0);
    return (
      <div className="flex gap-8">
        <div>
          <StatNumber value={imp.value} unit={imp.unit} color={color} className="text-3xl" />
          <div className="text-xs text-muted">Imported</div>
        </div>
        <div>
          <StatNumber value={exp.value} unit={exp.unit} className="text-3xl" />
          <div className="text-xs text-muted">Exported</div>
        </div>
      </div>
    );
  }
  const t = splitEnergy(series.totals.kWh);
  return (
    <div>
      <StatNumber value={t.value} unit={t.unit} color={color} className="text-4xl" />
      <div className="text-xs text-muted">
        {series.source === "solar" ? "Generated" : "Consumed"}
      </div>
    </div>
  );
}

/** Whole-home source mix (same for every circuit), shown once by the chart. */
function MixChips({ mix }: { mix: { solar: number; battery: number; grid: number } }) {
  return (
    <div className="flex gap-3 text-[11px] tabular-nums text-muted" title="Where this period's home energy came from">
      <span style={{ color: SOURCE_COLOR.solar }}>☀ {formatPercent(mix.solar)}</span>
      <span style={{ color: SOURCE_COLOR.battery }}>▮ {formatPercent(mix.battery)}</span>
      <span style={{ color: SOURCE_COLOR.grid }}>⊞ {formatPercent(mix.grid)}</span>
    </div>
  );
}

function CircuitBreakdown({
  window,
  prevWindow,
  compare,
}: {
  window: Window;
  prevWindow: Window;
  compare: boolean;
}) {
  const cur = useCircuitEnergy("custom", window);
  const prev = useCircuitEnergy("custom", compare ? prevWindow : window);
  const circuits = cur.data?.circuits ?? [];
  const byPrev = useMemo(
    () => new Map((prev.data?.circuits ?? []).map((c) => [c.id, c.kWh])),
    [prev.data],
  );
  if (circuits.length === 0) return null;
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-muted">What used the most energy?</h2>
      <ul className="flex flex-col gap-2">
        {circuits.slice(0, 8).map((c) => {
          const e = splitEnergy(c.kWh);
          const prevK = byPrev.get(c.id);
          const delta = compare && prevK != null && prevK > 0 ? (c.kWh - prevK) / prevK : null;
          return (
            <li key={c.id}>
              <Link
                href={`/circuits/${encodeURIComponent(c.id)}`}
                className="block rounded-xl bg-surface-2 px-4 py-3 transition hover:bg-surface-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {delta != null && (
                    <span
                      className="text-xs tabular-nums"
                      style={{ color: delta <= 0 ? SOURCE_COLOR.battery : SOURCE_COLOR.solar }}
                    >
                      {delta > 0 ? "↑" : "↓"} {Math.abs(delta * 100).toFixed(0)}%
                    </span>
                  )}
                  <StatNumber value={e.value} unit={e.unit} color={SOURCE_COLOR.home} />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function StatsScreen() {
  const [source, setSource] = useState<StatSource>("home");
  const [range, setRange] = useState<Mode>("today");
  // Period offset for presets: 0 = current, -1 = previous, etc.
  const [offset, setOffset] = useState(0);
  const [compare, setCompare] = useState(false);
  const [fromC, setFromC] = useState(() => addDaysStr(todayStr(), -6));
  const [toC, setToC] = useState(() => todayStr());

  const now = new Date();
  const isCustom = range === "custom";
  const noun = isCustom ? "period" : PERIOD_NOUN[range];

  // Selected window + the period immediately before it (for comparison).
  const win = isCustom ? dayRangeWindow(fromC, toC) : resolveRange(range, now, PANEL_TZ, offset);
  const prevWin: Window = isCustom
    ? (() => {
        const dur = new Date(win.to).getTime() - new Date(win.from).getTime();
        return { from: new Date(new Date(win.from).getTime() - dur).toISOString(), to: win.from };
      })()
    : resolveRange(range, now, PANEL_TZ, offset - 1);

  // Keep the live 30s refresh + SOC for the current preset period only.
  const isPresetNow = !isCustom && offset === 0;
  const cur = useStats(
    source,
    isPresetNow ? range : "custom",
    isPresetNow ? undefined : { from: win.from, to: win.to },
  );
  const prev = useStats(source, "custom", { from: prevWin.from, to: prevWin.to });

  // Whole-home source mix for the window (dedupes with the breakdown's fetch).
  const energy = useCircuitEnergy("custom", { from: win.from, to: win.to });
  const mix = energy.data?.circuits?.[0]?.mix ?? null;

  const delta = useMemo(() => {
    if (!compare) return null;
    const a = headlineKWh(cur.data?.series);
    const b = headlineKWh(prev.data?.series);
    return b > 0 ? (a - b) / b : null;
  }, [compare, cur.data, prev.data]);

  const prevHeadline = splitEnergy(headlineKWh(prev.data?.series));

  function pickRange(value: Mode) {
    setRange(value);
    setOffset(0);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <SourceTabs source={source} onChange={setSource} />
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

      {/* Compare toggle */}
      <button
        onClick={() => setCompare((v) => !v)}
        aria-pressed={compare}
        className={`self-start rounded-full border px-3 py-1.5 text-xs transition ${
          compare
            ? "border-transparent bg-surface-2 text-fg"
            : "border-border text-muted hover:text-fg"
        }`}
      >
        {compare ? `✓ Comparing to previous ${noun}` : `⇄ Compare to previous ${noun}`}
      </button>

      {cur.error && <ErrorNote message={String(cur.error.message ?? cur.error)} />}

      <Card className="p-5">
        {!cur.data || cur.isLoading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <Totals series={cur.data.series} />
              <div className="flex flex-col items-end gap-1.5">
                {compare && delta != null && (
                  <div className="text-right">
                    <div
                      className="text-2xl font-semibold tabular-nums"
                      style={{ color: delta <= 0 ? SOURCE_COLOR.battery : SOURCE_COLOR.solar }}
                    >
                      {delta > 0 ? "+" : ""}
                      {(delta * 100).toFixed(0)}%
                    </div>
                    <div className="text-xs text-muted">
                      vs {prevHeadline.value} {prevHeadline.unit} last {noun}
                    </div>
                  </div>
                )}
                {source === "home" && mix && <MixChips mix={mix} />}
              </div>
            </div>
            <StatsChart
              series={cur.data.series}
              soc={cur.data.soc}
              compare={compare ? prev.data?.series : undefined}
              height={260}
            />
            {compare && (
              <div className="mt-3 flex justify-center gap-4 text-[11px] text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SOURCE_COLOR[source] }} />
                  This {noun}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-white/40" />
                  Previous {noun}
                </span>
              </div>
            )}
          </>
        )}
      </Card>

      {source === "home" && (
        <CircuitBreakdown
          window={{ from: win.from, to: win.to }}
          prevWindow={prevWin}
          compare={compare}
        />
      )}
    </div>
  );
}
