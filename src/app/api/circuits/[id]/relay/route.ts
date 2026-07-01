import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { getLiveSource } from "@/lib/live/getLiveSource";
import { isAuthenticated } from "@/lib/session";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Toggle a circuit's breaker relay.
 *   POST /api/circuits/<id>/relay   body: { on: boolean }
 *
 * Guardrails, all enforced here (default-deny):
 *   - a valid session (the proxy also gates /api/*),
 *   - POWERFLOW_CONTROL_ENABLED must be on,
 *   - the circuit must exist in the live snapshot and be SPAN-controllable
 *     (relay settable AND not always-on).
 * On success we only publish the command; the panel echoes the resulting relay
 * state back through the normal live stream.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthenticated())) return jsonError("unauthorized", 401);

  const cfg = config();
  if (!cfg.controlEnabled) return jsonError("Breaker control is disabled", 403);

  const { id } = await ctx.params;
  if (!id) return jsonError("Missing circuit id", 400);

  let on: boolean;
  try {
    const body = (await request.json()) as { on?: unknown };
    if (typeof body?.on !== "boolean") {
      return jsonError("Body must be { on: boolean }", 400);
    }
    on = body.on;
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const source = getLiveSource();
  if (typeof source.setRelay !== "function") {
    return jsonError("Control is not available in this data mode", 503);
  }

  // Re-check controllability against the live snapshot, not the client's claim.
  const circuit = source.current()?.circuits.find((c) => c.id === id);
  if (!circuit) return jsonError("Unknown circuit (no live snapshot yet)", 409);
  if (!circuit.controllable) {
    return jsonError("This circuit is not controllable", 409);
  }

  const desired = on ? "CLOSED" : "OPEN";
  try {
    await source.setRelay(id, desired);
  } catch (err) {
    return jsonError(
      `Failed to send relay command: ${err instanceof Error ? err.message : "unknown"}`,
      502,
    );
  }
  return Response.json({ ok: true, id, desired });
}
