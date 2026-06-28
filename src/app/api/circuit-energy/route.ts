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
    const circuits = await getRepository().getCircuitEnergy(query.window);
    return Response.json({ range: query.range, window: query.window, circuits });
  } catch (err) {
    return jsonError(
      `Failed to read circuit energy: ${err instanceof Error ? err.message : "unknown"}`,
      502,
    );
  }
}
