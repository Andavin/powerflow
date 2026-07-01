"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Segmented, Spinner, StatNumber } from "@/components/primitives";
import { StatsChart } from "@/components/charts/StatsChart";
import { useCircuitStats, useLiveStream } from "@/lib/client/data";
import { resolveRange } from "@/lib/time";
import { PANEL_TZ, addDaysStr, dayRangeWindow, todayStr } from "@/lib/client/tz";
import { splitEnergy, splitPower } from "@/lib/format";
import { SOURCE_COLOR } from "@/lib/palette";
import type { Circuit, StatRange } from "@/lib/types";

type Mode = StatRange | "custom";

const RANGES = [
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

function fmt(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PANEL_TZ, ...opts }).format(new Date(iso));
}

/** Human label for the period currently in view. */
function periodLabel(range: StatRange, offset: number, from: string, to: string): string {
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

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
      {label}
      <input
        type="date"
        value={value}
        max={todayStr()}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-battery"
      />
    </label>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <Card className="w-full max-w-sm p-5">
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-muted transition hover:text-fg">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              danger
                ? "bg-negative/20 text-negative hover:bg-negative/30"
                : "bg-positive/20 text-positive hover:bg-positive/30"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </Card>
    </div>
  );
}

/**
 * Inline relay control shown next to the live power. Read-only circuits (or
 * when control is disabled) just render the On/Off status pill; controllable
 * ones render an ON | OFF pill (green / red, active side full colour, inactive
 * dimmed) that opens a confirmation modal before switching.
 */
