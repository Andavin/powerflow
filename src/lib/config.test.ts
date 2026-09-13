import { describe, it, expect } from "vitest";
import { readConfig, type FileConfig } from "./config";

// readConfig is pure: it takes an env bag and an optional parsed config.yml and
// applies "defaults < file < env" precedence. The fs/YAML loading is a separate
// function (loadConfigFile), so these tests never touch the filesystem.

// process.env is typed with a required NODE_ENV; these tests pass bare bags, so
// build them through a small caster instead of spelling out NODE_ENV each time.
const env = (bag: Record<string, string> = {}): NodeJS.ProcessEnv => bag as NodeJS.ProcessEnv;
const empty = env();

describe("readConfig — env only (no file)", () => {
  it("falls back to built-in defaults", () => {
    const c = readConfig(empty, null);
    expect(c.dataMode).toBe("live");
    expect(c.questdbUrl).toBe("http://127.0.0.1:9000");
    expect(c.deviceId).toBe(null);
    expect(c.timezone).toBe("America/Denver");
    expect(c.authDisabled).toBe(false);
    expect(c.controlEnabled).toBe(false);
    expect(c.mqtt.url).toBe("");
    expect(c.mqtt.rejectUnauthorized).toBe(true);
    expect(c.mqtt.topicPrefix).toBe("ebus/5");
    expect(c.mqtt.clientId).toBe("powerflow-web");
  });

  it("reads values straight from the environment", () => {
    const c = readConfig(
      env({
        POWERFLOW_DATA_MODE: "mock",
        QUESTDB_URL: "http://questdb:9000/",
        POWERFLOW_DEVICE_ID: " dev-1 ",
        POWERFLOW_CONTROL_ENABLED: "1",
        POWERFLOW_MQTT_URL: "mqtts://1.2.3.4:8883",
        POWERFLOW_MQTT_REJECT_UNAUTHORIZED: "0",
      }),
      null,
    );
    expect(c.dataMode).toBe("mock");
    expect(c.questdbUrl).toBe("http://questdb:9000"); // trailing slash stripped
    expect(c.deviceId).toBe("dev-1"); // trimmed
    expect(c.controlEnabled).toBe(true);
    expect(c.mqtt.url).toBe("mqtts://1.2.3.4:8883");
    expect(c.mqtt.rejectUnauthorized).toBe(false);
  });
});

describe("readConfig — file (config.yml) as the base layer", () => {
  const file: FileConfig = {
    mqtt: {
      server: "span-abc.local",
      port: 8883,
      username: "panel-user",
      password: "panel-pass",
      ca_cert: "/config/ca.pem",
    },
    span: { device_id: "abc-1234-00xy1", topic_prefix: "ebus/5" },
    questdb: { host: "questdb", http_port: 9000 },
    powerflow: {
      data_mode: "live",
      timezone: "America/New_York",
      auth_disabled: false,
      password: "web-pass",
      session_secret: "sekret",
      control_enabled: true,
      mqtt: { client_id: "powerflow-web", reject_unauthorized: true },
    },
  };

  it("derives the MQTT and QuestDB urls from structured host/port fields", () => {
    const c = readConfig(empty, file);
    // mqtts because a ca_cert is set; port from mqtt.port.
    expect(c.mqtt.url).toBe("mqtts://span-abc.local:8883");
    expect(c.questdbUrl).toBe("http://questdb:9000");
    expect(c.mqtt.caFile).toBe("/config/ca.pem");
    expect(c.mqtt.username).toBe("panel-user");
    expect(c.mqtt.password).toBe("panel-pass");
  });

  it("reads shared + web-only sections", () => {
    const c = readConfig(empty, file);
    expect(c.deviceId).toBe("abc-1234-00xy1");
    expect(c.mqtt.topicPrefix).toBe("ebus/5");
    expect(c.timezone).toBe("America/New_York");
    expect(c.password).toBe("web-pass");
    expect(c.sessionSecret).toBe("sekret");
    expect(c.controlEnabled).toBe(true);
  });

  it("uses mqtt:// and default port 1883 when no CA is pinned", () => {
    const c = readConfig(empty, { mqtt: { server: "broker" } });
    expect(c.mqtt.url).toBe("mqtt://broker:1883");
  });

  it("lets environment variables override individual file keys", () => {
    const c = readConfig(
      env({
        POWERFLOW_PASSWORD: "override-pass",
        POWERFLOW_CONTROL_ENABLED: "0",
        QUESTDB_URL: "http://172.16.0.1:9000",
        POWERFLOW_MQTT_URL: "mqtts://10.0.0.5:8883",
      }),
      file,
    );
    expect(c.password).toBe("override-pass"); // env wins over file
    expect(c.controlEnabled).toBe(false); // env "0" beats file true
    expect(c.questdbUrl).toBe("http://172.16.0.1:9000"); // env url beats derived
    expect(c.mqtt.url).toBe("mqtts://10.0.0.5:8883"); // explicit env url beats derived
    // Untouched keys still come from the file.
    expect(c.mqtt.username).toBe("panel-user");
    expect(c.timezone).toBe("America/New_York");
  });

  it("takes data_mode from the file when the env doesn't set it", () => {
    const c = readConfig(empty, { powerflow: { data_mode: "mock" } });
    expect(c.dataMode).toBe("mock");
  });
});

