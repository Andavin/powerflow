"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Segmented, Spinner, StatNumber } from "@/components/primitives";
import { StatsChart } from "@/components/charts/StatsChart";
import { useCircuitStats, useLiveStream } from "@/lib/client/data";
import { resolveRange } from "@/lib/time";
import { PANEL_TZ } from "@/lib/client/tz";
import { splitEnergy, splitPower } from "@/lib/format";
import { SOURCE_COLOR } from "@/lib/palette";
import type { StatRange } from "@/lib/types";

const RANGES = [
  { value: "today" as const, label: "Today" },
  { value: "week" as const, label: "Week" },
  { value: "month" as const, label: "Month" },
  { value: "year" as const, label: "Year" },
];

const PREV_LABEL: Record<StatRange, string> = {
  today: "yesterday",
  week: "last week",
  month: "last month",
  year: "last year",
};

export function CircuitDetail({ id }: { id: string }) {
  const { circuits } = useLiveStream();
  const circuit = circuits.find((c) => c.id === id);
  const [range, setRange] = useState<StatRange>("today");

  const { data, isLoading } = useCircuitStats(id, range);

  // Previous equal-length period, for the change indicator.
  const win = resolveRange(range, new Date(), PANEL_TZ);
  const durMs = new Date(win.to).getTime() - new Date(win.from).getTime();
  const prev = {
    from: new Date(new Date(win.from).getTime() - durMs).toISOString(),
    to: win.from,
  };
  const { data: prevData } = useCircuitStats(id, "custom", prev);

  const total = data?.series.totals.kWh ?? 0;
  const prevTotal = prevData?.series.totals.kWh ?? 0;
  const delta = prevTotal > 0 ? (total - prevTotal) / prevTotal : null;
  const t = splitEnergy(total);
  const live = circuit ? splitPower(circuit.watts) : null;

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

      <Segmented options={RANGES} value={range} onChange={setRange} size="sm" ariaLabel="Time range" />

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
                <span>used {range === "today" ? "today" : `this ${range}`}</span>
                {delta != null && (
                  <span style={{ color: delta <= 0 ? SOURCE_COLOR.battery : SOURCE_COLOR.solar }}>
                    {delta > 0 ? "↑" : "↓"} {Math.abs(delta * 100).toFixed(0)}% vs {PREV_LABEL[range]}
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
