"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import type {
  Circuit,
  CircuitEnergy,
  EnergySeries,
  FlowSnapshot,
  StatRange,
  StatSource,
  TopConsumer,
} from "@/lib/types";

export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
};

export interface LiveState {
  flow: FlowSnapshot | null;
  /** Top current consumers, pushed live alongside the flow. */
  top: TopConsumer[];
  /** Full circuit list with live watts + relay. */
  circuits: Circuit[];
  connected: boolean;
  error: string | null;
}

/**
 * The single real-time feed: flow, top consumers, and the full circuit list,
 * over Server-Sent Events. EventSource reconnects automatically; there is no
 * database polling. Stats/history are fetched separately, on demand.
 */
export function useLiveStream(): LiveState {
  const [flow, setFlow] = useState<FlowSnapshot | null>(null);
  const [top, setTop] = useState<TopConsumer[]>([]);
  const [circuits, setCircuits] = useState<Circuit[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const es = new EventSource("/api/stream");

    const onJson = <T,>(setter: (v: T) => void) => (e: Event) => {
      if (cancelled) return;
      setConnected(true);
      setError(null);
      try {
        setter(JSON.parse((e as MessageEvent).data) as T);
      } catch {
        /* ignore malformed frame */
      }
    };

    es.addEventListener("flow", onJson(setFlow));
    es.addEventListener("top", onJson(setTop));
    es.addEventListener("circuits", onJson(setCircuits));
    es.addEventListener("stream-error", (e) => {
      if (!cancelled) setError((e as MessageEvent).data);
    });
    es.onerror = () => {
      if (!cancelled) setConnected(false); // EventSource auto-reconnects
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  return { flow, top, circuits, connected, error };
}

export interface StatsResponse {
  range: StatRange | "custom";
  series: EnergySeries;
  soc?: { ts: string; soc: number | null }[];
}

export function statsKey(
  source: StatSource,
  range: StatRange | "custom",
  custom?: { from: string; to: string },
): string {
  if (range === "custom" && custom) {
    return `/api/stats?source=${source}&from=${encodeURIComponent(custom.from)}&to=${encodeURIComponent(custom.to)}`;
  }
  return `/api/stats?source=${source}&range=${range}`;
}

export function useStats(
  source: StatSource,
  range: StatRange | "custom",
  custom?: { from: string; to: string },
  enabled = true,
) {
  return useSWR<StatsResponse>(enabled ? statsKey(source, range, custom) : null, fetcher, {
    refreshInterval: range === "today" ? 30_000 : 0,
    keepPreviousData: true,
  });
}

export function useCircuitStats(
  id: string | null,
  range: StatRange | "custom",
  custom?: { from: string; to: string },
  enabled = true,
) {
  const params =
    range === "custom" && custom
      ? `from=${encodeURIComponent(custom.from)}&to=${encodeURIComponent(custom.to)}`
      : `range=${range}`;
  const key = enabled && id ? `/api/circuit-stats?id=${encodeURIComponent(id)}&${params}` : null;
  return useSWR<{ range: StatRange | "custom"; series: EnergySeries }>(key, fetcher, {
    refreshInterval: range === "today" ? 30_000 : 0,
    keepPreviousData: true,
  });
}

export function useCircuitEnergy(
  range: StatRange | "custom",
  custom?: { from: string; to: string },
) {
  const key =
    range === "custom" && custom
      ? `/api/circuit-energy?from=${encodeURIComponent(custom.from)}&to=${encodeURIComponent(custom.to)}`
      : `/api/circuit-energy?range=${range}`;
  return useSWR<{ circuits: CircuitEnergy[] }>(key, fetcher, {
    keepPreviousData: true,
  });
}
