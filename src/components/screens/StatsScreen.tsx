"use client";

import { useState } from "react";
import { Card, Segmented, Spinner, StatNumber, ErrorNote } from "@/components/primitives";
import { StatsChart } from "@/components/charts/StatsChart";
import { SOURCE_ICON } from "@/components/icons";
import { useStats, useCircuitEnergy } from "@/lib/client/data";
import { SOURCE_COLOR, SOURCE_LABEL } from "@/lib/palette";
import { splitEnergy, formatPercent } from "@/lib/format";
import type { EnergySeries, StatRange, StatSource } from "@/lib/types";

const SOURCES: StatSource[] = ["home", "solar", "battery", "grid"];
const RANGES = [
  { value: "today" as const, label: "Today" },
  { value: "week" as const, label: "Week" },
  { value: "month" as const, label: "Month" },
  { value: "year" as const, label: "Year" },
];

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

function HomeCircuitBreakdown({ range }: { range: StatRange }) {
  const { data } = useCircuitEnergy(range);
  const circuits = data?.circuits ?? [];
  if (circuits.length === 0) return null;
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-muted">What used the most energy?</h2>
      <ul className="flex flex-col gap-2">
        {circuits.slice(0, 8).map((c) => {
          const e = splitEnergy(c.kWh);
          return (
            <li key={c.id} className="rounded-xl bg-surface-2 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <StatNumber value={e.value} unit={e.unit} color={SOURCE_COLOR.home} />
              </div>
              <div className="mt-1 flex gap-3 text-[11px] text-muted">
                <span style={{ color: SOURCE_COLOR.solar }}>☀ {formatPercent(c.mix.solar)}</span>
                <span style={{ color: SOURCE_COLOR.battery }}>▮ {formatPercent(c.mix.battery)}</span>
                <span style={{ color: SOURCE_COLOR.grid }}>⊞ {formatPercent(c.mix.grid)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function StatsScreen() {
  const [source, setSource] = useState<StatSource>("home");
  const [range, setRange] = useState<StatRange>("today");
  const { data, error, isLoading } = useStats(source, range);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <SourceTabs source={source} onChange={setSource} />
      <Segmented options={RANGES} value={range} onChange={setRange} size="sm" ariaLabel="Time range" />

      {error && <ErrorNote message={String(error.message ?? error)} />}

      <Card className="p-5">
        {!data || isLoading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-end justify-between">
              <Totals series={data.series} />
            </div>
            <StatsChart series={data.series} soc={data.soc} height={260} />
          </>
        )}
      </Card>

      {source === "home" && <HomeCircuitBreakdown range={range} />}
    </div>
  );
}
