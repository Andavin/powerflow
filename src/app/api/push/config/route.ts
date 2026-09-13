import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * The VAPID public key the browser needs to subscribe, or null when push is
 * not configured (the prompt then never shows). Served at request time rather
 * than baked in with NEXT_PUBLIC_: the image is built once and configured per
 * deployment.
 */
export async function GET(): Promise<Response> {
  const { vapidPublicKey, vapidPrivateKey } = config().notify;
  const publicKey = vapidPublicKey && vapidPrivateKey ? vapidPublicKey : null;
  return Response.json({ publicKey });
}
