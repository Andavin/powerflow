import type { StatRange, StatSource } from "./types";
import { customWindow, resolveRange, type TimeWindow } from "./time";

const SOURCES: StatSource[] = ["home", "solar", "battery", "grid"];
const RANGES: StatRange[] = ["today", "week", "month", "year"];

export interface StatsQuery {
  source: StatSource;
  window: TimeWindow;
  range: StatRange | "custom";
}

export class BadRequestError extends Error {}

export function parseSource(value: string | null): StatSource {
  if (value && (SOURCES as string[]).includes(value)) return value as StatSource;
  return "home";
}

/**
 * Resolve a stats query from URL params.
 *   ?source=solar&range=week
 *   ?source=home&from=2026-06-01T06:00:00Z&to=2026-06-08T06:00:00Z
 * Custom from/to takes precedence over range.
 */
export function parseStatsQuery(
  params: URLSearchParams,
  now: Date,
  tz: string,
): StatsQuery {
  const source = parseSource(params.get("source"));
  const from = params.get("from");
  const to = params.get("to");

  if (from || to) {
    if (!from || !to) {
      throw new BadRequestError("Both 'from' and 'to' are required for a custom range");
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestError("Invalid 'from'/'to' timestamp");
    }
    if (toDate.getTime() <= fromDate.getTime()) {
      throw new BadRequestError("'to' must be after 'from'");
    }
    return { source, window: customWindow(fromDate, toDate), range: "custom" };
  }

  const rangeParam = params.get("range");
  const range: StatRange =
    rangeParam && (RANGES as string[]).includes(rangeParam)
      ? (rangeParam as StatRange)
      : "today";
  return { source, window: resolveRange(range, now, tz), range };
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
