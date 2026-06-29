import { config } from "../config";
import { getRepository } from "../getRepository";
import type { LiveSource } from "./types";
import { MockLiveSource } from "./mockSource";
import { MqttLiveSource } from "./mqttSource";

let cached: LiveSource | null = null;

/**
 * Process-wide live source, shared across all SSE connections.
 *   - `mock` data mode → deterministic in-memory source (tests / demos).
 *   - `live` data mode → MQTT (event-driven). The real-time path never polls
 *     QuestDB; only circuit metadata (names, panel slot) is read from it,
 *     rarely.
 *
 * Live mode requires MQTT to be configured (POWERFLOW_MQTT_URL + device id).
 */
export function getLiveSource(): LiveSource {
  if (cached) return cached;
  const cfg = config();
  const repo = getRepository();

  if (cfg.dataMode === "mock") {
    cached = new MockLiveSource(repo);
  } else {
    if (!cfg.mqtt.url || !cfg.deviceId) {
      throw new Error(
        "Live real-time requires MQTT: set POWERFLOW_MQTT_URL and POWERFLOW_DEVICE_ID.",
      );
    }
    cached = new MqttLiveSource({
      url: cfg.mqtt.url,
      username: cfg.mqtt.username || undefined,
      password: cfg.mqtt.password || undefined,
      caFile: cfg.mqtt.caFile,
      rejectUnauthorized: cfg.mqtt.rejectUnauthorized,
      clientId: cfg.mqtt.clientId,
      topicPrefix: cfg.mqtt.topicPrefix,
      deviceId: cfg.deviceId,
      // The only QuestDB read on the live path: circuit metadata, rarely.
      loadMeta: async () => new Map((await repo.getCircuits()).map((c) => [c.id, c])),
      log: (level, msg, extra) => {
        const line = `[powerflow:mqtt] ${msg}`;
        if (level === "error") console.error(line, extra ?? "");
        else if (level === "warn") console.warn(line, extra ?? "");
        else console.log(line, extra ?? "");
      },
    });
  }

  cached.ensureStarted();
  return cached;
}

/** Test helper. */
export function resetLiveSourceCache(): void {
  cached = null;
}
