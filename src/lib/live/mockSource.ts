import type { Repository } from "../repository";
import { topConsumers } from "../transform";
import type { LiveSnapshot, LiveSource } from "./types";

/**
 * Live source for the `mock` data mode (tests / offline demos). Reads the
 * deterministic in-memory repository once and re-emits that snapshot for
 * liveness. This is not database polling — it never touches QuestDB.
 */
export class MockLiveSource implements LiveSource {
  private latest: LiveSnapshot | null = null;
  private readonly listeners = new Set<(s: LiveSnapshot) => void>();
  private started = false;

  constructor(private readonly repo: Repository) {}

  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    void this.build();
    // Re-push the cached snapshot periodically so subscribers stay "live".
    setInterval(() => {
      if (this.latest) for (const l of this.listeners) l(this.latest);
    }, 2000).unref?.();
  }

  private async build(): Promise<void> {
    const [flow, circuits] = await Promise.all([
      this.repo.getFlow(),
      this.repo.getCircuits(),
    ]);
    const snap: LiveSnapshot = {
      ts: flow.ts,
      flow,
      top: topConsumers(circuits, 5),
      circuits,
    };
    this.latest = snap;
    for (const l of this.listeners) l(snap);
  }

  current(): LiveSnapshot | null {
    return this.latest;
  }

  subscribe(listener: (s: LiveSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
