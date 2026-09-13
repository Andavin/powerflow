import { config } from "@/lib/config";
import { checkFreshness } from "@/lib/freshness";

export const dynamic = "force-dynamic";

/**
 * Data-freshness probe for the staleness banner; the client polls this once a
 * minute and shows a banner when `stale` is true. Requires auth (gated by the
 * proxy) — it runs a QuestDB query.
 */
export async function GET(): Promise<Response> {
  return Response.json(await checkFreshness(config()));
}
