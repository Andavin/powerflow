package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
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
	Health  HealthConfig  `yaml:"health"`
	Logging LoggingConfig `yaml:"logging"`
}

// HealthConfig controls the observability endpoint and optional alerting.
type HealthConfig struct {
	// Port serves GET /healthz (200 healthy, 503 degraded). 0 disables it; the
	// self-restart watchdog still runs regardless, so data-loss protection does
	// not depend on this being enabled.
	Port int `yaml:"port"`
	// AlertWebhook, when set, is POSTed a short text alert on degrade/recovery
	// (e.g. an https://ntfy.sh/<topic> URL for a phone push). Empty disables it.
	AlertWebhook string `yaml:"alert_webhook"`
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

	// StrictSchema, when true, drops properties a described node publishes that
	// its $description does not declare, so unexpected firmware fields can't
	// auto-create columns on a typed table. Pinned columns and `name` are always
	// kept (powerflow depends on them). Default false: enable only after
	// confirming the logs don't show a column you need being dropped.
	StrictSchema bool `yaml:"strict_schema"`

	parsedReadinessGrace time.Duration
}

// SubscribeTopics returns the MQTT topic filters the collector subscribes to.
// Two single-level (`+`) filters instead of one multi-level (`#`) wildcard:
//
//   - "<prefix>/<device>/+"    device-level attributes ($state, $description)
//   - "<prefix>/<device>/+/+"  node property values (<node>/<property>)
//
// A property value in Homie 5 is always exactly <node>/<property> (2 levels),
// so this structurally excludes 3-level command/attribute sub-topics such as
// "<node>/<property>/set" — the poison topics never reach the collector. This
// is a transport-layer second layer; parseTopic's guard and the ILP
// column-name validation remain the authoritative defense.
func (s *SpanConfig) SubscribeTopics() []string {
	base := s.TopicPrefix + "/" + s.DeviceID
	return []string{base + "/+", base + "/+/+"}
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
	// SpoolDir, when set, is where batches that failed to send during a QuestDB
	// outage overflow to disk (in-memory retry always happens). Empty keeps
	// retries in memory only. Mount it on a volume to survive restarts.
	SpoolDir string `yaml:"spool_dir"`
	// SpoolMemCap bounds how much failed-batch data is retained in memory before
	// the oldest spills to the on-disk overflow file (needs spool_dir). A binary
	// size like "32MiB" (default). Lower it (e.g. "256KiB") so buffered data
	// reaches disk sooner — more survives a collector restart during an outage.
	SpoolMemCap string `yaml:"spool_mem_cap"`
	// SpoolFileCap bounds the on-disk overflow file so a long outage can't fill
	// the disk. Binary size, default "256MiB".
	SpoolFileCap string `yaml:"spool_file_cap"`

	parsed        time.Duration
	parsedMemCap  int
	parsedFileCap int
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
  # SPAN panel device ID (serial number) — replace with your panel's serial
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

# Health / alerting (observability; the self-restart watchdog runs regardless)
health:
  # Port for GET /healthz (200 healthy, 503 when a table is rejecting writes).
  # 0 disables the endpoint.
  port: 0
  # Optional: POSTed a short text alert on degrade/recovery. An
  # https://ntfy.sh/<your-topic> URL gives a zero-config phone push. Empty = off.
  alert_webhook: ""

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

// LoadConfig reads config from a YAML file (if present) and then applies
// SPAN_* environment overrides. The file is optional: when it's missing, the
// collector runs entirely from environment variables (plus built-in defaults),
// which is how it's driven under docker compose. A path that exists but can't
// be read is still an error.
func LoadConfig(path string) (*Config, error) {
	var data []byte
	if path != "" {
		b, err := os.ReadFile(path)
		switch {
		case err == nil:
			data = b
		case errors.Is(err, os.ErrNotExist):
			// No file — rely on defaults + environment overrides.
		default:
			return nil, fmt.Errorf("read config: %w", err)
		}
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

	if len(data) > 0 {
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	}

	// Environment overrides win over the file, so the same value (e.g. the MQTT
	// password) can live in a single .env shared with the rest of the stack.
	if err := applyEnvOverrides(cfg); err != nil {
		return nil, err
	}

	dur, err := time.ParseDuration(cfg.QuestDB.WriteInterval)
	if err != nil {
		return nil, fmt.Errorf("invalid questdb.write_interval %q: %w", cfg.QuestDB.WriteInterval, err)
	}
	cfg.QuestDB.parsed = dur

	memCap, err := parseByteSize(cfg.QuestDB.SpoolMemCap, spoolMemCap)
	if err != nil {
		return nil, fmt.Errorf("invalid questdb.spool_mem_cap %q: %w", cfg.QuestDB.SpoolMemCap, err)
	}
	cfg.QuestDB.parsedMemCap = memCap

	fileCap, err := parseByteSize(cfg.QuestDB.SpoolFileCap, spoolFileCap)
	if err != nil {
		return nil, fmt.Errorf("invalid questdb.spool_file_cap %q: %w", cfg.QuestDB.SpoolFileCap, err)
	}
	cfg.QuestDB.parsedFileCap = fileCap

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

// applyEnvOverrides layers SPAN_* environment variables on top of whatever the
// file (or defaults) provided. Only variables that are actually set take
// effect, so a partial environment leaves the rest untouched.
func applyEnvOverrides(cfg *Config) error {
	envStr("SPAN_MQTT_SERVER", &cfg.MQTT.Server)
	if err := envInt("SPAN_MQTT_PORT", &cfg.MQTT.Port); err != nil {
		return err
	}
	envStr("SPAN_MQTT_CLIENT_ID", &cfg.MQTT.ClientID)
	envStr("SPAN_MQTT_USERNAME", &cfg.MQTT.Username)
	envStr("SPAN_MQTT_PASSWORD", &cfg.MQTT.Password)
	envStr("SPAN_MQTT_CA_CERT", &cfg.MQTT.CACert)

	envStr("SPAN_TOPIC_PREFIX", &cfg.Span.TopicPrefix)
	envStr("SPAN_DEVICE_ID", &cfg.Span.DeviceID)
	envStr("SPAN_READINESS_GRACE", &cfg.Span.ReadinessGrace)
	if err := envBool("SPAN_STRICT_SCHEMA", &cfg.Span.StrictSchema); err != nil {
		return err
	}

	envStr("SPAN_QUESTDB_HOST", &cfg.QuestDB.Host)
	if err := envInt("SPAN_QUESTDB_ILP_PORT", &cfg.QuestDB.ILPPort); err != nil {
		return err
	}
	if err := envInt("SPAN_QUESTDB_HTTP_PORT", &cfg.QuestDB.HTTPPort); err != nil {
		return err
	}
	envStr("SPAN_QUESTDB_WRITE_INTERVAL", &cfg.QuestDB.WriteInterval)
	envStr("SPAN_QUESTDB_SPOOL_DIR", &cfg.QuestDB.SpoolDir)
	envStr("SPAN_QUESTDB_SPOOL_MEM_CAP", &cfg.QuestDB.SpoolMemCap)
	envStr("SPAN_QUESTDB_SPOOL_FILE_CAP", &cfg.QuestDB.SpoolFileCap)
	if err := envBool("SPAN_QUESTDB_CREATE_TABLES", &cfg.QuestDB.CreateTables); err != nil {
		return err
	}

	if err := envInt("SPAN_HEALTH_PORT", &cfg.Health.Port); err != nil {
		return err
	}
	envStr("SPAN_ALERT_WEBHOOK", &cfg.Health.AlertWebhook)

	envStr("SPAN_LOG_LEVEL", &cfg.Logging.Level)
	envStr("SPAN_LOG_FORMAT", &cfg.Logging.Format)
	return nil
}

// envStr overwrites *dst when key is set (even to an empty string, so an
// explicit blank can clear a value).
func envStr(key string, dst *string) {
	if v, ok := os.LookupEnv(key); ok {
		*dst = v
	}
}

func envInt(key string, dst *int) error {
	v, ok := os.LookupEnv(key)
	if !ok {
		return nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fmt.Errorf("env %s: %w", key, err)
	}
	*dst = n
	return nil
}

func envBool(key string, dst *bool) error {
	v, ok := os.LookupEnv(key)
	if !ok {
		return nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fmt.Errorf("env %s: %w", key, err)
	}
	*dst = b
	return nil
}

// parseByteSize parses a human byte size into a byte count. An empty string
// yields def. Units are binary: KiB=1024, MiB=1024², GiB=1024³; the decimal
// spellings KB/MB/GB are accepted as case-insensitive aliases for those same
// binary units, and a plain number or a "B" suffix is raw bytes. Negatives are
// rejected, as are values above 1 TiB (which also guards the scaling below from
// overflowing).
func parseByteSize(s string, def int) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return def, nil
	}
	up := strings.ToUpper(s)
	var mult int64 = 1
	// Longer (binary) suffixes first so "MIB" isn't matched by the "B" rule.
	for _, u := range []struct {
		suffix string
		mult   int64
	}{
		{"GIB", 1 << 30}, {"MIB", 1 << 20}, {"KIB", 1 << 10},
		{"GB", 1 << 30}, {"MB", 1 << 20}, {"KB", 1 << 10}, {"B", 1},
	} {
		if strings.HasSuffix(up, u.suffix) {
			mult = u.mult
			up = strings.TrimSpace(strings.TrimSuffix(up, u.suffix))
			break
		}
	}
	n, err := strconv.ParseInt(up, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("not a byte size (e.g. %q): %q", "32MiB", s)
	}
	if n < 0 {
		return 0, fmt.Errorf("must be >= 0, got %d", n)
	}
	// Bound well below the int64/int limits so n*mult can't overflow; 1 TiB is
	// far above any sane spool cap.
	const maxBytes = int64(1) << 40
	if n > maxBytes/mult {
		return 0, fmt.Errorf("byte size exceeds the 1TiB maximum: %q", s)
	}
	return int(n * mult), nil
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
	if c.Health.Port != 0 && (c.Health.Port < 1 || c.Health.Port > 65535) {
		return fmt.Errorf("health.port must be 0 (disabled) or 1-65535")
	}
	if c.QuestDB.parsed < 100*time.Millisecond {
		return fmt.Errorf("questdb.write_interval must be >= 100ms")
	}
	// Caps are always positive after parsing (an unset value resolves to the
	// default). An explicit 0 is rejected here rather than silently defaulted, so
	// there's no ambiguity between "unset" and "zero".
	if c.QuestDB.parsedMemCap <= 0 {
		return fmt.Errorf("questdb.spool_mem_cap must be > 0")
	}
	if c.QuestDB.parsedFileCap <= 0 {
		return fmt.Errorf("questdb.spool_file_cap must be > 0")
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
