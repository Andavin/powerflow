import type { Repository } from "../repository";
import { topConsumers } from "../transform";
import type { LiveSnapshot, LiveSource } from "./types";

/**
 * Fallback live source that polls the repository (QuestDB or mock). Used when
 * MQTT isn't configured, and by the test/mock data mode.
 */
export class PollingLiveSource implements LiveSource {
  private latest: LiveSnapshot | null = null;
  private readonly listeners = new Set<(s: LiveSnapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly repo: Repository,
    private readonly intervalMs = 2000,
  ) {}

  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    // Don't keep the process alive solely for polling.
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    try {
      const [flow, circuits] = await Promise.all([
        this.repo.getFlow(),
        this.repo.getCircuits(),
      ]);
      const snap: LiveSnapshot = { ts: flow.ts, flow, top: topConsumers(circuits, 5) };
      this.latest = snap;
      for (const l of this.listeners) l(snap);
    } catch {
      // Keep serving the last good snapshot.
    }
  }

  current(): LiveSnapshot | null {
    return this.latest;
  }

  subscribe(listener: (s: LiveSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
