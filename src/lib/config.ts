/**
 * Runtime configuration, read once from the environment.
 *
 * Everything here is server-side only. The data layer is intentionally
 * decoupled from these globals (values are passed in), so unit tests can
 * exercise it without touching `process.env`.
 */

export type DataMode = "live" | "mock";
export type RealtimeMode = "mqtt" | "poll";

export interface MqttConfig {
  url: string;
  username: string;
  password: string;
  caFile: string | null;
  rejectUnauthorized: boolean;
  topicPrefix: string;
  clientId: string;
}

export interface PowerflowConfig {
  dataMode: DataMode;
  /** Live data transport: event-driven MQTT, or QuestDB polling. */
  realtime: RealtimeMode;
  questdbUrl: string;
  deviceId: string | null;
  timezone: string;
  authDisabled: boolean;
  password: string;
  sessionSecret: string;
  mqtt: MqttConfig;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): PowerflowConfig {
  const dataMode: DataMode = env.POWERFLOW_DATA_MODE === "mock" ? "mock" : "live";
  const realtime: RealtimeMode = env.POWERFLOW_REALTIME === "mqtt" ? "mqtt" : "poll";
  return {
    dataMode,
    realtime,
    questdbUrl: (env.QUESTDB_URL ?? "http://127.0.0.1:9000").replace(/\/$/, ""),
    deviceId: env.POWERFLOW_DEVICE_ID?.trim() || null,
    // The panel lives in Whitefish, MT. All "today/week/month/year" boundaries
    // are computed in this zone unless overridden.
    timezone: env.POWERFLOW_TIMEZONE?.trim() || "America/Denver",
    authDisabled: bool(env.POWERFLOW_AUTH_DISABLED, false),
    password: env.POWERFLOW_PASSWORD ?? "",
    sessionSecret: env.POWERFLOW_SESSION_SECRET ?? "",
    mqtt: {
      url: env.POWERFLOW_MQTT_URL?.trim() ?? "",
      username: env.POWERFLOW_MQTT_USERNAME ?? "",
      password: env.POWERFLOW_MQTT_PASSWORD ?? "",
      caFile: env.POWERFLOW_MQTT_CA_FILE?.trim() || null,
      rejectUnauthorized: bool(env.POWERFLOW_MQTT_REJECT_UNAUTHORIZED, true),
      topicPrefix: (env.POWERFLOW_MQTT_TOPIC_PREFIX?.trim() || "ebus/5").replace(/\/$/, ""),
      clientId: env.POWERFLOW_MQTT_CLIENT_ID?.trim() || "powerflow-web",
    },
  };
}

let cached: PowerflowConfig | null = null;

/** Memoised config for app code. */
export function config(): PowerflowConfig {
  if (!cached) cached = readConfig();
  return cached;
}

/** Test helper to reset the memoised config. */
export function resetConfigCache(): void {
  cached = null;
}
