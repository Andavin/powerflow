package main

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ---------------------------------------------------------------------------
// Config structs
// ---------------------------------------------------------------------------

type Config struct {
	MQTT     MQTTConfig     `yaml:"mqtt"`
	Span     SpanConfig     `yaml:"span"`
	Snapshot SnapshotConfig `yaml:"snapshot"`
	Logging  LoggingConfig  `yaml:"logging"`
}

type MQTTConfig struct {
	Server   string `yaml:"server"`
	Port     int    `yaml:"port"`
	ClientID string `yaml:"client_id"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	CACert   string `yaml:"ca_cert"`
}

func (m *MQTTConfig) BrokerURL() string {
	scheme := "tcp"
	if m.CACert != "" {
		scheme = "ssl"
	}
	return fmt.Sprintf("%s://%s:%d", scheme, m.Server, m.Port)
}

type SpanConfig struct {
	TopicPrefix string `yaml:"topic_prefix"`
	DeviceID    string `yaml:"device_id"`
}

// SubscribeTopic returns the wildcard MQTT topic for subscribing.
func (s *SpanConfig) SubscribeTopic() string {
	return s.TopicPrefix + "/" + s.DeviceID + "/#"
}

// TopicBase returns the topic prefix including the device ID.
func (s *SpanConfig) TopicBase() string {
	return s.TopicPrefix + "/" + s.DeviceID + "/"
}

type SnapshotConfig struct {
	Interval        string `yaml:"interval"`
	OutputTopic     string `yaml:"output_topic"`
	PerCircuitTopic bool   `yaml:"per_circuit_topics"`
	QoS             byte   `yaml:"qos"`
	Retain          bool   `yaml:"retain"`

	parsed time.Duration
}

type LoggingConfig struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
}

// ---------------------------------------------------------------------------
// Default config generation
// ---------------------------------------------------------------------------

const defaultConfigYAML = `# ============================================================
# SPAN Panel Data Collector — Configuration
# ============================================================
# Subscribes to SPAN panel MQTT topics (Homie 5.0 convention),
# periodically snapshots the full state, and publishes structured
# JSON to an output topic for time-series logging.

# MQTT broker connection (used for both subscribing and publishing)
mqtt:
  server: "mqtt.example.com"
  port: 8883
  client_id: "span-collector-01"
  username: ""
  password: ""
  # Path to CA certificate (PEM) for TLS. Leave empty for plain TCP.
  # When using Docker, mount your ca.pem into /config/
  ca_cert: "/config/ca.pem"

# SPAN panel data source
span:
  # MQTT topic prefix where the SPAN panel publishes (Homie 5.0)
  topic_prefix: "ebus/5"
  # SPAN panel device ID (serial number)
  device_id: "REPLACE-WITH-YOUR-PANEL-SERIAL"

# Periodic snapshot settings
snapshot:
  # How often to capture and publish a full state snapshot
  # Go duration format: "5s", "30s", "1m", etc.
  interval: "5s"
  # MQTT topic for published snapshots
  output_topic: "span-stats/snapshot"
  # Also publish each circuit individually to span-stats/circuit/{circuit-name}
  per_circuit_topics: true
  qos: 1
  retain: true

# Logging
logging:
  # Verbosity: debug, info, warn, error
  #   debug — every incoming MQTT message, state updates, snapshot content
  #   info  — startup config, each snapshot cycle, connect/disconnect events
  #   warn  — missing data, reconnection attempts
  #   error — publish failures, parse errors
  level: "info"
  # Format: "text" (human-readable) or "json" (structured)
  format: "text"
`

// WriteDefaultConfig writes the default annotated config to the given path,
// creating parent directories as needed.
func WriteDefaultConfig(path string) error {
	dir := path[:max(0, strings.LastIndex(path, "/"))]
	if dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("create config directory %s: %w", dir, err)
		}
	}
	return os.WriteFile(path, []byte(defaultConfigYAML), 0644)
}

// ---------------------------------------------------------------------------
// Loading & validation
// ---------------------------------------------------------------------------

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{
		MQTT: MQTTConfig{
			Server:   "127.0.0.1",
			Port:     1883,
			ClientID: "span-collector",
		},
		Span: SpanConfig{
			TopicPrefix: "ebus/5",
		},
		Snapshot: SnapshotConfig{
			Interval:        "5s",
			OutputTopic:     "span-stats/snapshot",
			PerCircuitTopic: true,
			QoS:             1,
			Retain:          true,
		},
		Logging: LoggingConfig{
			Level:  "info",
			Format: "text",
		},
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	dur, err := time.ParseDuration(cfg.Snapshot.Interval)
	if err != nil {
		return nil, fmt.Errorf("invalid snapshot.interval %q: %w", cfg.Snapshot.Interval, err)
	}
	cfg.Snapshot.parsed = dur

	return cfg, cfg.validate()
}

func (c *Config) validate() error {
	if c.MQTT.Server == "" {
		return fmt.Errorf("mqtt.server is required")
	}
	if c.MQTT.Port < 1 || c.MQTT.Port > 65535 {
		return fmt.Errorf("mqtt.port must be 1-65535")
	}
	if c.MQTT.ClientID == "" {
		return fmt.Errorf("mqtt.client_id is required")
	}
	if c.Span.DeviceID == "" {
		return fmt.Errorf("span.device_id is required")
	}
	if c.Snapshot.parsed < 100*time.Millisecond {
		return fmt.Errorf("snapshot.interval must be >= 100ms")
	}
	if c.Snapshot.OutputTopic == "" {
		return fmt.Errorf("snapshot.output_topic is required")
	}
	if c.Snapshot.QoS > 2 {
		return fmt.Errorf("snapshot.qos must be 0, 1, or 2")
	}
	if c.MQTT.CACert != "" {
		if _, err := os.Stat(c.MQTT.CACert); err != nil {
			return fmt.Errorf("mqtt.ca_cert not readable: %w", err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

func SetupLogger(cfg LoggingConfig) *slog.Logger {
	var level slog.Level
	switch strings.ToLower(cfg.Level) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	if strings.ToLower(cfg.Format) == "json" {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		handler = slog.NewTextHandler(os.Stderr, opts)
	}
	return slog.New(handler)
}
