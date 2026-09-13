import { jsonError } from "@/lib/api";
import { TEST_PAYLOAD } from "@/lib/notify/events";
import { getPushSender } from "@/lib/notify/service";
import { isAuthenticated } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Sends a test notification to every subscribed browser, so delivery can be
 * checked without waiting for a real outage. Push has a long, silent chain
 * (worker → permission → subscription → VAPID → Apple/Google → the OS); this
 * is the only way to see the whole thing work.
 */
export async function POST(): Promise<Response> {
  if (!(await isAuthenticated())) return jsonError("unauthorized", 401);
  const sender = getPushSender();
  if (!sender.configured) return jsonError("Push notifications are not configured on the server", 503);
  const sent = await sender.sendToAll(TEST_PAYLOAD);
  if (sent === 0) return jsonError("Nothing to send to — no browser is subscribed", 409);
  return Response.json({ ok: true, sent });
}
