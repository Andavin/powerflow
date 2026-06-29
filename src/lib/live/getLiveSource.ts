import { config } from "../config";
import { getRepository } from "../getRepository";
import type { LiveSource } from "./types";
import { PollingLiveSource } from "./pollingSource";
import { MqttLiveSource } from "./mqttSource";

let cached: LiveSource | null = null;

/**
 * Process-wide live source. MQTT when configured (event-driven, no DB polling),
 * otherwise a QuestDB/mock polling fallback. Started lazily on first use and
 * shared across all SSE connections.
 */
export function getLiveSource(): LiveSource {
  if (cached) return cached;
  const cfg = config();
  const repo = getRepository();

  if (cfg.realtime === "mqtt" && cfg.mqtt.url && cfg.deviceId) {
    cached = new MqttLiveSource({
      url: cfg.mqtt.url,
      username: cfg.mqtt.username || undefined,
      password: cfg.mqtt.password || undefined,
      caFile: cfg.mqtt.caFile,
      rejectUnauthorized: cfg.mqtt.rejectUnauthorized,
      clientId: cfg.mqtt.clientId,
      topicPrefix: cfg.mqtt.topicPrefix,
      deviceId: cfg.deviceId,
      // Circuit names come from QuestDB (the only DB read on the live path),
      // refreshed occasionally rather than polled.
      loadNames: async () =>
        new Map((await repo.getCircuits()).map((c) => [c.id, c.name])),
      log: (level, msg, extra) => {
        const line = `[powerflow:mqtt] ${msg}`;
        if (level === "error") console.error(line, extra ?? "");
        else if (level === "warn") console.warn(line, extra ?? "");
        else console.log(line, extra ?? "");
      },
    });
  } else {
    cached = new PollingLiveSource(repo);
  }

  cached.ensureStarted();
  return cached;
}

/** Test helper. */
export function resetLiveSourceCache(): void {
  cached = null;
}
