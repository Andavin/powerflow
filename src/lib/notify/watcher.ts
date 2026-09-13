import type { FreshnessResult } from "../freshness";
import type { LiveSource } from "../live/types";
import { payloadFor, type NotifyEvent, type PushPayload } from "./events";
import { newWatchState, observeFreshness, observeSnapshot, type WatchOptions } from "./watch";

export interface WatcherDeps {
  /** The shared live feed; started eagerly so grid/SOC are watched with no browser open. */
  live: LiveSource;
  checkFreshness: () => Promise<FreshnessResult>;
  send: (payload: PushPayload) => Promise<unknown>;
  opts: WatchOptions;
  freshnessIntervalMs: number;
}

/**
 * The always-on loop: every live snapshot goes through the grid/battery
 * checks, and the freshness probe runs on a timer. Returns a stop function.
 *
 * Sends are fire-and-forget from the snapshot listener (it's called on the
 * MQTT client's event path and must not block); the sender itself never
 * throws, so nothing here needs a catch beyond the probe.
 */
export function runWatcher(deps: WatcherDeps): () => void {
  const state = newWatchState();
  const dispatch = (events: NotifyEvent[]) => {
    for (const event of events) void deps.send(payloadFor(event));
  };

  deps.live.ensureStarted();
  const unsubscribe = deps.live.subscribe((snapshot) => {
    dispatch(observeSnapshot(state, snapshot.flow, deps.opts));
  });

  let stopped = false;
  const timer = setInterval(async () => {
    try {
      const result = await deps.checkFreshness();
      if (!stopped) dispatch(observeFreshness(state, result, Date.now(), deps.opts));
    } catch (err) {
      console.error("[powerflow:notify] freshness probe failed", err);
    }
  }, deps.freshnessIntervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
}
