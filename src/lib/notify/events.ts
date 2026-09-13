/**
 * What a notification can say, and nothing else.
 *
 * Pure: no I/O, no config, so both the watcher (which decides *when*) and the
 * sender (which decides *how*) share one vocabulary and the wording lives in
 * exactly one place. Keep it terse — this is read off a lock screen.
 */

export type NotifyEvent =
  | { kind: "DATA_STALE"; ageSeconds: number; table?: string }
  | { kind: "DATA_RESUMED" }
  | { kind: "GRID_DOWN" }
  | { kind: "GRID_RESTORED" }
  | { kind: "BATTERY_LOW"; soc: number };

/** The shape the service worker is handed. Kept flat: `sw.js` is plain JS. */
export interface PushPayload {
  title: string;
  body: string;
  /** Same-origin path to open on tap. */
  path: string;
  /**
   * Collapses related notifications on the lock screen: a recovery carries the
   * same tag as the outage it ends, so it replaces it rather than stacking.
   */
  tag: string;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

export function payloadFor(event: NotifyEvent): PushPayload {
  switch (event.kind) {
    case "DATA_STALE":
      return {
        title: "Powerflow: collector may be down",
        body: `No new data for ${formatAge(event.ageSeconds)}${event.table ? ` (${event.table})` : ""}.`,
        path: "/",
        tag: "data",
      };
    case "DATA_RESUMED":
      return { title: "Powerflow: data resumed", body: "The collector is writing again.", path: "/", tag: "data" };
    case "GRID_DOWN":
      return { title: "Grid power is out", body: "The panel is running on the battery.", path: "/", tag: "grid" };
    case "GRID_RESTORED":
      return { title: "Grid power is back", body: "The panel is back on the grid.", path: "/", tag: "grid" };
    case "BATTERY_LOW":
      return {
        title: "Battery is low",
        body: `State of charge is ${Math.round(event.soc)}%.`,
        path: "/",
        tag: "battery",
      };
  }
}

/** Sent by the "send a test" button. Its own tag, so a test can't replace a real alert. */
export const TEST_PAYLOAD: PushPayload = {
  title: "Powerflow",
  body: "Notifications are working.",
  path: "/",
  tag: "test",
};
