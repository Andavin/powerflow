"use client";

import Link from "next/link";
import { FlowDiagram } from "@/components/FlowDiagram";
import { Card, LiveDot, Spinner, StatNumber } from "@/components/primitives";
import { useLiveStream } from "@/lib/client/data";
import { formatWatts, formatPercent, splitPower } from "@/lib/format";
import { SOURCE_COLOR } from "@/lib/palette";

function flowCaption(
  flow: { solarW: number; gridW: number; batteryW: number },
): string | null {
  const parts: string[] = [];
  if (flow.gridW < -20) parts.push("Exporting solar to the grid");
  if (flow.batteryW < -20) parts.push("Charging the battery");
  if (flow.solarW > 20 && flow.batteryW > 20) parts.push("Solar and battery powering the home");
  if (parts.length === 0 && flow.solarW > 20) return "Solar powering the home";
  return parts[0] ?? null;
}

export function FlowScreen() {
  const { flow, top, connected, error } = useLiveStream();

  if (!flow) {
    return (
      <div className="flex h-[60dvh] items-center justify-center">
        {error ? (
          <p className="text-muted">Waiting for live data…</p>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  const caption = flowCaption(flow);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <div className="flex flex-col items-center pt-2">
        <div className="flex h-5 items-center gap-2 text-xs text-muted">
          <LiveDot connected={connected} />
          {caption && <span className="text-faint">·</span>}
          {caption && <span>{caption}</span>}
        </div>
        <FlowDiagram flow={flow} />
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-muted">
          What&apos;s using the most power right now
        </h2>
        {top.length === 0 ? (
          <p className="py-6 text-center text-sm text-faint">Nothing drawing power.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {top.map((c) => {
              const p = splitPower(c.watts);
              return (
                <li key={c.id}>
                  <Link
                    href={`/circuits/${encodeURIComponent(c.id)}`}
                    className="flex items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 transition hover:bg-surface-3"
                  >
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="text-sm font-medium" style={{ color: SOURCE_COLOR.home }}>
                      {formatPercent(c.share)}
                    </span>
                    <span className="w-20 text-right tabular-nums">
                      <StatNumber value={p.value} unit={p.unit} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {top.length > 0 && (
          <p className="mt-3 text-right text-xs text-faint">
            {formatWatts(top.reduce((s, c) => s + c.watts, 0))} across top circuits
          </p>
        )}
      </Card>
    </div>
  );
}
