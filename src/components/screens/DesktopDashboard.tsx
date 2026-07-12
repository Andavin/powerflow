"use client";

import Link from "next/link";
import { FlowDiagram } from "@/components/FlowDiagram";
import { Sparkline } from "@/components/charts/Sparkline";
import { StatsChart } from "@/components/charts/StatsChart";
import { Card, Spinner, StatNumber } from "@/components/primitives";
import { SOURCE_ICON } from "@/components/icons";
import { useLiveStream, useStats } from "@/lib/client/data";
import { sourceMetrics, type SourceMetric } from "@/lib/energy";
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
 * labelled values; solar/home return one. Battery leads with charged, grid with
 * imported (the primary), so the ordering is source-specific.
 */
function cardMetrics(series: EnergySeries): Metric[] {
  const { primary, secondary } = sourceMetrics(series);
  const m = (x: SourceMetric): Metric => ({ ...splitEnergy(x.kWh), label: x.label.toLowerCase() });
  if (!secondary) return [m(primary)];
  return series.source === "battery" ? [m(secondary), m(primary)] : [m(primary), m(secondary)];
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
    <Link
      href={`/stats?source=${source}`}
      aria-label={`View ${SOURCE_LABEL[source]} stats`}
      className="block h-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-battery/40"
    >
      <Card className="flex h-full flex-col gap-2 p-4 transition hover:bg-surface-2">
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
    </Link>
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
            <li key={c.id}>
              <Link
                href={`/circuits/${encodeURIComponent(c.id)}`}
                className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 transition hover:bg-surface-3"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                <span className="text-xs" style={{ color: SOURCE_COLOR.home }}>
                  {formatPercent(c.share)}
                </span>
                <StatNumber value={p.value} unit={p.unit} className="w-16 text-right text-sm" />
              </Link>
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
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-positive" : "bg-faint"}`}
            aria-hidden
          />
          <span aria-live="polite" aria-atomic="true">
            {connected ? "Live" : "Connecting…"}
          </span>
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
