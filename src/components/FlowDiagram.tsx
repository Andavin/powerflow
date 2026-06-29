"use client";

import { useEffect, useRef } from "react";
import type { FlowSnapshot } from "@/lib/types";
import { SOURCE_COLOR, SOURCE_DIM } from "@/lib/palette";
import { SolarIcon, GridIcon, BatteryIcon, HomeIcon } from "./icons";
import { splitPower } from "@/lib/format";

interface LegConfig {
  id: string;
  d: string;
  color: string;
  dim: string;
  /** Signed power; positive = flows toward the panel/home (forward along d). */
  flow: number;
}

const ACTIVE_W = 15;

// A tapered "spindle" centred on the origin, long axis along +X; rotated to the
// conduit tangent at render time so it streaks along the direction of travel.
const SPINDLE = "M-14 0 Q0 4.2 14 0 Q0 -4.2 -14 0 Z";

/** Streak count and travel duration (seconds) from power magnitude. */
function streakParams(magnitude: number): { count: number; dur: number } {
  if (magnitude < ACTIVE_W) return { count: 0, dur: 0 };
  const count = magnitude > 2800 ? 2 : 1;
  const dur = Math.max(1.15, 2.7 - magnitude / 3200);
  return { count, dur };
}

interface StreakDef {
  key: string;
  legId: string;
  gradId: string;
  dur: number;
  forward: boolean;
  phase: number;
}

function SourceLabel({
  x,
  Icon,
  color,
  watts,
  sub,
}: {
  x: number;
  Icon: typeof SolarIcon;
  color: string;
  watts: number;
  sub?: string;
}) {
  const { value, unit } = splitPower(Math.abs(watts));
  return (
    <g>
      <svg x={x - 14} y={20} width={28} height={28} style={{ color }}>
        <Icon width={28} height={28} />
      </svg>
      <text x={x} y={66} textAnchor="middle" className="fill-fg" style={{ fontSize: 15, fontWeight: 600 }}>
        {value}
        <tspan style={{ fontSize: 10 }} className="fill-muted">
          {" "}
          {unit}
        </tspan>
      </text>
      {sub && (
        <text x={x} y={82} textAnchor="middle" className="fill-muted" style={{ fontSize: 11 }}>
          {sub}
        </text>
      )}
    </g>
  );
}

