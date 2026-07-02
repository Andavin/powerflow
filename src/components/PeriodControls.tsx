"use client";

import { type Dispatch, type SetStateAction, useState } from "react";
import { DateField, Segmented } from "@/components/primitives";
import { addDaysStr, todayStr } from "@/lib/client/tz";
import {
  RANGES,
  deriveWindows,
  periodLabel,
  periodNoun,
  type Mode,
  type Window,
} from "@/lib/period";
import type { TimeWindow } from "@/lib/time";

/**
 * State + derived windows for the shared period picker. Both the Stats screen
 * and the circuit-detail screen drive their charts from one of these.
 */
export interface PeriodSelector {
  range: Mode;
  offset: number;
  compare: boolean;
  fromC: string;
  toC: string;
  isCustom: boolean;
  /** day / week / month / year / period. */
  noun: string;
  /** The selected window. */
  win: TimeWindow;
  /** The period immediately before `win` (for comparison). */
  prev: Window;
  /** True for the live current preset period (offset 0, non-custom). */
  isPresetNow: boolean;
  pickRange: (value: Mode) => void;
  setOffset: Dispatch<SetStateAction<number>>;
  setCompare: Dispatch<SetStateAction<boolean>>;
  setFromC: (v: string) => void;
  setToC: (v: string) => void;
  setCustomDays: (n: number) => void;
}

export function usePeriodSelector(): PeriodSelector {
  const [range, setRange] = useState<Mode>("today");
  // Period offset for presets: 0 = current, -1 = previous, etc.
  const [offset, setOffset] = useState(0);
  const [compare, setCompare] = useState(false);
  const [fromC, setFromC] = useState(() => addDaysStr(todayStr(), -6));
  const [toC, setToC] = useState(() => todayStr());

  const now = new Date();
  const isCustom = range === "custom";
  const noun = periodNoun(range);
  const { win, prev } = deriveWindows(range, offset, fromC, toC, now);
  const isPresetNow = !isCustom && offset === 0;

  function pickRange(value: Mode) {
    setRange(value);
    setOffset(0);
  }

  function setCustomDays(n: number) {
    const today = todayStr();
    setFromC(addDaysStr(today, -(n - 1)));
    setToC(today);
  }

  return {
    range,
    offset,
    compare,
    fromC,
    toC,
    isCustom,
    noun,
    win,
    prev,
    isPresetNow,
    pickRange,
    setOffset,
    setCompare,
    setFromC,
    setToC,
    setCustomDays,
  };
}

/** Segmented range control plus either a custom-range picker or period nav. */
export function PeriodControls({ sel }: { sel: PeriodSelector }) {
  return (
    <>
      <Segmented options={RANGES} value={sel.range} onChange={sel.pickRange} size="sm" ariaLabel="Time range" />

      {/* Period navigation (presets) or a custom date range. */}
      {sel.isCustom ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-3">
            {/* Cross-constrain so From can't exceed To (which would yield an
                inverted, empty query). */}
            <DateField label="From" value={sel.fromC} onChange={sel.setFromC} max={sel.toC} />
            <DateField label="To" value={sel.toC} onChange={sel.setToC} min={sel.fromC} />
          </div>
          <div className="flex gap-2">
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                onClick={() => sel.setCustomDays(n)}
                className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-muted transition hover:bg-surface-3 hover:text-fg"
              >
                {n} days
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => sel.setOffset((o) => o - 1)}
            aria-label={`Previous ${sel.noun}`}
            className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm text-muted transition hover:bg-surface-3 hover:text-fg"
          >
            ←
          </button>
          <span className="text-sm font-medium tabular-nums">
            {periodLabel(sel.range as Exclude<Mode, "custom">, sel.offset, sel.win.from, sel.win.to)}
          </span>
          <button
            onClick={() => sel.setOffset((o) => Math.min(0, o + 1))}
            disabled={sel.offset >= 0}
            aria-label={`Next ${sel.noun}`}
            className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm text-muted transition hover:bg-surface-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
          >
            →
          </button>
        </div>
      )}
    </>
  );
}

/** Toggle button that turns the previous-period comparison on/off. */
export function CompareToggle({ sel }: { sel: PeriodSelector }) {
  return (
    <button
      onClick={() => sel.setCompare((v) => !v)}
      aria-pressed={sel.compare}
      className={`self-start rounded-full border px-3 py-1.5 text-xs transition ${
        sel.compare
          ? "border-transparent bg-surface-2 text-fg"
          : "border-border text-muted hover:text-fg"
      }`}
    >
      {sel.compare ? `✓ Comparing to previous ${sel.noun}` : `⇄ Compare to previous ${sel.noun}`}
    </button>
  );
}

/** Chart legend shown while comparing: this period (accent) vs previous (white). */
export function CompareLegend({ noun, color }: { noun: string; color: string }) {
  return (
    <div className="mt-3 flex justify-center gap-4 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
        This {noun}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-sm bg-white/40" />
        Previous {noun}
      </span>
    </div>
  );
}
