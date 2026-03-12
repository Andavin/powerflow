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

const version = "4.0.0"

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
		"write_interval", cfg.QuestDB.WriteInterval,
		"questdb", fmt.Sprintf("%s:%d", cfg.QuestDB.Host, cfg.QuestDB.ILPPort),
		"tls", cfg.MQTT.CACert != "",
		"log_level", cfg.Logging.Level,
	)

	// ---- State --------------------------------------------------------
	state := NewState(cfg.Span.DeviceID, logger)

	// ---- MQTT client --------------------------------------------------
	client, err := createMQTTClient(cfg, logger)
	if err != nil {
		logger.Error("failed to create MQTT client", "error", err)
		os.Exit(1)
	}

	logger.Info("connecting to MQTT broker", "url", cfg.MQTT.BrokerURL())
	token := client.Connect()
	if !token.WaitTimeout(15 * time.Second) {
		logger.Error("MQTT connect timed out")
		os.Exit(1)
	}
	if token.Error() != nil {
		logger.Error("MQTT connect failed", "error", token.Error())
		os.Exit(1)
	}
	defer client.Disconnect(1000)

	// ---- Subscriber ---------------------------------------------------
	collector := NewCollector(client, state, cfg.Span, logger)
	if err := collector.Subscribe(); err != nil {
		logger.Error("subscription failed", "error", err)
		os.Exit(1)
	}

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

	// Writer goroutine — keeps QuestDB writes off the main loop so
	// MQTT message reception is never blocked by ILP flushes.
	// Buffer absorbs bursts; blocking send ensures no tick is ever dropped.
	snapCh := make(chan struct{}, 16)
	var writerWg sync.WaitGroup
	writerWg.Add(1)
	go func() {
		defer writerWg.Done()
		for range snapCh {
			deltas := energyTracker.Process(state)
			if err := qdbWriter.WriteSnapshot(state, deltas); err != nil {
				logger.Error("QuestDB write failed", "error", err)
			}
		}
	}()

	// ---- Signal handling ----------------------------------------------
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// ---- Snapshot loop ------------------------------------------------
	ticker := time.NewTicker(cfg.QuestDB.parsed)
	defer ticker.Stop()

	var snapCount uint64

	logger.Info("snapshot loop started — send SIGINT/SIGTERM to stop")

	for {
		select {
		case <-ticker.C:
			msgCount, nodeCount, circuitCount, lastUpdate := state.Stats()
			if msgCount == 0 {
				logger.Warn("no SPAN data received yet, skipping snapshot")
				continue
			}

			snapCh <- struct{}{}
			snapCount++
			logger.Info("snapshot queued",
				"cycle", snapCount,
				"nodes", nodeCount,
				"circuits", circuitCount,
				"msgs_received", msgCount,
				"last_span_update", lastUpdate.Format(time.RFC3339),
			)

		case sig := <-sigCh:
			logger.Info("shutting down",
				"signal", sig,
				"total_snapshots", snapCount,
			)
			close(snapCh)
			writerWg.Wait()
			qdbWriter.Close()
			client.Disconnect(1000)
			logger.Info("shutdown complete")
			return
		}
	}
}

// ---------------------------------------------------------------------------
// MQTT client factory
// ---------------------------------------------------------------------------

func createMQTTClient(cfg *Config, logger *slog.Logger) (mqtt.Client, error) {
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
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(5 * time.Second)
	opts.SetConnectTimeout(10 * time.Second)
	opts.SetOrderMatters(false)

	opts.SetOnConnectHandler(func(_ mqtt.Client) {
		logger.Info("MQTT connected", "broker", cfg.MQTT.BrokerURL())
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
