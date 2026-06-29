"use client";

import { useEffect, useRef } from "react";
import type { FlowSnapshot } from "@/lib/types";
import { SOURCE_COLOR, SOURCE_DIM } from "@/lib/palette";
import { SolarIcon, GridIcon, BatteryIcon, HomeIcon } from "./icons";
import { splitKw } from "@/lib/format";

interface LegConfig {
  id: string;
  d: string;
  dim: string;
  /** Signed power; positive = flows toward the panel/home (forward along d). */
  flow: number;
  /** Gradient the streak fills with (the home leg picks the dominant source). */
  gradId: string;
}

const ACTIVE_W = 15;

// A tapered "spindle" centred on the origin, long axis along +X; rotated to the
// conduit tangent at render time so it streaks along the direction of travel.
const SPINDLE = "M-14 0 Q0 4.2 14 0 Q0 -4.2 -14 0 Z";

// Uniform visual speed (pixels/second) for every streak, regardless of leg or
// power, so all the lights move at the same pace. Lower = calmer.
const SPEED_PX_PER_SEC = 46;

// Fixed per-colour streak gradients (bright-core → colour → transparent). Kept
// stable so React never recolours them mid-trip; the home streak switches
// between these imperatively at trip boundaries.
const GRADS = [
  { id: "pf-grad-solar", color: SOURCE_COLOR.solar },
  { id: "pf-grad-battery", color: SOURCE_COLOR.battery },
  { id: "pf-grad-grid", color: SOURCE_COLOR.grid },
  { id: "pf-grad-home", color: SOURCE_COLOR.home },
] as const;

/**
 * Opacity along the trip: fades in at the source, full through the middle,
 * fades out into the node. Hides the wrap (no "pop") and reads as the light
 * flowing into the panel/source rather than snapping back.
 */
function edgeFade(p: number): number {
  const f = 0.18;
  if (p < f) return p / f;
  if (p > 1 - f) return (1 - p) / f;
  return 1;
}

/** Per-leg live "intent", read by the animation loop. */
interface LegIntent {
  id: string;
  active: boolean;
  forward: boolean;
  gradId: string;
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
  // The home streak takes the colour of whichever source is supplying the most.
  const supply = [
    { grad: "pf-grad-solar", w: flow.solarW },
    { grad: "pf-grad-grid", w: Math.max(0, flow.gridW) },
    { grad: "pf-grad-battery", w: Math.max(0, flow.batteryW) },
  ].sort((a, b) => b.w - a.w);
  const homeGrad = supply[0].w > 0 ? supply[0].grad : "pf-grad-home";

  const legs: LegConfig[] = [
    { id: "pf-solar", d: "M56,96 C56,150 140,150 140,188", dim: SOURCE_DIM.solar, flow: flow.solarW, gradId: "pf-grad-solar" },
    { id: "pf-grid", d: "M160,96 L160,188", dim: SOURCE_DIM.grid, flow: flow.gridW, gradId: "pf-grad-grid" },
    { id: "pf-battery", d: "M264,96 C264,150 180,150 180,188", dim: SOURCE_DIM.battery, flow: flow.batteryW, gradId: "pf-grad-battery" },
    { id: "pf-home", d: "M160,320 L160,404", dim: SOURCE_DIM.home, flow: flow.homeW, gradId: homeGrad },
  ];

  // Live intent for every leg (a streak element exists for all four; the loop
  // gates whether each is running). A trip in progress always finishes its line
  // before going idle, even if the leg drops to zero mid-trip.
  const intents: LegIntent[] = legs.map((leg) => ({
    id: leg.id,
    active: Math.abs(leg.flow) >= ACTIVE_W,
    forward: leg.flow >= 0,
    gradId: leg.gradId,
  }));

  const conduitRefs = useRef<Record<string, SVGPathElement | null>>({});
  const streakRefs = useRef<Record<string, SVGPathElement | null>>({});
  // Single pending intent, read live by one persistent loop. Direction + colour
  // are latched for the in-progress trip so a mid-trip change never interrupts
  // it; the next trip adopts the current intent (or stops if no longer active).
  const intentsRef = useRef<LegIntent[]>(intents);
  const progressRef = useRef<Map<string, number>>(new Map());
  const dirRef = useRef<Map<string, boolean>>(new Map());
  const gradRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    intentsRef.current = intents;
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
      const dir = dirRef.current;
      const grad = gradRef.current;

      for (const it of intentsRef.current) {
        const streakEl = streakRefs.current[it.id];
        const pathEl = conduitRefs.current[it.id];
        if (!streakEl || !pathEl) continue;
        let len = lengths[it.id];
        if (!len) {
          try {
            len = lengths[it.id] = pathEl.getTotalLength();
          } catch {
            continue;
          }
        }

        let p = progress.get(it.id);
        if (p === undefined) {
          // Idle: start a trip only if the leg is currently flowing.
          if (!it.active) {
            streakEl.style.opacity = "0";
            continue;
          }
          p = 0;
          dir.set(it.id, it.forward);
          grad.set(it.id, it.gradId);
          streakEl.setAttribute("fill", `url(#${it.gradId})`);
        }

        // Constant pixels/second → uniform visual speed on every leg.
        p += (dt * SPEED_PX_PER_SEC) / len;
        if (p >= 1) {
          if (!it.active) {
            // Trip finished and the leg is no longer flowing → go idle now
            // (rather than stopping mid-line when it dropped to zero).
            progress.delete(it.id);
            dir.delete(it.id);
            grad.delete(it.id);
            streakEl.style.opacity = "0";
            continue;
          }
          // New trip: adopt the current direction/colour.
          p -= Math.floor(p);
          dir.set(it.id, it.forward);
          if (grad.get(it.id) !== it.gradId) {
            grad.set(it.id, it.gradId);
            streakEl.setAttribute("fill", `url(#${it.gradId})`);
          }
        }
        progress.set(it.id, p);

        const forward = dir.get(it.id) ?? it.forward;
        const tp = forward ? p : 1 - p;
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
        {GRADS.map((g) => (
          <radialGradient key={g.id} id={g.id} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="35%" stopColor={g.color} stopOpacity="1" />
            <stop offset="100%" stopColor={g.color} stopOpacity="0" />
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

      {/* Conduit guide lines + a streak element per leg (idle ones stay hidden) */}
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
      {legs.map((leg) => (
        <path
          key={leg.id}
          ref={(el) => {
            streakRefs.current[leg.id] = el;
          }}
          className="pf-streak"
          d={SPINDLE}
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
