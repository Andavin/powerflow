import type { NotifyConfig } from "../config";
import type { PushPayload } from "./events";
import type { PushSubscriptionRecord } from "./store";

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** The configured VAPID pair, or null when push is off. */
export function vapidFrom(notify: NotifyConfig): VapidDetails | null {
  if (!notify.vapidPublicKey || !notify.vapidPrivateKey) return null;
  return { subject: notify.vapidSubject, publicKey: notify.vapidPublicKey, privateKey: notify.vapidPrivateKey };
}

/** What the sender needs from the store — kept narrow so tests can fake it. */
export interface SubscriptionSource {
  list(): Promise<PushSubscriptionRecord[]>;
  remove(endpoint: string): Promise<void>;
}

/** Statuses a push service returns once a browser has unsubscribed or been wiped. */
const GONE = new Set([404, 410]);

/**
 * Web Push delivery to every stored subscription.
 *
 * Never throws — the caller is the watcher loop, and a wiped phone must not
 * take it down. With no VAPID keys it sends nothing. Endpoints the push
 * service reports gone are deleted as they are found; there is no other
 * signal that a row is dead, and leaving them means a round trip per corpse
 * on every event forever.
 */
export class PushSender {
  constructor(
    private readonly vapid: VapidDetails | null,
    private readonly store: SubscriptionSource,
  ) {}

  get configured(): boolean {
    return this.vapid !== null;
  }

  /** Sends `payload` to every subscription; resolves to how many accepted it. */
  async sendToAll(payload: PushPayload): Promise<number> {
    if (!this.vapid) return 0;
    const subs = await this.store.list();
    if (subs.length === 0) return 0;

    // Loaded lazily: a deployment without keys shouldn't pay for its crypto tree.
    const webPush = (await import("web-push")).default;
    webPush.setVapidDetails(this.vapid.subject, this.vapid.publicKey, this.vapid.privateKey);

    const body = JSON.stringify(payload);
    let delivered = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webPush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
          delivered++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status !== undefined && GONE.has(status)) {
            await this.store.remove(sub.endpoint);
            return;
          }
          // A bad key pair rejects every send with a 403; silence would look like nothing was sent.
          console.error(`push: delivery failed (${status ?? "no status"})`, err);
        }
      }),
    );
    return delivered;
  }
}
