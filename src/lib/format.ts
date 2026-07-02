/** Presentation helpers: power, energy, and percentages. Pure + tested. */

export interface ValueUnit {
  value: string;
  unit: string;
}

/**
 * Format instantaneous power, auto-scaling W → kW.
 * 940 -> { "940", "W" }, 3965 -> { "3.97", "kW" }, 12000 -> { "12.0", "kW" }.
 */
export function splitPower(watts: number): ValueUnit {
  const abs = Math.abs(watts);
  if (abs < 1000) return { value: String(Math.round(watts)), unit: "W" };
  const kw = watts / 1000;
  const decimals = Math.abs(kw) >= 10 ? 1 : 2;
  return { value: kw.toFixed(decimals), unit: "kW" };
}

/**
 * Always-kW power label, up to one decimal with a trailing ".0" trimmed
 * (e.g. 5.0 -> "5", 6.5 -> "6.5"). Used by the flow overview so the four
 * source/home readings never flip between W and kW.
 */
export function splitKw(watts: number): ValueUnit {
  const value = (watts / 1000).toFixed(1).replace(/\.0$/, "");
  return { value, unit: "kW" };
}

/** Integer watts with thousands separators, e.g. "3,965 W". */
export function formatWatts(watts: number): string {
  return `${Math.round(watts).toLocaleString("en-US")} W`;
}

/**
 * Format energy, auto-scaling kWh → MWh.
 * >=10 kWh shows whole numbers (matches the panel app), below shows one decimal.
 */
export function splitEnergy(kWh: number): ValueUnit {
  const abs = Math.abs(kWh);
  if (abs >= 1000) return { value: (kWh / 1000).toFixed(1), unit: "MWh" };
  if (abs >= 10) return { value: String(Math.round(kWh)), unit: "kWh" };
  if (abs === 0) return { value: "0", unit: "kWh" };
  return { value: kWh.toFixed(1), unit: "kWh" };
}

export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}
