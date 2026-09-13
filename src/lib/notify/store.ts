import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One browser's push subscription, as `PushManager.subscribe()` hands it over. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

const FILE_NAME = "push-subscriptions.json";

/**
 * Push subscriptions on disk — a JSON array in `<dataDir>/push-subscriptions.json`.
 *
 * Powerflow has no database of its own (QuestDB is append-only and a poor fit
 * for a handful of rows that need deleting), and there is one operator, so a
 * file keyed on endpoint is the whole model. Writes go through a temp file and
 * a rename so a crash mid-write can't leave a half-written list.
 */
export class SubscriptionStore {
  private readonly path: string;

  constructor(private readonly dir: string) {
    this.path = join(dir, FILE_NAME);
  }

  async list(): Promise<PushSubscriptionRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      console.error(`push: can't read ${this.path}; treating as empty`, err);
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as PushSubscriptionRecord[]) : [];
    } catch (err) {
      console.error(`push: ${this.path} is not valid JSON; treating as empty`, err);
      return [];
    }
  }

  /** Adds a subscription, or refreshes the keys of one already stored for that endpoint. */
  async upsert(sub: Omit<PushSubscriptionRecord, "createdAt">): Promise<void> {
    const all = await this.list();
    const existing = all.find((s) => s.endpoint === sub.endpoint);
    const next = all.filter((s) => s.endpoint !== sub.endpoint);
    next.push({ ...sub, createdAt: existing?.createdAt ?? new Date().toISOString() });
    await this.write(next);
  }

  async remove(endpoint: string): Promise<void> {
    const all = await this.list();
    const next = all.filter((s) => s.endpoint !== endpoint);
    if (next.length !== all.length) await this.write(next);
  }

  private async write(records: PushSubscriptionRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(records, null, 2) + "\n", "utf8");
    await rename(tmp, this.path);
  }
}
