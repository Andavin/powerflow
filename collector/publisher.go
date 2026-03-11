package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// Publisher periodically takes a state snapshot and publishes it to MQTT.
type Publisher struct {
	client mqtt.Client
	state  *State
	cfg    SnapshotConfig
	logger *slog.Logger
}

func NewPublisher(client mqtt.Client, state *State, cfg SnapshotConfig, logger *slog.Logger) *Publisher {
	return &Publisher{
		client: client,
		state:  state,
		cfg:    cfg,
		logger: logger.With("component", "publisher"),
	}
}

// PublishSnapshot takes a full state snapshot and publishes it.
// If per_circuit_topics is enabled, also publishes each circuit individually.
func (p *Publisher) PublishSnapshot() (int, error) {
	published := 0

	// Full snapshot
	snap := p.state.Snapshot()
	if err := p.publishJSON(p.cfg.OutputTopic, snap); err != nil {
		return 0, fmt.Errorf("full snapshot: %w", err)
	}
	published++

	p.logger.Debug("published full snapshot",
		"topic", p.cfg.OutputTopic,
	)

	// Per-circuit topics
	if p.cfg.PerCircuitTopic {
		circuits := p.state.CircuitSnapshots()
		for name, data := range circuits {
			topic := p.circuitTopic(name)
			if err := p.publishJSON(topic, data); err != nil {
				p.logger.Error("failed to publish circuit",
					"circuit", name,
					"topic", topic,
					"error", err,
				)
				continue
			}
			published++
			p.logger.Debug("published circuit snapshot",
				"circuit", name,
				"topic", topic,
			)
		}
	}

	return published, nil
}

func (p *Publisher) publishJSON(topic string, data interface{}) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	token := p.client.Publish(topic, p.cfg.QoS, p.cfg.Retain, payload)
	if !token.WaitTimeout(5 * time.Second) {
		return fmt.Errorf("publish to %s timed out", topic)
	}
	if token.Error() != nil {
		return fmt.Errorf("publish to %s: %w", topic, token.Error())
	}
	return nil
}

func (p *Publisher) circuitTopic(circuitName string) string {
	// Sanitise circuit name for use in MQTT topic
	safe := strings.ReplaceAll(circuitName, " ", "-")
	safe = strings.ReplaceAll(safe, ",", "")
	safe = strings.ReplaceAll(safe, "&", "and")
	safe = strings.ToLower(safe)
	return "span-stats/circuit/" + safe
}
