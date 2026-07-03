package main

import (
	"strings"
	"testing"
)

func TestBrokerURL(t *testing.T) {
	tests := []struct {
		name   string
		cfg    MQTTConfig
		expect string
	}{
		{"plain TCP", MQTTConfig{Server: "10.0.0.1", Port: 1883}, "tcp://10.0.0.1:1883"},
		{"TLS", MQTTConfig{Server: "mqtt.example.com", Port: 8883, CACert: "/ca.pem"}, "ssl://mqtt.example.com:8883"},
		{"empty ca_cert is TCP", MQTTConfig{Server: "host", Port: 1883, CACert: ""}, "tcp://host:1883"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.cfg.BrokerURL()
			if got != tt.expect {
				t.Errorf("BrokerURL() = %q, want %q", got, tt.expect)
			}
		})
	}
}

func TestSubscribeTopics(t *testing.T) {
	cfg := SpanConfig{TopicPrefix: "ebus/5", DeviceID: "dev-123"}
	got := cfg.SubscribeTopics()
	want := []string{"ebus/5/dev-123/+", "ebus/5/dev-123/+/+"}
	if len(got) != len(want) {
		t.Fatalf("SubscribeTopics() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("SubscribeTopics()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	// Neither filter may use the multi-level '#' wildcard (that would let
	// 3-level command sub-topics like <node>/<property>/set through again).
	for _, f := range got {
		if strings.ContainsRune(f, '#') {
			t.Errorf("filter %q must not contain '#'", f)
		}
	}
}

func TestTopicBase(t *testing.T) {
	cfg := SpanConfig{TopicPrefix: "ebus/5", DeviceID: "dev-123"}
	want := "ebus/5/dev-123/"
	if got := cfg.TopicBase(); got != want {
		t.Errorf("TopicBase() = %q, want %q", got, want)
	}
}

func TestParseConfigDefaults(t *testing.T) {
	yaml := `
mqtt:
  server: "test-broker"
  client_id: "test-client"
span:
  device_id: "test-device"
`
	cfg, err := ParseConfig([]byte(yaml))
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}

	// Defaults
	if cfg.MQTT.Port != 1883 {
		t.Errorf("default port = %d, want 1883", cfg.MQTT.Port)
	}
	if cfg.Span.TopicPrefix != "ebus/5" {
		t.Errorf("default topic_prefix = %q, want %q", cfg.Span.TopicPrefix, "ebus/5")
	}
	if cfg.QuestDB.ILPPort != 9009 {
		t.Errorf("default ilp_port = %d, want 9009", cfg.QuestDB.ILPPort)
	}
	if cfg.QuestDB.HTTPPort != 9000 {
		t.Errorf("default http_port = %d, want 9000", cfg.QuestDB.HTTPPort)
	}
	if !cfg.QuestDB.CreateTables {
		t.Error("default create_tables should be true")
	}
	if cfg.QuestDB.WriteInterval != "5s" {
		t.Errorf("default write_interval = %q, want %q", cfg.QuestDB.WriteInterval, "5s")
	}
	if cfg.Logging.Level != "info" {
		t.Errorf("default level = %q, want %q", cfg.Logging.Level, "info")
	}
}

func TestParseConfigOverrides(t *testing.T) {
	yaml := `
mqtt:
  server: "mqtt.local"
  port: 9999
  client_id: "my-client"
span:
  topic_prefix: "custom/prefix"
  device_id: "my-device"
questdb:
  host: "qdb.local"
  ilp_port: 9010
  http_port: 9001
  create_tables: false
  write_interval: "10s"
logging:
  level: "debug"
  format: "json"
`
	cfg, err := ParseConfig([]byte(yaml))
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}

	if cfg.MQTT.Server != "mqtt.local" {
		t.Errorf("server = %q", cfg.MQTT.Server)
	}
	if cfg.MQTT.Port != 9999 {
		t.Errorf("port = %d", cfg.MQTT.Port)
	}
	if cfg.Span.TopicPrefix != "custom/prefix" {
		t.Errorf("topic_prefix = %q", cfg.Span.TopicPrefix)
	}
	if cfg.QuestDB.Host != "qdb.local" {
		t.Errorf("host = %q", cfg.QuestDB.Host)
	}
	if cfg.QuestDB.ILPPort != 9010 {
		t.Errorf("ilp_port = %d", cfg.QuestDB.ILPPort)
	}
	if cfg.QuestDB.CreateTables {
		t.Error("create_tables should be false")
	}
	if cfg.Logging.Level != "debug" {
		t.Errorf("level = %q", cfg.Logging.Level)
	}
}

