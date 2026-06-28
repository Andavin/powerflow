import { getRepository } from "@/lib/getRepository";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const flow = await getRepository().getFlow();
    return Response.json(flow);
  } catch (err) {
    return jsonError(
      `Failed to read live flow: ${err instanceof Error ? err.message : "unknown"}`,
      502,
    );
  }
}
