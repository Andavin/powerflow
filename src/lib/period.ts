/**
 * Shared time-period selection: the Today/Week/Month/Year/Custom model used by
 * both the Stats screen and the single-circuit detail screen. Pure helpers here;
 * the React state + controls live in components/PeriodControls.tsx.
 */

import { resolveRange, type TimeWindow } from "@/lib/time";
import { PANEL_TZ, dayRangeWindow } from "@/lib/client/tz";
import type { StatRange } from "@/lib/types";

export type Mode = StatRange | "custom";
export type Window = { from: string; to: string };

export const RANGES = [
  { value: "today" as const, label: "Today" },
  { value: "week" as const, label: "Week" },
  { value: "month" as const, label: "Month" },
  { value: "year" as const, label: "Year" },
  { value: "custom" as const, label: "Custom" },
];

const PERIOD_NOUN: Record<StatRange, string> = {
  today: "day",
  week: "week",
  month: "month",
  year: "year",
};

/** Noun for the current mode ("period" for custom, else day/week/month/year). */
export function periodNoun(range: Mode): string {
  return range === "custom" ? "period" : PERIOD_NOUN[range];
}

function fmt(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PANEL_TZ, ...opts }).format(new Date(iso));
}

/** Human label for the period currently in view. */
export function periodLabel(range: StatRange, offset: number, from: string, to: string): string {
  switch (range) {
    case "today":
      if (offset === 0) return "Today";
      if (offset === -1) return "Yesterday";
      return fmt(from, { month: "short", day: "numeric", year: "numeric" });
    case "week": {
      const lastDay = new Date(new Date(to).getTime() - 86_400_000).toISOString();
      return `${fmt(from, { month: "short", day: "numeric" })} – ${fmt(lastDay, { month: "short", day: "numeric" })}`;
    }
    case "month":
      return fmt(from, { month: "long", year: "numeric" });
    case "year":
      return fmt(from, { year: "numeric" });
  }
}

/** The selected window plus the period immediately before it (for comparison). */
export function deriveWindows(
  range: Mode,
  offset: number,
  fromC: string,
  toC: string,
  now: Date,
): { win: TimeWindow; prev: Window } {
  const isCustom = range === "custom";
  // Belt-and-suspenders: the DateField cross-constrains min/max, but a
  // mid-render state transient could still hand us an inverted range. Swap
  // rather than blow up the query with a negative-duration window.
  const [lo, hi] = isCustom && fromC > toC ? [toC, fromC] : [fromC, toC];
  const win = isCustom ? dayRangeWindow(lo, hi) : resolveRange(range, now, PANEL_TZ, offset);
  const prev: Window = isCustom
    ? (() => {
        const dur = new Date(win.to).getTime() - new Date(win.from).getTime();
        return { from: new Date(new Date(win.from).getTime() - dur).toISOString(), to: win.from };
      })()
    : resolveRange(range, now, PANEL_TZ, offset - 1);
  return { win, prev };
}
