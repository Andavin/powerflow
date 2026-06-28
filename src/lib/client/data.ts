"use client";

import { useEffect, useRef, useState } from "react";
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

export interface FlowState {
  flow: FlowSnapshot | null;
  connected: boolean;
  error: string | null;
}

/**
 * Live flow via Server-Sent Events, with an automatic polling fallback if the
 * stream is unavailable (e.g. behind a buffering proxy).
 */
export function useFlowStream(): FlowState {
  const [flow, setFlow] = useState<FlowSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    const startPolling = () => {
      if (pollRef.current) return;
      const poll = async () => {
        try {
          const res = await fetch("/api/flow");
          if (!res.ok) throw new Error(String(res.status));
          if (!cancelled) {
            setFlow(await res.json());
            setError(null);
          }
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : "offline");
        }
      };
      void poll();
      pollRef.current = setInterval(poll, 3000);
    };

    try {
      es = new EventSource("/api/stream");
      es.addEventListener("flow", (e) => {
        if (cancelled) return;
        setConnected(true);
        setError(null);
        try {
          setFlow(JSON.parse((e as MessageEvent).data));
        } catch {
          /* ignore malformed frame */
        }
      });
      es.addEventListener("stream-error", (e) => {
        if (!cancelled) setError((e as MessageEvent).data);
      });
      es.onerror = () => {
        if (cancelled) return;
        setConnected(false);
        // EventSource auto-reconnects; also start polling as a safety net.
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      es?.close();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return { flow, connected, error };
}

export function useCircuits() {
  return useSWR<{ circuits: Circuit[]; top: TopConsumer[] }>(
    "/api/circuits",
    fetcher,
    { refreshInterval: 5000, keepPreviousData: true },
  );
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
) {
  return useSWR<StatsResponse>(statsKey(source, range, custom), fetcher, {
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
