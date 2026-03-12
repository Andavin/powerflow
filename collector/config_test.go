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

func TestSubscribeTopic(t *testing.T) {
	cfg := SpanConfig{TopicPrefix: "ebus/5", DeviceID: "dev-123"}
	want := "ebus/5/dev-123/#"
	if got := cfg.SubscribeTopic(); got != want {
		t.Errorf("SubscribeTopic() = %q, want %q", got, want)
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
