import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/getRepository";
import { BadRequestError, jsonError, parseStatsQuery } from "@/lib/api";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Energy over time for one circuit.
 *   ?id=<circuitId>&range=today|week|month|year
 *   ?id=<circuitId>&from=…&to=…
 */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Missing circuit id", 400);

  const cfg = config();
  let query;
  try {
    query = parseStatsQuery(request.nextUrl.searchParams, new Date(), cfg.timezone);
  } catch (err) {
    if (err instanceof BadRequestError) return jsonError(err.message, 400);
    throw err;
  }

  try {
    const series = await getRepository().getCircuitSeries(id, query.window);
    return Response.json({ range: query.range, series });
  } catch (err) {
    return jsonError(
      `Failed to read circuit stats: ${err instanceof Error ? err.message : "unknown"}`,
      502,
    );
  }
}
