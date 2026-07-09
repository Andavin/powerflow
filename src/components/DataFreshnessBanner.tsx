"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/client/data";
import type { FreshnessResult } from "@/app/api/freshness/route";

function formatAge(seconds: number | null | undefined): string {
  if (seconds == null) return "a while";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Invisible unless the collector has stopped writing. Polls /api/freshness once
 * a minute; renders a warning bar when the newest write in any every-cycle
 * table is at least a minute old (or the database can't be reached).
 */
export function DataFreshnessBanner() {
  const { data } = useSWR<FreshnessResult>("/api/freshness", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    // A single failed poll shouldn't flash the banner; the minute cadence is
    // enough, and the route reports QuestDB outages as stale=true itself.
    shouldRetryOnError: false,
  });

  if (!data?.stale) return null;

  const message = data.error
    ? "Can't reach the database — live data may be stale."
    : data.table
      ? `No new data written for ${formatAge(data.ageSeconds)} (${data.table}). The collector may be down.`
      : "Data has stopped updating. The collector may be down.";

  return (
    <div
      role="alert"
      className="w-full border-b border-solar/40 bg-solar/15 px-4 py-2 text-center text-sm font-medium text-solar"
    >
      ⚠ {message}
    </div>
  );
}
