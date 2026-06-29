"use client";

import { useEffect, useRef } from "react";
import type { FlowSnapshot } from "@/lib/types";
import { SOURCE_COLOR, SOURCE_DIM } from "@/lib/palette";
import { SolarIcon, GridIcon, BatteryIcon, HomeIcon } from "./icons";
import { splitKw } from "@/lib/format";

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

// Higher = slower. The travel duration scales by this; ~70% of the old speed.
const SPEED_SCALE = 1.43;

/** Travel duration (seconds) for one trip along a conduit. */
function streakDuration(magnitude: number): number {
  return Math.max(1.15, 2.7 - magnitude / 3200) * SPEED_SCALE;
}

/**
 * Opacity along the trip: fades in at the source, full through the middle,
 * fades out into the node. This hides the wrap (no "pop") and reads as the
 * light flowing into the panel/source rather than snapping back.
 */
function edgeFade(p: number): number {
  const f = 0.18;
  if (p < f) return p / f;
  if (p > 1 - f) return (1 - p) / f;
  return 1;
}

interface StreakDef {
  key: string;
  legId: string;
  gradId: string;
  dur: number;
  forward: boolean;
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
  const { value, unit } = splitKw(Math.abs(watts));
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

  // One streak per active leg (no trains of lights).
  const streaks: StreakDef[] = legs
    .filter((leg) => Math.abs(leg.flow) >= ACTIVE_W)
    .map((leg) => ({
      key: leg.id,
      legId: leg.id,
      gradId: `${leg.id}-grad`,
      dur: streakDuration(Math.abs(leg.flow)),
      forward: leg.flow >= 0,
    }));

  const conduitRefs = useRef<Record<string, SVGPathElement | null>>({});
  const streakRefs = useRef<Record<string, SVGPathElement | null>>({});
  // Latest streak config + per-streak progress, read live by one persistent
  // animation loop — so data refreshes never restart it and duration changes
  // (from power changes / slowdown) apply smoothly.
  const streaksRef = useRef<StreakDef[]>(streaks);
  const progressRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    streaksRef.current = streaks;
  });

  // Single rAF loop for the component's lifetime — never torn down on updates.
  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const lengths: Record<string, number> = {};

    const tick = (now: number) => {
      const dt = last === null ? 0 : (now - last) / 1000;
      last = now;
      const progress = progressRef.current;
      const live = new Set<string>();

      for (const s of streaksRef.current) {
        live.add(s.key);
        const streakEl = streakRefs.current[s.key];
        const pathEl = conduitRefs.current[s.legId];
        if (!streakEl || !pathEl) continue;
        let len = lengths[s.legId];
        if (!len) {
          try {
            len = lengths[s.legId] = pathEl.getTotalLength();
          } catch {
            continue;
          }
        }

        // Integrate progress so a changing duration smoothly changes speed.
        let p = progress.get(s.key) ?? 0;
        p = (p + dt / s.dur) % 1;
        progress.set(s.key, p);

        const tp = s.forward ? p : 1 - p;
        const dist = tp * len;
        const pt = pathEl.getPointAtLength(dist);
        const ahead = pathEl.getPointAtLength(Math.min(len, dist + 1.5));
        const ang = (Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180) / Math.PI;
        streakEl.setAttribute(
          "transform",
          `translate(${pt.x.toFixed(2)} ${pt.y.toFixed(2)}) rotate(${ang.toFixed(1)})`,
        );
        streakEl.style.opacity = edgeFade(p).toFixed(3);
      }

      // Forget streaks that are no longer active so they restart cleanly later.
      for (const k of progress.keys()) if (!live.has(k)) progress.delete(k);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const home = splitKw(flow.homeW);

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
      <SourceLabel x={160} Icon={GridIcon} color={SOURCE_COLOR.grid} watts={flow.gridW} />
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
