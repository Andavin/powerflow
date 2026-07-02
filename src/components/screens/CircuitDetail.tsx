"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Card, Spinner, StatNumber, StatusPill } from "@/components/primitives";
import { StatsChart } from "@/components/charts/StatsChart";
import {
  CompareLegend,
  CompareToggle,
  PeriodControls,
  usePeriodSelector,
} from "@/components/PeriodControls";
import { useCircuitStats, useLiveStream } from "@/lib/client/data";
import { periodLabel, type Mode } from "@/lib/period";
import { splitEnergy, splitPower } from "@/lib/format";
import { SOURCE_COLOR } from "@/lib/palette";
import type { Circuit } from "@/lib/types";

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
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Move focus into the dialog and restore it to the previously-focused
    // control (usually the ON/OFF button) when the dialog closes.
    const opener = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => {
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap Tab between Cancel and Confirm so focus can't leave onto the
      // live ON/OFF buttons underneath.
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        // Backdrop click cancels; clicks inside the card do not bubble here.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <Card
        as="div"
        className="w-full max-w-sm p-5"
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
        >
          <h3 id={titleId} className="text-lg font-semibold">{title}</h3>
          <p id={bodyId} className="mt-1 text-sm text-muted">{body}</p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              ref={cancelRef}
              onClick={onCancel}
              className="rounded-lg px-4 py-2 text-sm text-muted transition hover:text-fg"
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
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
    return <StatusPill on={circuit.isOn} />;
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
  const sel = usePeriodSelector();
  const { range, offset, compare, isCustom, noun, win, prev } = sel;

  // Keep the live 30s refresh only for the current preset period.
  const { data, isLoading } = useCircuitStats(
    id,
    sel.isPresetNow ? range : "custom",
    sel.isPresetNow ? undefined : { from: win.from, to: win.to },
  );
  // Only fetch the previous period when the comparison is switched on.
  const { data: prevData } = useCircuitStats(id, "custom", prev, compare);

  const total = data?.series.totals.kWh ?? 0;
  const prevTotal = prevData?.series.totals.kWh ?? 0;
  const delta = compare && prevTotal > 0 ? (total - prevTotal) / prevTotal : null;
  const t = splitEnergy(total);
  const live = circuit ? splitPower(circuit.watts) : null;

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
        : `used in ${periodLabel(range as Exclude<Mode, "custom">, offset, win.from, win.to)}`;
  const vsLabel = isCustom ? "previous period" : offset === 0 ? `last ${noun}` : `previous ${noun}`;

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

      <PeriodControls sel={sel} />
      <CompareToggle sel={sel} />

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
            {compare && <CompareLegend noun={noun} color={SOURCE_COLOR.home} />}
          </>
        )}
      </Card>
    </div>
  );
}
