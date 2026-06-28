import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/getRepository";
import { BadRequestError, jsonError, parseStatsQuery } from "@/lib/api";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cfg = config();
  let query;
  try {
    query = parseStatsQuery(request.nextUrl.searchParams, new Date(), cfg.timezone);
  } catch (err) {
    if (err instanceof BadRequestError) return jsonError(err.message, 400);
    throw err;
  }

  try {
    const repo = getRepository();
    const series = await repo.getEnergySeries(query.source, query.window);
    // The battery view overlays a state-of-charge timeline.
    const soc =
      query.source === "battery"
        ? await repo.getSocSeries(query.window)
        : undefined;
    return Response.json({ range: query.range, series, soc });
  } catch (err) {
    return jsonError(
      `Failed to read stats: ${err instanceof Error ? err.message : "unknown"}`,
      502,
    );
  }
}
