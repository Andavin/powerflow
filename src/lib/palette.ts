import type { StatSource } from "./types";

/** Source colours, kept in sync with the CSS tokens in globals.css. */
export const SOURCE_COLOR: Record<StatSource, string> = {
  home: "#3b9bff",
  solar: "#ffce3a",
  battery: "#2ee6d6",
  grid: "#6c7bff",
};

export const SOURCE_DIM: Record<StatSource, string> = {
  home: "#1d4a78",
  solar: "#6b5a1c",
  battery: "#1b5d57",
  grid: "#2f3570",
};

export const SOURCE_LABEL: Record<StatSource, string> = {
  home: "Home",
  solar: "Solar",
  battery: "Battery",
  grid: "Grid",
};

// These mirror CSS tokens in globals.css (@theme) for the Recharts/SVG layer,
// which can't read Tailwind classes. Keep them in sync with that file:
//   NEGATIVE = --color-negative, AXIS = --color-faint,
//   GRID_LINE = --color-surface-3.
export const NEGATIVE = "#ff6b6b";
export const AXIS = "#5b616c";
export const GRID_LINE = "#23272f";