func TestParseConfigValidation(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			"missing server",
			`mqtt: { server: "", client_id: "x" }
span: { device_id: "x" }`,
			"mqtt.server is required",
		},
		{
			"port zero",
			`mqtt: { server: "x", port: 0, client_id: "x" }
span: { device_id: "x" }`,
			"mqtt.port must be 1-65535",
		},
		{
			"port too high",
			`mqtt: { server: "x", port: 99999, client_id: "x" }
span: { device_id: "x" }`,
			"mqtt.port must be 1-65535",
		},
		{
			"missing client_id",
			`mqtt: { server: "x", client_id: "" }
span: { device_id: "x" }`,
			"mqtt.client_id is required",
		},
		{
			"missing device_id",
			`mqtt: { server: "x", client_id: "x" }
span: { device_id: "" }`,
			"span.device_id is required",
		},
		{
			"bad write_interval",
			`mqtt: { server: "x", client_id: "x" }
span: { device_id: "x" }
questdb: { write_interval: "nope" }`,
			"invalid questdb.write_interval",
		},
		{
			"write_interval too small",
			`mqtt: { server: "x", client_id: "x" }
span: { device_id: "x" }
questdb: { write_interval: "10ms" }`,
			"questdb.write_interval must be >= 100ms",
		},
		{
			"invalid YAML",
			`{{invalid`,
			"parse config",
		},
		{
			"missing questdb host",
			`mqtt: { server: "x", client_id: "x" }
span: { device_id: "x" }
questdb: { host: "" }`,
			"questdb.host is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseConfig([]byte(tt.yaml))
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %q, want it to contain %q", err.Error(), tt.wantErr)
			}
		})
	}
}

func TestSetupLogger(t *testing.T) {
	tests := []struct {
		level  string
		format string
	}{
		{"debug", "text"},
		{"info", "text"},
		{"warn", "json"},
		{"error", "json"},
		{"WARNING", "text"},
		{"unknown", "text"},
	}
	for _, tt := range tests {
		t.Run(tt.level+"_"+tt.format, func(t *testing.T) {
			logger := SetupLogger(LoggingConfig{Level: tt.level, Format: tt.format})
			if logger == nil {
				t.Fatal("SetupLogger returned nil")
			}
		})
	}
}

func TestParseConfigEnvOnly(t *testing.T) {
	// No file at all — the collector should be fully configurable from env.
	t.Setenv("SPAN_MQTT_SERVER", "panel.local")
	t.Setenv("SPAN_MQTT_PORT", "8883")
	t.Setenv("SPAN_MQTT_USERNAME", "user")
	t.Setenv("SPAN_MQTT_PASSWORD", "secret")
	t.Setenv("SPAN_MQTT_CA_CERT", "")
	t.Setenv("SPAN_TOPIC_PREFIX", "ebus/5")
	t.Setenv("SPAN_DEVICE_ID", "dev-9")
	t.Setenv("SPAN_QUESTDB_HOST", "questdb")

	cfg, err := ParseConfig(nil)
	if err != nil {
		t.Fatalf("ParseConfig(nil) with env: %v", err)
	}
	if cfg.MQTT.Server != "panel.local" || cfg.MQTT.Port != 8883 {
		t.Errorf("mqtt server/port = %q/%d", cfg.MQTT.Server, cfg.MQTT.Port)
	}
	if cfg.MQTT.Username != "user" || cfg.MQTT.Password != "secret" {
		t.Errorf("mqtt creds = %q/%q", cfg.MQTT.Username, cfg.MQTT.Password)
	}
	if cfg.Span.DeviceID != "dev-9" || cfg.Span.TopicPrefix != "ebus/5" {
		t.Errorf("span = %q/%q", cfg.Span.DeviceID, cfg.Span.TopicPrefix)
	}
	if cfg.QuestDB.Host != "questdb" {
		t.Errorf("questdb host = %q", cfg.QuestDB.Host)
	}
}

func TestParseConfigEnvOverridesFile(t *testing.T) {
	// Env wins over a value supplied in the file.
	yaml := []byte("mqtt:\n  server: fromfile\n  password: fromfile\nspan:\n  device_id: fromfile\n")
	t.Setenv("SPAN_MQTT_PASSWORD", "fromenv")

	cfg, err := ParseConfig(yaml)
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	if cfg.MQTT.Password != "fromenv" {
		t.Errorf("password = %q, want fromenv (env should win)", cfg.MQTT.Password)
	}
	if cfg.MQTT.Server != "fromfile" {
		t.Errorf("server = %q, want fromfile (unset env leaves file value)", cfg.MQTT.Server)
	}
	if cfg.Span.DeviceID != "fromfile" {
		t.Errorf("device_id = %q, want fromfile", cfg.Span.DeviceID)
	}
}

func TestParseConfigInvalidEnvInt(t *testing.T) {
	t.Setenv("SPAN_DEVICE_ID", "dev-9")
	t.Setenv("SPAN_MQTT_PORT", "not-a-number")
	if _, err := ParseConfig(nil); err == nil {
		t.Fatal("expected an error for a non-numeric SPAN_MQTT_PORT")
	}
}
