import { getRepository } from "@/lib/getRepository";
import { jsonError } from "@/lib/api";
import { topConsumers } from "@/lib/transform";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const circuits = await getRepository().getCircuits();
    return Response.json({
      circuits,
      top: topConsumers(circuits, 5),
    });
  } catch (err) {
    return jsonError(
      `Failed to read circuits: ${err instanceof Error ? err.message : "unknown"}`,
      502,
    );
  }
}
