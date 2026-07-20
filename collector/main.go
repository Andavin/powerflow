package main

import (
	"crypto/tls"
	"crypto/x509"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

const version = "5.0.0"

// Watchdog: the SPAN panel publishes continuously (power flows roughly every
// second), so a prolonged silence means the subscription has gone dead even if
// the TCP/TLS connection looks alive (e.g. a broker that dropped our sub without
// closing the socket). Rather than sit idle forever, the collector exits so its
// supervisor (Docker `restart: unless-stopped`) restarts it and re-subscribes.
const (
	staleDataThreshold = 5 * time.Minute
	staleCheckInterval = 30 * time.Second
	// watchdogRejectExit is the per-table consecutive-rejection count at which
	// the collector exits for a supervisor restart (self-heal should clear a
	// bad column long before this; reaching it means the failure is persistent
	// and unattributable). ~2 min at a 5s flush.
	watchdogRejectExit = 24
)

// pendingWrite is a node snapshot queued for the next ILP flush.
type pendingWrite struct {
	nodeID string
	props  map[string]interface{}
	ts     time.Time
}

func main() {
	cfgPath := flag.String("config", "/config/config.yml", "path to YAML config file (optional; SPAN_* env vars override it)")
	showVer := flag.Bool("version", false, "print version and exit")
	initCfg := flag.Bool("init", false, "write a starter config file to -config and exit")
	flag.Parse()

	if *showVer {
		fmt.Printf("span-collector v%s\n", version)
		return
	}

	// ---- Config -------------------------------------------------------
	// `-init` explicitly scaffolds a starter file; normal startup treats a
	// missing config as "use defaults + SPAN_* env" so the collector can run
	// with no file at all (e.g. under docker compose).
	if *initCfg {
		if err := WriteDefaultConfig(*cfgPath); err != nil {
			fmt.Fprintf(os.Stderr, "ERROR: failed to write default config: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Default config written to %s — edit it and restart\n", *cfgPath)
		return
	}

	cfg, err := LoadConfig(*cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}

	logger := SetupLogger(cfg.Logging)
	slog.SetDefault(logger)

	logger.Info("starting span-collector",
		"version", version,
		"broker", cfg.MQTT.BrokerURL(),
		"client_id", cfg.MQTT.ClientID,
		"device_id", cfg.Span.DeviceID,
		"subscribe", cfg.Span.SubscribeTopics(),
		"flush_interval", cfg.QuestDB.WriteInterval,
		"questdb", fmt.Sprintf("http://%s:%d/write", cfg.QuestDB.Host, cfg.QuestDB.HTTPPort),
		"tls", cfg.MQTT.CACert != "",
		"log_level", cfg.Logging.Level,
	)

	// ---- State --------------------------------------------------------
	state := NewState(cfg.Span.DeviceID, logger, cfg.Span.parsedReadinessGrace)

	// ---- QuestDB ------------------------------------------------------
	qdbWriter, err := NewQuestDBWriter(cfg.QuestDB, cfg.Span.DeviceID, logger)
	if err != nil {
		logger.Error("failed to connect to QuestDB", "error", err)
		os.Exit(1)
	}

	if cfg.QuestDB.CreateTables {
		if err := qdbWriter.CreateTables(); err != nil {
			logger.Error("failed to create QuestDB tables", "error", err)
			os.Exit(1)
		}
	}

	// Warn (non-fatal) if any live column type disagrees with a pin — e.g. a
	// column that pre-dates the pin and was never migrated would silently
	// reject this table's rows. Runs after CreateTables so added columns exist.
	qdbWriter.VerifyPinnedColumns()

	energyTracker := NewEnergyTracker(logger)

	// ---- Update channel -----------------------------------------------
	// MQTT property updates queue per-node writes here. Sends are non-blocking
	// (drop-on-full — see onUpdate). The channel is deliberately never closed:
	// onUpdate runs on Paho handler goroutines that can still fire briefly after
	// Disconnect, and a send on a closed channel panics. The writer stops on
	// writerStop instead, then drains what's buffered.
	updateCh := make(chan pendingWrite, 1024)
	writerStop := make(chan struct{})

	// ---- Writer goroutine ---------------------------------------------
	// Accumulates node updates and flushes to QuestDB on a timer.
	var writerWg sync.WaitGroup
	writerWg.Add(1)
	strictSchema := cfg.Span.StrictSchema
	pinnedCols := allPinnedColumns()
	go func() {
		defer writerWg.Done()
		ticker := time.NewTicker(cfg.QuestDB.parsed)
		defer ticker.Stop()

		var batch []pendingWrite
		var flushCount uint64

		for {
			select {
			case pw := <-updateCh:
				batch = append(batch, pw)

			case <-ticker.C:
				flushBatch(batch, qdbWriter, energyTracker, state, strictSchema, pinnedCols, logger, &flushCount)
				batch = batch[:0]

			case <-writerStop:
				// Shutdown: the MQTT client is already disconnected, so no more
				// updates are coming. Drain whatever is still buffered, do a
				// final flush, and exit.
				for {
					select {
					case pw := <-updateCh:
						batch = append(batch, pw)
					default:
						flushBatch(batch, qdbWriter, energyTracker, state, strictSchema, pinnedCols, logger, &flushCount)
						return
					}
				}
			}
		}
	}()

	// ---- Collector + MQTT client --------------------------------------
	// onUpdate fires for every MQTT property update once a node is ready.
	// On BecameReady, it queues the initial snapshot for that node.
	//
	// The send is non-blocking: this runs on Paho's message-handler goroutine,
	// so a blocking send would stall MQTT processing (and could drop the broker
	// connection) whenever the writer is backed up, e.g. during a QuestDB
	// outage. Under sustained backpressure we drop the snapshot instead — the
	// next update for the node re-snapshots its full current state, and energy
	// deltas are computed from live state on the flush timer regardless, so a
	// dropped snapshot loses at most one instant, never the running totals.
	var droppedWrites uint64
	onUpdate := func(result UpdateResult) {
		if result.BecameReady {
			logger.Info("node ready — all described properties received", "node", result.NodeID)
		}
		select {
		case updateCh <- pendingWrite{
			nodeID: result.NodeID,
			props:  state.NodeValues(result.NodeID),
			ts:     result.Timestamp,
		}:
		default:
			if n := atomic.AddUint64(&droppedWrites, 1); n == 1 || n%500 == 0 {
				logger.Warn("update channel full; dropping node snapshot (writer backed up)",
					"node", result.NodeID, "dropped_total", n)
			}
		}
	}

	collector := NewCollector(state, cfg.Span, logger, onUpdate)

	// The MQTT client subscribes from inside its OnConnect handler so that
	// re-subscribe happens automatically on every reconnect (the panel
	// rotates its TLS cert daily and force-disconnects, and CleanSession
	// defaults to true so the broker forgets subscriptions on drop).
	client, err := createMQTTClient(cfg, logger, collector.OnMessage)
	if err != nil {
		logger.Error("failed to create MQTT client", "error", err)
		os.Exit(1)
	}

	logger.Info("connecting to MQTT broker", "url", cfg.MQTT.BrokerURL())
	token := client.Connect()
	if !token.WaitTimeout(15 * time.Second) {
		// With SetConnectRetry(false) the token should normally complete
		// (success or specific failure). A timeout here means the broker
		// never produced a CONNACK or TLS handshake — i.e. unreachable.
		if err := token.Error(); err != nil {
			logger.Error("MQTT connect failed (timed out waiting for completion)", "error", err)
		} else {
			logger.Error("MQTT connect timed out — broker unreachable or unresponsive",
				"url", cfg.MQTT.BrokerURL())
		}
		os.Exit(1)
	}
	if err := token.Error(); err != nil {
		logger.Error("MQTT connect failed", "error", err)
		os.Exit(1)
	}
	// Subscribe is handled by the OnConnect handler — no explicit call
	// needed here. Disconnect is called explicitly during graceful shutdown
	// after the writer drains; no defer needed here.

	// ---- Health endpoint + watchdog -----------------------------------
	healthSrv := startHealthServer(cfg.Health.Port, qdbWriter, logger)
	watchdogStop := make(chan struct{})
	go runWatchdog(state, qdbWriter, cfg.Health.AlertWebhook, logger, watchdogStop)

	// ---- Signal handling ----------------------------------------------
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	logger.Info("waiting for $description and initial data — send SIGINT/SIGTERM to stop")

	sig := <-sigCh
	logger.Info("shutting down", "signal", sig)
	close(watchdogStop) // stop the watchdog before draining so it can't exit(1) mid-shutdown
	if healthSrv != nil {
		healthSrv.Close()
	}
	// Disconnect the MQTT client first so no more updates are queued, THEN stop
	// the writer. updateCh is never closed, so a late Paho handler goroutine that
	// slips past Disconnect still can't panic on send — it just drops or buffers.
	client.Disconnect(1000)
	close(writerStop)
	writerWg.Wait()
	qdbWriter.Close()
	logger.Info("shutdown complete")
}

func flushBatch(batch []pendingWrite, qdb *QuestDBWriter, energy *EnergyTracker, state *State, strictSchema bool, pins map[string]bool, logger *slog.Logger, count *uint64) {
	if len(batch) == 0 {
		return
	}

	for _, pw := range batch {
		props := pw.props
		described := state.IsDescribedNode(pw.nodeID)
		if strictSchema && described {
			if declared, ok := state.DescribedProperties(pw.nodeID); ok {
				props = filterToAllowed(pw.nodeID, props, declared, pins, logger)
			}
		}
		qdb.WriteNodeUpdate(pw.nodeID, props, pw.ts, described)
	}

	deltas := energy.Process(state)
	qdb.WriteEnergyDeltas(deltas)

	if err := qdb.Flush(); err != nil {
		logger.Error("QuestDB flush failed", "error", err)
	}

	*count++
	logger.Info("batch flushed",
		"cycle", *count,
		"updates", len(batch),
		"deltas", len(deltas),
	)
}

// filterToAllowed drops properties a described node published that its
// $description does not declare, keeping declared properties, any pinned column,
// and `name` (all of which powerflow / the type pins may depend on). Dropped
// properties are logged so an operator can see what strict schema is removing.
func filterToAllowed(nodeID string, props map[string]interface{}, declared, pins map[string]bool, logger *slog.Logger) map[string]interface{} {
	out := make(map[string]interface{}, len(props))
	var dropped []string
	for k, v := range props {
		col := propToColumn(k)
		if declared[k] || pins[col] || col == "name" {
			out[k] = v
		} else {
			dropped = append(dropped, k)
		}
	}
	if len(dropped) > 0 {
		logger.Debug("strict-schema dropped undeclared properties", "node", nodeID, "dropped", dropped)
	}
	return out
}

// runWatchdog escalates two silent-failure modes a supervisor can recover from:
//
//  1. Total MQTT silence for staleDataThreshold (subscription went dead).
//  2. A QuestDB table rejecting writes continuously — self-heal quarantines a
//     bad column within a flush, so a streak that keeps climbing means the
//     failure is unattributable/persistent and a restart is the last resort.
//
// It also emits degrade/recovery alerts (to alertWebhook, if configured) so a
// partial stall is noticed in minutes rather than days. Returns when stop is
// closed during shutdown.
func runWatchdog(state *State, writer *QuestDBWriter, alertWebhook string, logger *slog.Logger, stop <-chan struct{}) {
	ticker := time.NewTicker(staleCheckInterval)
	defer ticker.Stop()
	degraded := false
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			// (1) Total silence — no MQTT at all.
			if _, _, _, last := state.Stats(); !last.IsZero() {
				if age := time.Since(last); age > staleDataThreshold {
					logger.Error("no MQTT data received within threshold; exiting for supervisor restart",
						"stale_for", age.Round(time.Second), "threshold", staleDataThreshold)
					os.Exit(1)
				}
			}

			// (2) Per-table rejection stall.
			table, streak := writer.worstStreak()
			switch {
			case streak >= watchdogRejectExit:
				logger.Error("QuestDB table rejecting writes continuously; exiting for supervisor restart",
					"table", table, "streak", streak)
				postAlert(alertWebhook, "span-collector restarting",
					fmt.Sprintf("table %s stuck rejecting (streak %d) — restarting", table, streak), logger)
				os.Exit(1)
			case streak >= healthDegradeStreak && !degraded:
				degraded = true
				logger.Error("QuestDB table degraded (rejecting writes)", "table", table, "streak", streak)
				postAlert(alertWebhook, "span-collector degraded",
					fmt.Sprintf("QuestDB table %s rejecting writes (streak %d)", table, streak), logger)
			case streak < healthDegradeStreak && degraded:
				degraded = false
				logger.Info("QuestDB writes recovered")
				postAlert(alertWebhook, "span-collector recovered", "QuestDB writes healthy again", logger)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// MQTT client factory
// ---------------------------------------------------------------------------

// subscribeTimeout bounds the wait for SUBACK from inside the OnConnect
// handler. A broker that accepts the TCP/TLS handshake but never responds
// to SUBSCRIBE would otherwise hang Paho's connect goroutine forever.
const subscribeTimeout = 10 * time.Second

func createMQTTClient(cfg *Config, logger *slog.Logger, msgHandler mqtt.MessageHandler) (mqtt.Client, error) {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(cfg.MQTT.BrokerURL())
	opts.SetClientID(cfg.MQTT.ClientID)

	if cfg.MQTT.Username != "" {
		opts.SetUsername(cfg.MQTT.Username)
		opts.SetPassword(cfg.MQTT.Password)
	}

	if cfg.MQTT.CACert != "" {
		tlsCfg, err := buildTLSConfig(cfg.MQTT.CACert)
		if err != nil {
			return nil, err
		}
		opts.SetTLSConfig(tlsCfg)
	}

	opts.SetAutoReconnect(true)
	opts.SetMaxReconnectInterval(30 * time.Second)
	// SetConnectRetry(false) so the FIRST connect surfaces the real failure
	// (auth rejection, DNS error, TLS hostname mismatch, ...) instead of
	// silently retrying forever and looking like a generic timeout.
	// SetAutoReconnect(true) above still handles drops after a successful
	// initial connect, so reconnect behavior in normal operation is unchanged.
	opts.SetConnectRetry(false)
	opts.SetConnectTimeout(10 * time.Second)
	opts.SetOrderMatters(false)

	// Default publish handler routes every incoming message — the
	// per-subscription handler can be nil since this is the only subscription.
	opts.SetDefaultPublishHandler(msgHandler)

	subTopics := cfg.Span.SubscribeTopics()
	filters := make(map[string]byte, len(subTopics))
	for _, t := range subTopics {
		filters[t] = 1 // QoS 1
	}

	// OnConnect fires on initial connect AND every reconnect. Subscribing
	// here (instead of once at startup) guarantees the subscription is
	// re-established after the panel's daily TLS-rotation disconnect.
	// CleanSession defaults to true, so the broker forgets subscriptions
	// across drops; without this re-subscribe we'd reconnect cleanly but
	// receive nothing. SubscribeMultiple registers both `+` filters in one
	// SUBSCRIBE so the two-topic narrowing survives every reconnect too.
	opts.SetOnConnectHandler(func(c mqtt.Client) {
		logger.Info("MQTT connected", "broker", cfg.MQTT.BrokerURL())

		token := c.SubscribeMultiple(filters, nil)
		if !token.WaitTimeout(subscribeTimeout) {
			logger.Error("MQTT subscribe timed out — no SUBACK from broker",
				"topics", subTopics, "timeout", subscribeTimeout)
			return
		}
		if err := token.Error(); err != nil {
			logger.Error("MQTT subscribe failed", "topics", subTopics, "error", err)
			return
		}
		logger.Info("MQTT subscribed", "topics", subTopics)
	})
	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		logger.Warn("MQTT connection lost (auto-reconnect enabled)", "error", err)
	})
	opts.SetReconnectingHandler(func(_ mqtt.Client, _ *mqtt.ClientOptions) {
		logger.Info("MQTT reconnecting...")
	})

	return mqtt.NewClient(opts), nil
}

func buildTLSConfig(caPath string) (*tls.Config, error) {
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("read CA cert %s: %w", caPath, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("CA cert %s contains no valid certificates", caPath)
	}
	return &tls.Config{
		RootCAs:    pool,
		MinVersion: tls.VersionTLS12,
	}, nil
}
