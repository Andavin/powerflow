/**
 * Runtime configuration, read once on the server.
 *
 * Layered like the Go collector, so the whole stack is configured the same way:
 *
 *   built-in defaults  <  config.yml  <  environment variables
 *
 * The shared `config.yml` (mounted at /config/config.yml in the stack) is the
 * primary source; its `mqtt` / `span` / `questdb` sections are shared with the
 * collector, and a web-only `powerflow` section holds the rest. Environment
 * variables (POWERFLOW_*, QUESTDB_URL) override individual keys — for per-deploy
 * secrets or local dev, where there is usually no file at all.
 *
 * Everything here is server-side only. The data layer is intentionally
 * decoupled from these globals (values are passed in), so unit tests can
 * exercise it without touching `process.env` or the filesystem.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export type DataMode = "live" | "mock";

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
  questdbUrl: string;
  deviceId: string | null;
  timezone: string;
  authDisabled: boolean;
  password: string;
  sessionSecret: string;
  /**
   * Master switch for breaker control. Default OFF: the publish route is
   * disabled and the UI shows read-only unless this is explicitly enabled.
   */
  controlEnabled: boolean;
  mqtt: MqttConfig;
}

/**
 * Parsed shape of the shared config.yml. Every field is optional — the file is
 * a base layer, and the file itself is optional. The `mqtt` / `span` / `questdb`
 * sections mirror the collector's config (the collector ignores the web-only
 * `powerflow` section, and this ignores the collector-only keys). The web app
 * derives its single-string `mqtt.url` / `questdbUrl` from the structured
 * host/port fields.
 */
export interface FileConfig {
  mqtt?: {
    server?: string;
    port?: number;
    username?: string;
    password?: string;
    ca_cert?: string;
  };
  span?: {
    device_id?: string;
    topic_prefix?: string;
  };
  questdb?: {
    host?: string;
    http_port?: number;
  };
  powerflow?: {
    data_mode?: string;
    timezone?: string;
    auth_disabled?: boolean;
    password?: string;
    session_secret?: string;
    control_enabled?: boolean;
    mqtt?: {
      client_id?: string;
      reject_unauthorized?: boolean;
    };
  };
}

/** Env string (if set and non-blank) wins, else the file value, else fallback. */
function pickStr(envVal: string | undefined, fileVal: string | undefined, fallback: string): string {
  const e = envVal?.trim();
  if (e) return e;
  if (typeof fileVal === "string" && fileVal.trim()) return fileVal.trim();
  return fallback;
}

/** Same precedence as pickStr but yields null (not "") when nothing is set. */
function pickStrOrNull(envVal: string | undefined, fileVal: string | undefined): string | null {
  return pickStr(envVal, fileVal, "") || null;
}

/** Env "1"/"true" (if set), else the file boolean, else fallback. */
function pickBool(envVal: string | undefined, fileVal: boolean | undefined, fallback: boolean): boolean {
  const e = envVal?.trim();
  if (e) return e === "1" || e.toLowerCase() === "true";
  if (typeof fileVal === "boolean") return fileVal;
  return fallback;
}

/** Derive the web app's MQTT url from the collector-shared host/port fields. */
function deriveMqttUrl(mqtt: FileConfig["mqtt"]): string | undefined {
  if (!mqtt?.server) return undefined;
  const scheme = mqtt.ca_cert ? "mqtts" : "mqtt";
  const port = mqtt.port ?? (mqtt.ca_cert ? 8883 : 1883);
  return `${scheme}://${mqtt.server}:${port}`;
}

/** Derive the QuestDB HTTP url from the collector-shared host/port fields. */
function deriveQuestdbUrl(questdb: FileConfig["questdb"]): string | undefined {
  if (!questdb?.host) return undefined;
  return `http://${questdb.host}:${questdb.http_port ?? 9000}`;
}

/**
 * Load the shared config.yml, if present. The file is optional: a missing file
 * (the common case for local dev, where env vars carry everything) yields null.
 * A file that exists but can't be read or parsed is a hard error, so a typo
 * fails loudly instead of silently falling back to defaults.
 */
export function loadConfigFile(env: NodeJS.ProcessEnv = process.env): FileConfig | null {
  const path = env.POWERFLOW_CONFIG_FILE?.trim() || "/config/config.yml";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`read config file ${path}: ${(err as Error).message}`);
  }
  const parsed = parseYaml(text);
  if (parsed == null) return null; // empty file
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config file ${path} must be a YAML mapping`);
  }
  return parsed as FileConfig;
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  file: FileConfig | null = null,
): PowerflowConfig {
  const f = file ?? {};
  const pf = f.powerflow ?? {};

  const dataModeRaw = env.POWERFLOW_DATA_MODE?.trim() || pf.data_mode;
  const dataMode: DataMode = dataModeRaw === "mock" ? "mock" : "live";

  return {
    dataMode,
    questdbUrl: pickStr(env.QUESTDB_URL, deriveQuestdbUrl(f.questdb), "http://127.0.0.1:9000").replace(
      /\/$/,
      "",
    ),
    deviceId: pickStrOrNull(env.POWERFLOW_DEVICE_ID, f.span?.device_id),
    // All "today/week/month/year" boundaries are computed in the panel's civil
    // timezone unless overridden.
    timezone: pickStr(env.POWERFLOW_TIMEZONE, pf.timezone, "America/Denver"),
    authDisabled: pickBool(env.POWERFLOW_AUTH_DISABLED, pf.auth_disabled, false),
    password: pickStr(env.POWERFLOW_PASSWORD, pf.password, ""),
    sessionSecret: pickStr(env.POWERFLOW_SESSION_SECRET, pf.session_secret, ""),
    controlEnabled: pickBool(env.POWERFLOW_CONTROL_ENABLED, pf.control_enabled, false),
    mqtt: {
      url: pickStr(env.POWERFLOW_MQTT_URL, deriveMqttUrl(f.mqtt), ""),
      username: pickStr(env.POWERFLOW_MQTT_USERNAME, f.mqtt?.username, ""),
      password: pickStr(env.POWERFLOW_MQTT_PASSWORD, f.mqtt?.password, ""),
      caFile: pickStrOrNull(env.POWERFLOW_MQTT_CA_FILE, f.mqtt?.ca_cert),
      rejectUnauthorized: pickBool(env.POWERFLOW_MQTT_REJECT_UNAUTHORIZED, pf.mqtt?.reject_unauthorized, true),
      topicPrefix: pickStr(env.POWERFLOW_MQTT_TOPIC_PREFIX, f.span?.topic_prefix, "ebus/5").replace(/\/$/, ""),
      clientId: pickStr(env.POWERFLOW_MQTT_CLIENT_ID, pf.mqtt?.client_id, "powerflow-web"),
    },
  };
}

let cached: PowerflowConfig | null = null;

/** Memoised config for app code. */
export function config(): PowerflowConfig {
  if (!cached) cached = readConfig(process.env, loadConfigFile());
  return cached;
}
