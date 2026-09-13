import { describe, it, expect, vi, afterEach } from "vitest";
import { runWatcher } from "./watcher";
import type { LiveSnapshot, LiveSource } from "../live/types";
import type { FreshnessResult } from "../freshness";
import type { PushPayload } from "./events";

function fakeLive(): LiveSource & { emit(gridState: string, soc: number): void } {
  const listeners = new Set<(s: LiveSnapshot) => void>();
  return {
    ensureStarted: vi.fn(),
    current: () => null,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit(gridState, soc) {
      const snap = {
        ts: "t",
        flow: { ts: "t", homeW: 0, solarW: 0, gridW: 0, batteryW: 0, batterySoc: soc, gridState, batteryConnected: true },
        top: [],
        circuits: [],
      } as LiveSnapshot;
      for (const l of listeners) l(snap);
    },
  };
}

const opts = { batteryLowPercent: 20, staleAfterMs: 5 * 60_000 };
let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe("runWatcher", () => {
  it("starts the live feed and pushes grid/battery transitions", async () => {
    const live = fakeLive();
    const sent: PushPayload[] = [];
    stop = runWatcher({
      live,
      checkFreshness: async () => ({ stale: false }),
      send: async (p) => void sent.push(p),
      opts,
      freshnessIntervalMs: 60_000,
    });
    expect(live.ensureStarted).toHaveBeenCalled();
    live.emit("PANEL_ON_GRID", 50);
    live.emit("PANEL_OFF_GRID", 15);
    await vi.waitFor(() => expect(sent.map((p) => p.tag)).toEqual(["grid", "battery"]));
    expect(sent[0].title).toMatch(/out/i);
  });

  it("polls freshness on the interval and pushes stale then resumed", async () => {
    vi.useFakeTimers();
    const results: FreshnessResult[] = [
      { stale: true, ageSeconds: 100 },
      { stale: true, ageSeconds: 400, table: "power_flows" },
      { stale: false },
    ];
    const sent: PushPayload[] = [];
    stop = runWatcher({
      live: fakeLive(),
      checkFreshness: async () => results.shift() ?? { stale: false },
      send: async (p) => void sent.push(p),
      opts,
      freshnessIntervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.map((p) => p.title)).toEqual(["Powerflow: collector may be down"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.map((p) => p.title)).toEqual(["Powerflow: collector may be down", "Powerflow: data resumed"]);
  });

  it("survives a probe that throws", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn(async () => {});
    stop = runWatcher({
      live: fakeLive(),
      checkFreshness: async () => {
        throw new Error("boom");
      },
      send,
      opts,
      freshnessIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(error).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("stops cleanly", async () => {
    vi.useFakeTimers();
    const live = fakeLive();
    const checkFreshness = vi.fn(async () => ({ stale: false }));
    const send = vi.fn(async () => {});
    const halt = runWatcher({ live, checkFreshness, send, opts, freshnessIntervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkFreshness).toHaveBeenCalledTimes(1);
    halt();
    await vi.advanceTimersByTimeAsync(5000);
    expect(checkFreshness).toHaveBeenCalledTimes(1);
    live.emit("PANEL_ON_GRID", 50);
    live.emit("PANEL_OFF_GRID", 50);
    expect(send).not.toHaveBeenCalled();
  });
});
