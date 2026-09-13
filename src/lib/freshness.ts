import type { PowerflowConfig } from "./config";
import { createQuestDbClient } from "./questdb";
import { freshnessSql } from "./sql";

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
 * Data-freshness probe shared by the in-page banner's route and the push
 * watcher. Reports the oldest "latest write" across the collector's
 * every-cycle tables; `stale` once that is at least a minute old, or when the
 * database can't be reached at all. Never throws.
 */
export async function checkFreshness(cfg: PowerflowConfig, now = Date.now()): Promise<FreshnessResult> {
  // No database in mock mode — nothing to watch, never stale.
  if (cfg.dataMode === "mock") return { stale: false, mock: true };

  try {
    const client = createQuestDbClient(cfg.questdbUrl);
    const rows = await client.query(freshnessSql());

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
    if (!oldest) return { stale: false };
    return {
      stale: oldest.ageMs >= STALE_MS,
      table: oldest.table,
      ageSeconds: Math.round(oldest.ageMs / 1000),
    };
  } catch (err) {
    // Can't reach QuestDB — that's itself worth surfacing to the operator.
    return { stale: true, error: err instanceof Error ? err.message : "freshness check failed" };
  }
}
