import type { Circuit, FlowSnapshot, TopConsumer } from "../types";

/** A coalesced real-time snapshot pushed to clients over SSE. */
export interface LiveSnapshot {
  ts: string;
  flow: FlowSnapshot;
  top: TopConsumer[];
  /** Full circuit list (live watts + relay), for the Circuits screen. */
  circuits: Circuit[];
}

/**
 * A push source of real-time data. Implementations: MQTT (event-driven) and a
 * QuestDB polling fallback. The SSE route subscribes to one shared instance.
 */
export interface LiveSource {
  /** Idempotently begin producing snapshots (connect / start polling). */
  ensureStarted(): void;
  /** The most recent snapshot, if any has been produced yet. */
  current(): LiveSnapshot | null;
  /** Subscribe to coalesced updates; returns an unsubscribe function. */
  subscribe(listener: (snapshot: LiveSnapshot) => void): () => void;
}

/** Loads circuit metadata (id → Circuit) from QuestDB, looked up rarely. */
export type MetaProvider = () => Promise<Map<string, Circuit>>;
