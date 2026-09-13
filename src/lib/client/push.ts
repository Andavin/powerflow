/**
 * Turning push on, from the browser's side.
 *
 * `enablePush` MUST be called from a user gesture: Safari rejects
 * `Notification.requestPermission()` otherwise, which is why the offer is a
 * card with a button rather than something that fires on load.
 */

export interface SubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type EnableResult = { ok: true } | { ok: false; reason: "DENIED" | "DISMISSED" | "FAILED" };

/** Remembered per browser; cleared by the login form so each sign-in asks again. */
const DISMISSED_KEY = "powerflow-push-dismissed";

export function isPushDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissPush(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage blocked: it'll simply be offered again next visit.
  }
}

export function clearPushDismissal(): void {
  try {
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Whether asking is even possible here. Conservative on purpose: every false
 * means "don't show the card", and a button that can't work is worse than
 * none. Push needs a secure context; on iOS, PushManager only exists once the
 * app has been added to the home screen.
 */
export function canOfferPush(): boolean {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  if (!("Notification" in window)) return false;
  return true;
}

export function pushPermission(): NotificationPermission | null {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  return Notification.permission;
}

/**
 * The VAPID public key (base64url) as the bytes `subscribe()` wants. Chrome
 * accepts the string; Safari and Firefox reject it with an empty error.
 */
export function decodeKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function subscribeAndSave(
  publicKey: string,
  save: (sub: SubscriptionKeys) => Promise<unknown>,
): Promise<void> {
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  // A first-ever registration is still installing here; wait for it.
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // A promise that every push shows a notification; Chrome revokes the
      // permission from a site that takes a push and shows nothing.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    }));
  const keys = subscription.toJSON().keys ?? {};
  await save({ endpoint: subscription.endpoint, p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" });
}

/** Registers the worker, asks, subscribes, and hands the subscription to `save`. */
export async function enablePush(
  publicKey: string,
  save: (sub: SubscriptionKeys) => Promise<unknown>,
): Promise<EnableResult> {
  try {
    const permission = await Notification.requestPermission();
    if (permission === "denied") return { ok: false, reason: "DENIED" };
    if (permission !== "granted") return { ok: false, reason: "DISMISSED" };
    await subscribeAndSave(publicKey, save);
    return { ok: true };
  } catch {
    return { ok: false, reason: "FAILED" };
  }
}

/**
 * When permission was granted earlier, re-post this browser's subscription so
 * the server's copy survives a wiped data volume. Quiet on failure — it's a
 * background repair, not something to interrupt anyone over.
 */
export async function resyncPush(publicKey: string, save: (sub: SubscriptionKeys) => Promise<unknown>): Promise<void> {
  if (pushPermission() !== "granted") return;
  try {
    await subscribeAndSave(publicKey, save);
  } catch {
    // Next load will try again.
  }
}
