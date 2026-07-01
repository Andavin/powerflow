"use client";

import type { ReactNode } from "react";
import { todayStr } from "@/lib/client/tz";

export function Card({
  children,
  className = "",
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag
      className={`rounded-2xl border border-border bg-surface ${className}`}
    >
      {children}
    </Tag>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/** Pill-style segmented control (the Today/Week/Month/Year + source tabs). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  const pad = size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex w-full rounded-full bg-surface-2 p-1"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`flex-1 whitespace-nowrap rounded-full text-center font-medium transition ${pad} ${
              active
                ? "bg-surface-3 text-fg shadow"
                : "text-muted hover:text-fg"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function StatNumber({
  value,
  unit,
  color,
  className = "",
}: {
  value: string;
  unit: string;
  color?: string;
  className?: string;
}) {
  return (
    <span className={`tabular-nums ${className}`} style={color ? { color } : undefined}>
      <span className="font-semibold tracking-tight">{value}</span>
      <span className="ml-0.5 text-[0.6em] font-medium text-muted">{unit}</span>
    </span>
  );
}

/** Labelled date picker for the custom-range controls. */
export function DateField({
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

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-battery ${className}`}
    />
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-xl border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
      {message}
    </p>
  );
}
