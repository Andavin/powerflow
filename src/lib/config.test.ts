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
