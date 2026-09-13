import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/api";
import { getSubscriptionStore } from "@/lib/notify/service";
import { parseSubscription } from "@/lib/notify/store";
import { isAuthenticated } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Records this browser's push subscription.
 *   POST /api/push/subscribe   body: { endpoint, p256dh, auth }
 * Idempotent per endpoint, so the client can re-post on every load to heal a
 * wiped data volume.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!(await isAuthenticated())) return jsonError("unauthorized", 401);
  const sub = parseSubscription(await request.json().catch(() => null));
  if (!sub) return jsonError("Body must be { endpoint: https-url, p256dh, auth }", 400);
  await getSubscriptionStore().upsert(sub);
  return Response.json({ ok: true });
}

