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
	MQTT    MQTTConfig    `yaml:"mqtt"`
	Span    SpanConfig    `yaml:"span"`
	QuestDB QuestDBConfig `yaml:"questdb"`
	Logging LoggingConfig `yaml:"logging"`
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

	// ReadinessGrace bounds how long the collector waits for every described
	// property to arrive before flushing a node's first row. After this
	// elapses, the node is marked ready with whatever has been received and
	// missing properties are logged. Empty/zero disables the fallback
	// (strict-only behavior — nodes whose description lists properties the
	// panel never publishes will never flush).
	ReadinessGrace string `yaml:"readiness_grace"`

	parsedReadinessGrace time.Duration
}

func (s *SpanConfig) SubscribeTopic() string {
	return s.TopicPrefix + "/" + s.DeviceID + "/#"
}

func (s *SpanConfig) TopicBase() string {
	return s.TopicPrefix + "/" + s.DeviceID + "/"
}

type QuestDBConfig struct {
	Host          string `yaml:"host"`
	ILPPort       int    `yaml:"ilp_port"`
	HTTPPort      int    `yaml:"http_port"`
	CreateTables  bool   `yaml:"create_tables"`
	WriteInterval string `yaml:"write_interval"`

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
# periodically snapshots the full state, and writes structured
# time-series data to QuestDB.

# MQTT broker connection (subscribes to SPAN panel data)
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
  # How long to wait for every described property of a node to arrive before
  # the node is marked "ready" with whatever has been received. Properties
  # the panel never publishes (e.g., dipole on single-pole circuits) would
  # otherwise block the node forever. Set to "0" for strict-only behavior.
  readiness_grace: "3s"

# QuestDB time-series database
questdb:
  # QuestDB host
  host: "127.0.0.1"
  # ILP/TCP port — no longer used for ingestion (moved to ILP-over-HTTP);
  # retained for backwards compatibility with existing configs.
  ilp_port: 9009
  # HTTP API port — used for DDL (table creation) AND ILP ingestion (/write).
  # ILP-over-HTTP reports per-line errors and isolates a bad row to its own
  # table instead of dropping the connection and the rest of the batch.
  http_port: 9000
  # Auto-create tables on startup (PARTITION BY DAY, WAL, DEDUP)
  create_tables: true
  # How often to flush buffered updates to QuestDB
  # Go duration format: "1s", "5s", "30s", "1m", etc.
  write_interval: "5s"

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
	return ParseConfig(data)
}

func ParseConfig(data []byte) (*Config, error) {
	cfg := &Config{
		MQTT: MQTTConfig{
			Server:   "127.0.0.1",
			Port:     1883,
			ClientID: "span-collector",
		},
		Span: SpanConfig{
			TopicPrefix:    "ebus/5",
			ReadinessGrace: "3s",
		},
		QuestDB: QuestDBConfig{
			Host:          "127.0.0.1",
			ILPPort:       9009,
			HTTPPort:      9000,
			CreateTables:  true,
			WriteInterval: "5s",
		},
		Logging: LoggingConfig{
			Level:  "info",
			Format: "text",
		},
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	dur, err := time.ParseDuration(cfg.QuestDB.WriteInterval)
	if err != nil {
		return nil, fmt.Errorf("invalid questdb.write_interval %q: %w", cfg.QuestDB.WriteInterval, err)
	}
	cfg.QuestDB.parsed = dur

	if cfg.Span.ReadinessGrace == "" {
		cfg.Span.parsedReadinessGrace = 3 * time.Second
	} else {
		grace, err := time.ParseDuration(cfg.Span.ReadinessGrace)
		if err != nil {
			return nil, fmt.Errorf("invalid span.readiness_grace %q: %w", cfg.Span.ReadinessGrace, err)
		}
		if grace < 0 {
			return nil, fmt.Errorf("span.readiness_grace must be >= 0, got %s", grace)
		}
		cfg.Span.parsedReadinessGrace = grace
	}

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
	if c.MQTT.CACert != "" {
		if _, err := os.Stat(c.MQTT.CACert); err != nil {
			return fmt.Errorf("mqtt.ca_cert not readable: %w", err)
		}
	}
	if c.QuestDB.Host == "" {
		return fmt.Errorf("questdb.host is required")
	}
	if c.QuestDB.ILPPort < 1 || c.QuestDB.ILPPort > 65535 {
		return fmt.Errorf("questdb.ilp_port must be 1-65535")
	}
	if c.QuestDB.HTTPPort < 1 || c.QuestDB.HTTPPort > 65535 {
		return fmt.Errorf("questdb.http_port must be 1-65535")
	}
	if c.QuestDB.parsed < 100*time.Millisecond {
		return fmt.Errorf("questdb.write_interval must be >= 100ms")
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
