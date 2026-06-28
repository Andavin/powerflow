/**
 * Runtime configuration, read once from the environment.
 *
 * Everything here is server-side only. The data layer is intentionally
 * decoupled from these globals (values are passed in), so unit tests can
 * exercise it without touching `process.env`.
 */

export type DataMode = "live" | "mock";

export interface PowerflowConfig {
  dataMode: DataMode;
  questdbUrl: string;
  deviceId: string | null;
  timezone: string;
  authDisabled: boolean;
  password: string;
  sessionSecret: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): PowerflowConfig {
  const dataMode: DataMode = env.POWERFLOW_DATA_MODE === "mock" ? "mock" : "live";
  return {
    dataMode,
    questdbUrl: (env.QUESTDB_URL ?? "http://127.0.0.1:9000").replace(/\/$/, ""),
    deviceId: env.POWERFLOW_DEVICE_ID?.trim() || null,
    // The panel lives in Whitefish, MT. All "today/week/month/year" boundaries
    // are computed in this zone unless overridden.
    timezone: env.POWERFLOW_TIMEZONE?.trim() || "America/Denver",
    authDisabled: bool(env.POWERFLOW_AUTH_DISABLED, false),
    password: env.POWERFLOW_PASSWORD ?? "",
    sessionSecret: env.POWERFLOW_SESSION_SECRET ?? "",
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
