import { readFileSync } from "node:fs";
import mqtt from "mqtt";
import type { Circuit } from "../types";
import {
  applyMessage,
  buildSnapshot,
  emptyLiveState,
  isFlowReady,
  type LiveState,
} from "./state";
import type { LiveSnapshot, LiveSource, MetaProvider } from "./types";

export interface MqttSourceOptions {
  url: string; // e.g. mqtts://192.168.0.212:8883
  username?: string;
  password?: string;
  caFile?: string | null;
  rejectUnauthorized: boolean;
  clientId: string;
  topicPrefix: string;
  deviceId: string;
  /** Loads circuit metadata (id → Circuit) from QuestDB; refreshed occasionally. */
  loadMeta: MetaProvider;
  coalesceMs?: number;
  metaRefreshMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

/**
 * Real-time source backed by the panel's MQTT feed. Subscribes only to the
 * topics the web app needs (power-flows, bess, per-circuit active_power),
 * folds them into in-memory state, and emits coalesced snapshots. Circuit
 * names come from QuestDB (looked up rarely), not the broker.
 */
export class MqttLiveSource implements LiveSource {
  private readonly opts: Required<Omit<MqttSourceOptions, "username" | "password" | "caFile" | "log">> &
    Pick<MqttSourceOptions, "username" | "password" | "caFile" | "log">;
  private state: LiveState = emptyLiveState();
  private meta = new Map<string, Circuit>();
  private latest: LiveSnapshot | null = null;
  private readonly listeners = new Set<(s: LiveSnapshot) => void>();
  private client: mqtt.MqttClient | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private started = false;

  constructor(opts: MqttSourceOptions) {
    this.opts = { coalesceMs: 750, metaRefreshMs: 600_000, ...opts };
  }

  ensureStarted(): void {
    if (this.started) return;
    this.started = true;

    void this.refreshMeta();
    setInterval(() => void this.refreshMeta(), this.opts.metaRefreshMs).unref?.();

    const ca = this.opts.caFile ? [readFileSync(this.opts.caFile)] : undefined;
    // Pinned-CA LAN device: validate the chain against our CA but don't require
    // the cert hostname to match the broker IP.
    const options = {
      clientId: this.opts.clientId,
      username: this.opts.username,
      password: this.opts.password,
      reconnectPeriod: 5000,
      connectTimeout: 15_000,
      ca,
      rejectUnauthorized: this.opts.rejectUnauthorized,
      checkServerIdentity: () => undefined,
    } as mqtt.IClientOptions;

    const client = mqtt.connect(this.opts.url, options);
    this.client = client;
    const { topicPrefix: p, deviceId: d } = this.opts;

    client.on("connect", () => {
      this.log("info", "MQTT connected", { url: this.opts.url });
      client.subscribe(
        [
          `${p}/${d}/power-flows/+`,
          `${p}/${d}/bess/+`,
          // Panel publishes circuit power hyphenated (active-power).
          `${p}/${d}/+/active-power`,
          `${p}/${d}/+/relay`,
        ],
        { qos: 0 },
        (err) => err && this.log("error", "MQTT subscribe failed", err.message),
      );
    });

    client.on("message", (topic, payload) => {
      if (applyMessage(this.state, p, d, topic, payload.toString())) {
        this.dirty = true;
        this.scheduleFlush();
      }
    });

    client.on("error", (err) => this.log("error", "MQTT error", err.message));
    client.on("reconnect", () => this.log("warn", "MQTT reconnecting"));
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      if (!isFlowReady(this.state)) return;
      const snap = buildSnapshot(this.state, this.meta);
      this.latest = snap;
      for (const l of this.listeners) l(snap);
    }, this.opts.coalesceMs);
    this.flushTimer.unref?.();
  }

  private async refreshMeta(): Promise<void> {
    try {
      this.meta = await this.opts.loadMeta();
    } catch (err) {
      this.log("warn", "circuit metadata refresh failed", err instanceof Error ? err.message : err);
    }
  }

  private log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
    this.opts.log?.(level, msg, extra);
  }

  current(): LiveSnapshot | null {
    return this.latest;
  }

  subscribe(listener: (s: LiveSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
