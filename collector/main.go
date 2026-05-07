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
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

const version = "5.0.0"

// pendingWrite is a node snapshot queued for the next ILP flush.
type pendingWrite struct {
	nodeID string
	props  map[string]interface{}
	ts     time.Time
}

func main() {
	cfgPath := flag.String("config", "/config/config.yml", "path to YAML config file")
	showVer := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVer {
		fmt.Printf("span-collector v%s\n", version)
		return
	}

	// ---- Config -------------------------------------------------------
	if _, err := os.Stat(*cfgPath); os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "Config not found at %s — generating default config\n", *cfgPath)
		if err := WriteDefaultConfig(*cfgPath); err != nil {
			fmt.Fprintf(os.Stderr, "ERROR: failed to write default config: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Default config written to %s — edit it and restart\n", *cfgPath)
		os.Exit(0)
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
		"subscribe", cfg.Span.SubscribeTopic(),
		"flush_interval", cfg.QuestDB.WriteInterval,
		"questdb", fmt.Sprintf("%s:%d", cfg.QuestDB.Host, cfg.QuestDB.ILPPort),
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

	energyTracker := NewEnergyTracker(logger)

	// ---- Update channel -----------------------------------------------
	// MQTT property updates queue per-node writes here.
	// Blocking send ensures no update is ever dropped.
	updateCh := make(chan pendingWrite, 1024)

	// ---- Writer goroutine ---------------------------------------------
	// Accumulates node updates and flushes to QuestDB on a timer.
	var writerWg sync.WaitGroup
	writerWg.Add(1)
	go func() {
		defer writerWg.Done()
		ticker := time.NewTicker(cfg.QuestDB.parsed)
		defer ticker.Stop()

		var batch []pendingWrite
		var flushCount uint64

		for {
			select {
			case pw, ok := <-updateCh:
				if !ok {
					// Channel closed — flush remaining and exit
					flushBatch(batch, qdbWriter, energyTracker, state, logger, &flushCount)
					return
				}
				batch = append(batch, pw)

			case <-ticker.C:
				flushBatch(batch, qdbWriter, energyTracker, state, logger, &flushCount)
				batch = batch[:0]
			}
		}
	}()

	// ---- Collector + MQTT client --------------------------------------
	// onUpdate fires for every MQTT property update once a node is ready.
	// On BecameReady, it queues the initial snapshot for that node.
	onUpdate := func(result UpdateResult) {
		if result.BecameReady {
			logger.Info("node ready — all described properties received", "node", result.NodeID)
		}
		updateCh <- pendingWrite{
			nodeID: result.NodeID,
			props:  state.NodeValues(result.NodeID),
			ts:     result.Timestamp,
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

	// ---- Signal handling ----------------------------------------------
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	logger.Info("waiting for $description and initial data — send SIGINT/SIGTERM to stop")

	sig := <-sigCh
	logger.Info("shutting down", "signal", sig)
	close(updateCh)
	writerWg.Wait()
	qdbWriter.Close()
	client.Disconnect(1000)
	logger.Info("shutdown complete")
}

func flushBatch(batch []pendingWrite, qdb *QuestDBWriter, energy *EnergyTracker, state *State, logger *slog.Logger, count *uint64) {
	if len(batch) == 0 {
		return
	}

	for _, pw := range batch {
		qdb.WriteNodeUpdate(pw.nodeID, pw.props, pw.ts, state.IsDescribedNode(pw.nodeID))
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

	subTopic := cfg.Span.SubscribeTopic()

	// OnConnect fires on initial connect AND every reconnect. Subscribing
	// here (instead of once at startup) guarantees the subscription is
	// re-established after the panel's daily TLS-rotation disconnect.
	// CleanSession defaults to true, so the broker forgets subscriptions
	// across drops; without this re-subscribe we'd reconnect cleanly but
	// receive nothing.
	opts.SetOnConnectHandler(func(c mqtt.Client) {
		logger.Info("MQTT connected", "broker", cfg.MQTT.BrokerURL())

		token := c.Subscribe(subTopic, 1, nil)
		if !token.WaitTimeout(subscribeTimeout) {
			logger.Error("MQTT subscribe timed out — no SUBACK from broker",
				"topic", subTopic, "timeout", subscribeTimeout)
			return
		}
		if err := token.Error(); err != nil {
			logger.Error("MQTT subscribe failed", "topic", subTopic, "error", err)
			return
		}
		logger.Info("MQTT subscribed", "topic", subTopic)
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