export function FlowDiagram({ flow }: { flow: FlowSnapshot }) {
  // The home leg is tinted by whichever source is supplying the most power.
  const supply = [
    { c: SOURCE_COLOR.solar, w: flow.solarW },
    { c: SOURCE_COLOR.grid, w: Math.max(0, flow.gridW) },
    { c: SOURCE_COLOR.battery, w: Math.max(0, flow.batteryW) },
  ].sort((a, b) => b.w - a.w);
  const homeColor = supply[0].w > 0 ? supply[0].c : SOURCE_COLOR.home;

  const legs: LegConfig[] = [
    { id: "pf-solar", d: "M56,96 C56,150 140,150 140,188", color: SOURCE_COLOR.solar, dim: SOURCE_DIM.solar, flow: flow.solarW },
    { id: "pf-grid", d: "M160,96 L160,188", color: SOURCE_COLOR.grid, dim: SOURCE_DIM.grid, flow: flow.gridW },
    { id: "pf-battery", d: "M264,96 C264,150 180,150 180,188", color: SOURCE_COLOR.battery, dim: SOURCE_DIM.battery, flow: flow.batteryW },
    { id: "pf-home", d: "M160,320 L160,404", color: homeColor, dim: SOURCE_DIM.home, flow: flow.homeW },
  ];

  const streaks: StreakDef[] = [];
  for (const leg of legs) {
    const mag = Math.abs(leg.flow);
    if (mag < ACTIVE_W) continue;
    const { count, dur } = streakParams(mag);
    for (let i = 0; i < count; i++) {
      streaks.push({
        key: `${leg.id}-${i}`,
        legId: leg.id,
        gradId: `${leg.id}-grad`,
        dur,
        forward: leg.flow >= 0,
        phase: i / count,
      });
    }
  }

  // Refs to the conduit paths (for geometry) and the streak shapes (to move).
  const conduitRefs = useRef<Record<string, SVGPathElement | null>>({});
  const streakRefs = useRef<Record<string, SVGPathElement | null>>({});
  // Latest streak config, read live by the animation loop so power changes
  // (which tweak `dur`) don't restart the animation. Updated in an effect, not
  // during render.
  const streaksRef = useRef<StreakDef[]>(streaks);
  useEffect(() => {
    streaksRef.current = streaks;
  });

  // Re-run the loop only when the *set* of streaks changes (a leg switching on
  // or off), not on every power tick.
  const streakKeys = streaks.map((s) => s.key).join("|");

  useEffect(() => {
    let raf = 0;
    let start: number | null = null; // captured from the first rAF timestamp
    const lengths: Record<string, number> = {};
    for (const id of Object.keys(conduitRefs.current)) {
      const el = conduitRefs.current[id];
      if (el) {
        try {
          lengths[id] = el.getTotalLength();
        } catch {
          /* not measurable yet */
        }
      }
    }

    const tick = (now: number) => {
      if (start === null) start = now;
      const t = (now - start) / 1000;
      for (const s of streaksRef.current) {
        const streakEl = streakRefs.current[s.key];
        const pathEl = conduitRefs.current[s.legId];
        const len = lengths[s.legId];
        if (!streakEl || !pathEl || !len) continue;
        let prog = ((t / s.dur) + s.phase) % 1;
        if (prog < 0) prog += 1;
        if (!s.forward) prog = 1 - prog;
        const dist = prog * len;
        const pt = pathEl.getPointAtLength(dist);
        const ahead = pathEl.getPointAtLength(Math.min(len, dist + 1.5));
        const ang = (Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180) / Math.PI;
        streakEl.setAttribute(
          "transform",
          `translate(${pt.x.toFixed(2)} ${pt.y.toFixed(2)}) rotate(${ang.toFixed(1)})`,
        );
        streakEl.style.opacity = "1";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [streakKeys]);

  const home = splitPower(flow.homeW);

  return (
    <svg
      viewBox="0 0 320 470"
      className="h-auto w-full max-w-[420px]"
      role="img"
      aria-label={`Energy flow: home ${flow.homeW} watts, solar ${flow.solarW}, grid ${flow.gridW}, battery ${flow.batteryW}`}
    >
      <defs>
        {/* Bright-core → colour → transparent fill so each streak glows in the
            middle and fades to its tapered ends. */}
        {legs.map((leg) => (
          <radialGradient key={leg.id} id={`${leg.id}-grad`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="35%" stopColor={leg.color} stopOpacity="1" />
            <stop offset="100%" stopColor={leg.color} stopOpacity="0" />
          </radialGradient>
        ))}
        <filter id="pf-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.7" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="pf-panel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fdfdfd" />
          <stop offset="1" stopColor="#c9cdd6" />
        </linearGradient>
      </defs>

      {/* Conduit guide lines */}
      {legs.map((leg) => {
        const active = Math.abs(leg.flow) >= ACTIVE_W;
        return (
          <path
            key={leg.id}
            ref={(el) => {
              conduitRefs.current[leg.id] = el;
            }}
            d={leg.d}
            fill="none"
            stroke={leg.dim}
            strokeOpacity={active ? 0.7 : 0.4}
            strokeWidth={2}
          />
        );
      })}

      {/* Travelling streaks (positioned by the rAF loop) */}
      {streaks.map((s) => (
        <path
          key={s.key}
          ref={(el) => {
            streakRefs.current[s.key] = el;
          }}
          className="pf-streak"
          d={SPINDLE}
          fill={`url(#${s.gradId})`}
          filter="url(#pf-glow)"
          style={{ opacity: 0 }}
        />
      ))}

      {/* Panel body */}
      <rect x={120} y={188} width={80} height={132} rx={16} fill="url(#pf-panel)" />
      <rect x={120} y={188} width={80} height={132} rx={16} fill="none" stroke="#ffffff" strokeOpacity={0.15} />
      <rect x={150} y={206} width={20} height={4} rx={2} fill="#9aa0ad" />

      <SourceLabel x={56} Icon={SolarIcon} color={SOURCE_COLOR.solar} watts={flow.solarW} />
      <SourceLabel x={160} Icon={GridIcon} color={SOURCE_COLOR.grid} watts={flow.gridW} sub={flow.gridW < 0 ? "exporting" : undefined} />
      <SourceLabel
        x={264}
        Icon={BatteryIcon}
        color={SOURCE_COLOR.battery}
        watts={flow.batteryW}
        sub={flow.batterySoc != null ? `${Math.round(flow.batterySoc)}%` : undefined}
      />

      {/* Home */}
      <svg x={146} y={408} width={28} height={28} style={{ color: SOURCE_COLOR.home }}>
        <HomeIcon width={28} height={28} />
      </svg>
      <text x={160} y={462} textAnchor="middle" className="fill-fg" style={{ fontSize: 16, fontWeight: 600 }}>
        {home.value}
        <tspan style={{ fontSize: 11 }} className="fill-muted">
          {" "}
          {home.unit}
        </tspan>
      </text>
    </svg>
  );
}
