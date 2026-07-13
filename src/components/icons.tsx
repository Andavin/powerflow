import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

export function SolarIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3v18" />
      <path d="M6 7h12M7 11h10M8 15h8" />
      <path d="m9 7-2 4M15 7l2 4M10 11l-1.5 4M14 11l1.5 4" />
    </svg>
  );
}

export function BatteryIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="6" y="3.5" width="12" height="17" rx="2.4" />
      <path d="M10 3.5V2.5h4v1" />
      <path d="M9.5 12.5h5l-2 4 4-6h-5l2-4-4 6Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10.5V20h12v-9.5" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}

export function FlowNavIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3v7M12 14v7" />
      <path d="m8.5 6.5 3.5-3.5 3.5 3.5M8.5 17.5 12 21l3.5-3.5" />
    </svg>
  );
}

export function CircuitsNavIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.6" />
      <rect x="14" y="3" width="7" height="7" rx="1.6" />
      <rect x="3" y="14" width="7" height="7" rx="1.6" />
      <rect x="14" y="14" width="7" height="7" rx="1.6" />
    </svg>
  );
}

export function StatsNavIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5 21V10M12 21V4M19 21v-7" />
    </svg>
  );
}

export function OverviewNavIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="8" height="10" rx="1.6" />
      <rect x="3" y="16" width="8" height="5" rx="1.6" />
      <rect x="13" y="3" width="8" height="5" rx="1.6" />
      <rect x="13" y="11" width="8" height="10" rx="1.6" />
    </svg>
  );
}

export const SOURCE_ICON = {
  home: HomeIcon,
  solar: SolarIcon,
  battery: BatteryIcon,
  grid: GridIcon,
} as const;