function RelayControl({ circuit, enabled }: { circuit: Circuit; enabled: boolean }) {
  // The side the user picked, awaiting confirmation.
  const [confirmTarget, setConfirmTarget] = useState<boolean | null>(null);
  // The isOn value we've commanded and are waiting for the panel to echo.
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const controllable = enabled && circuit.controllable;
  // Busy until the panel echoes the state we commanded (derived, so it clears
  // itself when the live stream catches up).
  const busy = pending !== null && circuit.isOn !== pending;
  const displayOn = busy ? (pending as boolean) : circuit.isOn;

  if (!controllable) {
    return (
      <span
        className={`rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          circuit.isOn ? "bg-positive/15 text-positive" : "bg-surface-3 text-faint"
        }`}
      >
        {circuit.isOn ? "ON" : "OFF"}
      </span>
    );
  }

  async function commit(target: boolean) {
    setConfirmTarget(null);
    setError(null);
    setPending(target);
    // Fallback so the control doesn't hang if the panel never echoes.
    const fallback = setTimeout(() => setPending(null), 12_000);
    try {
      const res = await fetch(`/api/circuits/${encodeURIComponent(circuit.id)}/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: target }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Request failed (${res.status})`);
      }
      // Leave `pending` set: the live stream confirms and `busy` clears itself.
    } catch (e) {
      clearTimeout(fallback);
      setPending(null);
      setError(e instanceof Error ? e.message : "Failed to send command");
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div
        role="group"
        aria-label={`${circuit.name} breaker`}
        className={`inline-flex overflow-hidden rounded-sm border border-border text-[10px] font-semibold uppercase tracking-wide ${
          busy ? "opacity-60" : ""
        }`}
      >
        <button
          onClick={() => setConfirmTarget(true)}
          disabled={busy || displayOn}
          aria-pressed={displayOn}
          className={`px-2 py-0.5 transition ${
            displayOn ? "bg-positive/20 text-positive" : "text-positive/40 hover:text-positive/80"
          }`}
        >
          ON
        </button>
        <button
          onClick={() => setConfirmTarget(false)}
          disabled={busy || !displayOn}
          aria-pressed={!displayOn}
          className={`px-2 py-0.5 transition ${
            !displayOn ? "bg-negative/20 text-negative" : "text-negative/40 hover:text-negative/80"
          }`}
        >
          OFF
        </button>
      </div>
      {error && <span className="max-w-[11rem] text-[10px] text-negative">{error}</span>}
      {confirmTarget !== null && (
        <ConfirmDialog
          title={`Turn ${confirmTarget ? "on" : "off"} ${circuit.name}?`}
          body={
            confirmTarget
              ? "This energizes the circuit."
              : "This cuts power to everything on this circuit."
          }
          confirmLabel={`Turn ${confirmTarget ? "on" : "off"}`}
          danger={!confirmTarget}
          onConfirm={() => commit(confirmTarget)}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}

export function CircuitDetail({ id, controlEnabled }: { id: string; controlEnabled: boolean }) {
  const { circuits } = useLiveStream();
  const circuit = circuits.find((c) => c.id === id);
  const [range, setRange] = useState<Mode>("today");
  // Period offset for presets: 0 = current, -1 = previous period, etc.
  const [offset, setOffset] = useState(0);
  const [compare, setCompare] = useState(false);
  const [fromC, setFromC] = useState(() => addDaysStr(todayStr(), -6));
  const [toC, setToC] = useState(() => todayStr());

  const now = new Date();
  const isCustom = range === "custom";
  // Selected window, plus the period immediately before it for the change indicator.
  const win = isCustom ? dayRangeWindow(fromC, toC) : resolveRange(range, now, PANEL_TZ, offset);
  const prev = isCustom
    ? (() => {
        const dur = new Date(win.to).getTime() - new Date(win.from).getTime();
        return { from: new Date(new Date(win.from).getTime() - dur).toISOString(), to: win.from };
      })()
    : resolveRange(range, now, PANEL_TZ, offset - 1);

  // Keep the live 30s refresh only for the current preset period.
  const isPresetNow = !isCustom && offset === 0;
  const { data, isLoading } = useCircuitStats(
    id,
    isPresetNow ? range : "custom",
    isPresetNow ? undefined : { from: win.from, to: win.to },
  );
  const { data: prevData } = useCircuitStats(id, "custom", prev);

  const total = data?.series.totals.kWh ?? 0;
  const prevTotal = prevData?.series.totals.kWh ?? 0;
  const delta = compare && prevTotal > 0 ? (total - prevTotal) / prevTotal : null;
  const t = splitEnergy(total);
  const live = circuit ? splitPower(circuit.watts) : null;

  const noun = isCustom ? "period" : PERIOD_NOUN[range];
  const usedWhen = isCustom
    ? "used this period"
    : offset === 0
      ? range === "today"
        ? "used today"
        : `used this ${noun}`
      : offset === -1
        ? range === "today"
          ? "used yesterday"
          : `used last ${noun}`
        : `used in ${periodLabel(range, offset, win.from, win.to)}`;
  const vsLabel = isCustom ? "previous period" : offset === 0 ? `last ${noun}` : `previous ${noun}`;

  function pickRange(value: Mode) {
    setRange(value);
    setOffset(0);
  }

  function setCustomDays(n: number) {
    const today = todayStr();
    setFromC(addDaysStr(today, -(n - 1)));
    setToC(today);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href="/circuits" className="text-sm text-muted hover:text-fg">
        ← Circuits
      </Link>

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{circuit?.name ?? id}</h1>
        {circuit && (
          <div className="flex items-center gap-3">
            <RelayControl circuit={circuit} enabled={controlEnabled} />
            {live && <StatNumber value={live.value} unit={live.unit} color={SOURCE_COLOR.home} className="text-lg" />}
          </div>
        )}
      </div>

      <Segmented options={RANGES} value={range} onChange={pickRange} size="sm" ariaLabel="Time range" />

      {/* Period navigation (presets) or a custom date range. */}
      {isCustom ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-3">
            <DateField label="From" value={fromC} onChange={setFromC} />
            <DateField label="To" value={toC} onChange={setToC} />
          </div>
          <div className="flex gap-2">
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                onClick={() => setCustomDays(n)}
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
            onClick={() => setOffset((o) => o - 1)}
            aria-label={`Previous ${noun}`}
            className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm text-muted transition hover:bg-surface-3 hover:text-fg"
          >
            ←
          </button>
          <span className="text-sm font-medium tabular-nums">{periodLabel(range, offset, win.from, win.to)}</span>
          <button
            onClick={() => setOffset((o) => Math.min(0, o + 1))}
            disabled={offset >= 0}
            aria-label={`Next ${noun}`}
            className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm text-muted transition hover:bg-surface-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
          >
            →
          </button>
        </div>
      )}

      {/* Compare toggle */}
      <button
        onClick={() => setCompare((v) => !v)}
        aria-pressed={compare}
        className={`self-start rounded-full border px-3 py-1.5 text-xs transition ${
          compare
            ? "border-transparent bg-surface-2 text-fg"
            : "border-border text-muted hover:text-fg"
        }`}
      >
        {compare ? `✓ Comparing to previous ${noun}` : `⇄ Compare to previous ${noun}`}
      </button>

      <Card className="p-5">
        {!data || isLoading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="mb-4">
              <StatNumber value={t.value} unit={t.unit} color={SOURCE_COLOR.home} className="text-4xl" />
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                <span>{usedWhen}</span>
                {delta != null && (
                  <span style={{ color: delta <= 0 ? SOURCE_COLOR.battery : SOURCE_COLOR.solar }}>
                    {delta > 0 ? "↑" : "↓"} {Math.abs(delta * 100).toFixed(0)}% vs {vsLabel}
                  </span>
                )}
              </div>
            </div>
            <StatsChart
              series={data.series}
              compare={compare ? prevData?.series : undefined}
              height={260}
            />
            {compare && (
              <div className="mt-3 flex justify-center gap-4 text-[11px] text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SOURCE_COLOR.home }} />
                  This {noun}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-white/40" />
                  Previous {noun}
                </span>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
