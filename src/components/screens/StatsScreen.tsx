"use client";
import Link from "next/link";

import { useMemo, useState } from "react";
import { Card, Spinner, StatNumber, ErrorNote } from "@/components/primitives";
import { StatsChart } from "@/components/charts/StatsChart";
import {
  CompareLegend,
  CompareToggle,
  PeriodControls,
  usePeriodSelector,
} from "@/components/PeriodControls";
import { SOURCE_ICON } from "@/components/icons";
import { useStats, useCircuitEnergy } from "@/lib/client/data";
import type { Window } from "@/lib/period";
import { headlineKWh, sourceMetrics } from "@/lib/energy";
import { SOURCE_COLOR, SOURCE_LABEL } from "@/lib/palette";
import { splitEnergy, formatPercent } from "@/lib/format";
import type { EnergySeries, StatSource } from "@/lib/types";

const SOURCES: StatSource[] = ["home", "solar", "battery", "grid"];

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

function Totals({ series }: { series: EnergySeries }) {
  const color = SOURCE_COLOR[series.source];
  const { primary, secondary } = sourceMetrics(series);
  const p = splitEnergy(primary.kWh);
  if (secondary) {
    const s = splitEnergy(secondary.kWh);
    return (
      <div className="flex gap-8">
        <div>
          <StatNumber value={p.value} unit={p.unit} color={color} className="text-3xl" />
          <div className="text-xs text-muted">{primary.label}</div>
        </div>
        <div>
          <StatNumber value={s.value} unit={s.unit} className="text-3xl" />
          <div className="text-xs text-muted">{secondary.label}</div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <StatNumber value={p.value} unit={p.unit} color={color} className="text-4xl" />
      <div className="text-xs text-muted">{primary.label}</div>
    </div>
  );
}

/** Whole-home source mix (same for every circuit), shown once by the chart. */
function MixChips({ mix }: { mix: { solar: number; battery: number; grid: number } }) {
  return (
    <div className="flex gap-3 text-[11px] tabular-nums text-muted" title="Where this period's home energy came from">
      <span style={{ color: SOURCE_COLOR.solar }} aria-label={`Solar ${formatPercent(mix.solar)}`}>
        <span aria-hidden="true">☀ {formatPercent(mix.solar)}</span>
      </span>
      <span style={{ color: SOURCE_COLOR.battery }} aria-label={`Battery ${formatPercent(mix.battery)}`}>
        <span aria-hidden="true">▮ {formatPercent(mix.battery)}</span>
      </span>
      <span style={{ color: SOURCE_COLOR.grid }} aria-label={`Grid ${formatPercent(mix.grid)}`}>
        <span aria-hidden="true">⊞ {formatPercent(mix.grid)}</span>
      </span>
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
  const [unit, setUnit] = useState<"kwh" | "pct">("kwh");
  const cur = useCircuitEnergy("custom", window);
  const prev = useCircuitEnergy("custom", prevWindow, compare);
  const circuits = useMemo(() => cur.data?.circuits ?? [], [cur.data]);
  const byPrev = useMemo(
    () => new Map((prev.data?.circuits ?? []).map((c) => [c.id, c.kWh])),
    [prev.data],
  );
  const total = useMemo(() => circuits.reduce((s, c) => s + c.kWh, 0), [circuits]);
  if (circuits.length === 0) return null;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-muted">What used the most energy?</h2>
        <div className="flex overflow-hidden rounded-lg border border-border text-[11px]">
          {(["kwh", "pct"] as const).map((u) => (
            <button
              key={u}
              onClick={() => setUnit(u)}
              aria-pressed={unit === u}
              className={`px-2 py-1 transition ${unit === u ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}
            >
              {u === "kwh" ? "kWh" : "%"}
            </button>
          ))}
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {circuits.slice(0, 8).map((c) => {
          const e = splitEnergy(c.kWh);
          const pct = total > 0 ? (c.kWh / total) * 100 : 0;
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
                  {unit === "pct" ? (
                    <StatNumber value={pct.toFixed(pct < 10 ? 1 : 0)} unit="%" color={SOURCE_COLOR.home} />
                  ) : (
                    <StatNumber value={e.value} unit={e.unit} color={SOURCE_COLOR.home} />
                  )}
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
  const sel = usePeriodSelector();
  const { compare, noun, win, prev: prevWin } = sel;

  // Keep the live 30s refresh + SOC for the current preset period only.
  const cur = useStats(
    source,
    sel.isPresetNow ? sel.range : "custom",
    sel.isPresetNow ? undefined : { from: win.from, to: win.to },
  );
  // Only fetch the previous period when the comparison is switched on.
  const prev = useStats(source, "custom", { from: prevWin.from, to: prevWin.to }, compare);

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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <SourceTabs source={source} onChange={setSource} />
      <PeriodControls sel={sel} />
      <CompareToggle sel={sel} />

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
            {compare && <CompareLegend noun={noun} color={SOURCE_COLOR[source]} />}
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
