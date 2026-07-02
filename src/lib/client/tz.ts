import { civilParts, wallTimeToUtc, customWindow, type TimeWindow } from "@/lib/time";

/** The panel's civil timezone (matches the server default). */
export const PANEL_TZ = "America/Denver";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local "today" in the panel timezone as a YYYY-MM-DD string. */
export function todayStr(now: Date = new Date()): string {
  const c = civilParts(now, PANEL_TZ);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}`;
}

/** Shift a YYYY-MM-DD string by whole days. */
export function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Convert an inclusive YYYY-MM-DD..YYYY-MM-DD range to a UTC window. */
export function dayRangeWindow(fromStr: string, toStr: string): TimeWindow {
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  const from = new Date(wallTimeToUtc(PANEL_TZ, fy, fm, fd));
  const to = new Date(wallTimeToUtc(PANEL_TZ, ty, tm, td + 1)); // exclusive end
  return customWindow(from, to);
}
