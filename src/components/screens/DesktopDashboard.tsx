"use client";

import { FlowDiagram } from "@/components/FlowDiagram";
import { Sparkline } from "@/components/charts/Sparkline";
import { StatsChart } from "@/components/charts/StatsChart";
import { Card, Spinner, StatNumber } from "@/components/primitives";
import { SOURCE_ICON } from "@/components/icons";
import { useLiveStream, useStats } from "@/lib/client/data";
import { SOURCE_COLOR, SOURCE_LABEL } from "@/lib/palette";
import { splitEnergy, splitPower, formatPercent } from "@/lib/format";
import type { EnergySeries, StatSource, TopConsumer } from "@/lib/types";

interface Metric {
  value: string;
  unit: string;
  label: string;
}

/**
 * Today's energy for a card. Bidirectional sources (battery, grid) return two
 * labelled values; solar/home return one.
 */
function cardMetrics(series: EnergySeries): Metric[] {
  const t = series.totals;
  if (series.source === "battery") {
    return [
      { ...splitEnergy(t.chargedKWh ?? 0), label: "charged" },
      { ...splitEnergy(t.dischargedKWh ?? 0), label: "discharged" },
    ];
  }
  if (series.source === "grid") {
    return [
      { ...splitEnergy(t.importedKWh ?? 0), label: "imported" },
      { ...splitEnergy(t.exportedKWh ?? 0), label: "exported" },
    ];
  }
  return [
    { ...splitEnergy(t.kWh), label: series.source === "solar" ? "generated" : "consumed" },
  ];
}

function SourceStatCard({ source }: { source: StatSource }) {
  const { data } = useStats(source, "today");
  const Icon = SOURCE_ICON[source];
  const color = SOURCE_COLOR[source];
  const series = data?.series;
  const metrics = series ? cardMetrics(series) : null;
  const spark = series
    ? series.points.map((p) =>
        source === "battery" ? (p.dischargedKWh ?? 0) : Math.max(0, p.kWh),
      )
    : [];

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2 text-sm text-muted">
        <span style={{ color }}>
          <Icon width={18} height={18} />
        </span>
        {SOURCE_LABEL[source]}
      </div>
      {metrics ? (
        <>
          {metrics.length === 1 ? (
            <StatNumber value={metrics[0].value} unit={metrics[0].unit} color={color} className="text-3xl" />
          ) : (
            <div className="flex gap-6">
              {metrics.map((m) => (
                <div key={m.label}>
                  <StatNumber value={m.value} unit={m.unit} color={color} className="text-2xl" />
                  <div className="text-xs text-muted">{m.label}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-auto flex items-end justify-between gap-2 pt-1">
            <span className="text-xs text-faint">
              {metrics.length === 1 ? `${metrics[0].label} today` : "today"}
            </span>
            <Sparkline values={spark} color={color} />
          </div>
        </>
      ) : (
        <div className="flex h-20 items-center">
          <Spinner className="h-5 w-5" />
        </div>
      )}
    </Card>
  );
}

function TopConsumers({ top }: { top: TopConsumer[] }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-muted">Using the most power now</h2>
      <ul className="flex flex-col gap-2">
        {top.map((c) => {
          const p = splitPower(c.watts);
          return (
            <li key={c.id} className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
              <span className="text-xs" style={{ color: SOURCE_COLOR.home }}>
                {formatPercent(c.share)}
              </span>
              <StatNumber value={p.value} unit={p.unit} className="w-16 text-right text-sm" />
            </li>
          );
        })}
        {top.length === 0 && <li className="py-4 text-center text-sm text-faint">Idle</li>}
      </ul>
    </Card>
  );
}

export function DesktopDashboard() {
  const { flow, top, connected } = useLiveStream();
  const homeToday = useStats("home", "today");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-positive" : "bg-faint"}`} />
          {connected ? "Live" : "Connecting…"}
        </span>
      </div>

      <div className="grid grid-cols-12 gap-5">
        <Card className="col-span-12 flex items-center justify-center p-6 xl:col-span-5">
          {flow ? <FlowDiagram flow={flow} /> : <Spinner />}
        </Card>

        <div className="col-span-12 grid grid-cols-2 gap-5 xl:col-span-7">
          <SourceStatCard source="solar" />
          <SourceStatCard source="home" />
          <SourceStatCard source="battery" />
          <SourceStatCard source="grid" />
          <div className="col-span-2">
            <TopConsumers top={top} />
          </div>
        </div>
      </div>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold text-muted">Home consumption today</h2>
        {homeToday.data ? (
          <StatsChart series={homeToday.data.series} height={220} />
        ) : (
          <div className="flex h-[220px] items-center justify-center">
            <Spinner />
          </div>
        )}
      </Card>
    </div>
  );
}
