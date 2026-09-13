import { config } from "../config";
import { checkFreshness } from "../freshness";
import { getLiveSource } from "../live/getLiveSource";
import { PushSender, vapidFrom } from "./push";
import { SubscriptionStore } from "./store";
import { runWatcher } from "./watcher";

/** How often the watcher re-runs the freshness probe. */
const FRESHNESS_INTERVAL_MS = 60_000;

let sender: PushSender | null = null;
let store: SubscriptionStore | null = null;
let watcherStarted = false;

/** Process-wide subscription store, shared by the routes and the sender. */
export function getSubscriptionStore(): SubscriptionStore {
  return (store ??= new SubscriptionStore(config().notify.dataDir));
}

/** Process-wide sender; a no-op until VAPID keys are configured. */
export function getPushSender(): PushSender {
  return (sender ??= new PushSender(vapidFrom(config().notify), getSubscriptionStore()));
}

/**
 * Starts the background watcher once per process (from instrumentation.ts).
 * In live mode this eagerly opens the MQTT feed, which until now only ran
 * while a browser was streaming; without MQTT configured there is nothing to
 * watch, so it logs and leaves the rest of the app alone.
 */
export function startNotifyWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  const cfg = config();
  let live;
  try {
    live = getLiveSource();
  } catch (err) {
    console.warn("[powerflow:notify] watcher not started:", err instanceof Error ? err.message : err);
    return;
  }

  runWatcher({
    live,
    checkFreshness: () => checkFreshness(cfg),
    send: (payload) => getPushSender().sendToAll(payload),
    opts: { batteryLowPercent: cfg.notify.batteryLowPercent, staleAfterMs: cfg.notify.staleAfterMs },
    freshnessIntervalMs: FRESHNESS_INTERVAL_MS,
  });
  console.log(
    `[powerflow:notify] watcher started (push ${getPushSender().configured ? "configured" : "not configured — no VAPID keys"})`,
  );
}
