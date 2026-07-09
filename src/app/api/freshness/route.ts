import { config } from "@/lib/config";
import { createQuestDbClient } from "@/lib/questdb";
import { freshnessSql } from "@/lib/sql";

export const dynamic = "force-dynamic";

/** Warn once the newest write in any sentinel table is at least this old. */
const STALE_MS = 60_000;

export interface FreshnessResult {
  stale: boolean;
  /** The sentinel table with the oldest latest-write, when known. */
  table?: string;
  /** Age of that oldest latest-write, in seconds. */
  ageSeconds?: number;
  /** Set when the check itself couldn't run (e.g. QuestDB unreachable). */
  error?: string;
  /** True in mock data mode, where there's no database to watch. */
  mock?: boolean;
}

/**
 * Data-freshness probe for the staleness banner. Reports the oldest "latest
 * write" across the collector's every-cycle tables; the client polls this once
 * a minute and shows a banner when `stale` is true. Requires auth (gated by the
 * proxy) — it runs a QuestDB query.
 */
export async function GET(): Promise<Response> {
  const cfg = config();

  // No database in mock mode — nothing to watch, never stale.
  if (cfg.dataMode === "mock") {
    return Response.json({ stale: false, mock: true } satisfies FreshnessResult);
  }

  try {
    const client = createQuestDbClient(cfg.questdbUrl);
    const rows = await client.query(freshnessSql());
    const now = Date.now();

    let oldest: { table: string; ageMs: number } | null = null;
    for (const r of rows) {
      const table = String(r.tbl);
      // A null max(ts) means the table has never been written — a fresh or
      // partial deployment, not stalled ingestion. Skip it so an unpopulated
      // sentinel can't pin the banner on forever. Staleness is about data that
      // WAS flowing and stopped, which surfaces as an aging (non-null) max(ts).
      if (!r.ts) continue;
      const ms = Date.parse(String(r.ts));
      if (!Number.isFinite(ms)) continue;
      const ageMs = now - ms;
      if (!oldest || ageMs > oldest.ageMs) oldest = { table, ageMs };
    }

    // No sentinel has any data yet (cold start): nothing to be stale about.
    if (!oldest) {
      return Response.json({ stale: false } satisfies FreshnessResult);
    }
    return Response.json({
      stale: oldest.ageMs >= STALE_MS,
      table: oldest.table,
      ageSeconds: Math.round(oldest.ageMs / 1000),
    } satisfies FreshnessResult);
  } catch (err) {
    // Can't reach QuestDB — that's itself worth surfacing to the operator.
    return Response.json({
      stale: true,
      error: err instanceof Error ? err.message : "freshness check failed",
    } satisfies FreshnessResult);
  }
}
