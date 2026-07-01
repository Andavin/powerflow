import type { EnergySeries } from "./types";

/**
 * Single source of truth for how a source's totals map to headline metrics:
 * battery reads as discharged (primary) / charged (secondary), grid as
 * imported / exported, and solar/home as a single generated / consumed figure.
 * Consumers own their own layout and label casing.
 */
export interface SourceMetric {
  kWh: number;
  label: string;
}

export function sourceMetrics(series: EnergySeries): {
  primary: SourceMetric;
  secondary?: SourceMetric;
} {
  const t = series.totals;
  switch (series.source) {
    case "battery":
      return {
        primary: { kWh: t.dischargedKWh ?? 0, label: "Discharged" },
        secondary: { kWh: t.chargedKWh ?? 0, label: "Charged" },
      };
    case "grid":
      return {
        primary: { kWh: t.importedKWh ?? 0, label: "Imported" },
        secondary: { kWh: t.exportedKWh ?? 0, label: "Exported" },
      };
    case "solar":
      return { primary: { kWh: t.kWh, label: "Generated" } };
    default:
      return { primary: { kWh: t.kWh, label: "Consumed" } };
  }
}

/** The headline kWh for a source (what a change % compares). */
export function headlineKWh(series?: EnergySeries): number {
  return series ? sourceMetrics(series).primary.kWh : 0;
}