describe("readConfig — notify (push notifications)", () => {
  it("is off by default: no VAPID keys, sane thresholds", () => {
    const c = readConfig(empty, null);
    expect(c.notify.vapidPublicKey).toBe("");
    expect(c.notify.vapidPrivateKey).toBe("");
    expect(c.notify.vapidSubject).toBe("mailto:admin@example.com");
    expect(c.notify.dataDir).toBe("/data");
    expect(c.notify.batteryLowPercent).toBe(20);
    expect(c.notify.staleAfterMs).toBe(5 * 60_000);
  });

  it("reads the notify block from the file", () => {
    const c = readConfig(empty, {
      powerflow: {
        notify: {
          vapid_public_key: "pub",
          vapid_private_key: "priv",
          vapid_subject: "mailto:me@example.org",
          data_dir: "/var/powerflow",
          battery_low_percent: 0,
          stale_after: "90s",
        },
      },
    });
    expect(c.notify.vapidPublicKey).toBe("pub");
    expect(c.notify.vapidPrivateKey).toBe("priv");
    expect(c.notify.vapidSubject).toBe("mailto:me@example.org");
    expect(c.notify.dataDir).toBe("/var/powerflow");
    expect(c.notify.batteryLowPercent).toBe(0); // 0 is a real value (disabled), not "unset"
    expect(c.notify.staleAfterMs).toBe(90_000);
  });

  it("lets environment variables override the file", () => {
    const c = readConfig(
      env({
        POWERFLOW_VAPID_PUBLIC_KEY: "env-pub",
        POWERFLOW_VAPID_PRIVATE_KEY: "env-priv",
        POWERFLOW_DATA_DIR: "/tmp/pf",
        POWERFLOW_BATTERY_LOW_PERCENT: "35",
        POWERFLOW_STALE_AFTER: "2m",
      }),
      { powerflow: { notify: { vapid_public_key: "pub", battery_low_percent: 10, stale_after: "5m" } } },
    );
    expect(c.notify.vapidPublicKey).toBe("env-pub");
    expect(c.notify.vapidPrivateKey).toBe("env-priv");
    expect(c.notify.dataDir).toBe("/tmp/pf");
    expect(c.notify.batteryLowPercent).toBe(35);
    expect(c.notify.staleAfterMs).toBe(120_000);
  });

  it("rejects a stale_after it can't parse rather than silently defaulting", () => {
    expect(() => readConfig(env({ POWERFLOW_STALE_AFTER: "soon" }), null)).toThrow(/stale_after/);
  });
});
