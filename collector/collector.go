package main

import (
	"log/slog"
	"strings"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// Collector subscribes to the SPAN panel's MQTT topics and updates State.
type Collector struct {
	client    mqtt.Client
	state     *State
	topicBase string // e.g. "ebus/5/REPLACE-WITH-YOUR-PANEL-SERIAL/"
	subTopic  string // e.g. "ebus/5/REPLACE-WITH-YOUR-PANEL-SERIAL/#"
	logger    *slog.Logger
}

func NewCollector(client mqtt.Client, state *State, cfg SpanConfig, logger *slog.Logger) *Collector {
	return &Collector{
		client:    client,
		state:     state,
		topicBase: cfg.TopicBase(),
		subTopic:  cfg.SubscribeTopic(),
		logger:    logger.With("component", "collector"),
	}
}

// Subscribe starts receiving messages from the SPAN panel.
func (c *Collector) Subscribe() error {
	c.logger.Info("subscribing to SPAN data", "topic", c.subTopic)

	token := c.client.Subscribe(c.subTopic, 1, c.onMessage)
	token.Wait()
	if token.Error() != nil {
		return token.Error()
	}

	c.logger.Info("subscribed successfully", "topic", c.subTopic)
	return nil
}

func (c *Collector) onMessage(_ mqtt.Client, msg mqtt.Message) {
	topic := msg.Topic()
	payload := msg.Payload()

	if !strings.HasPrefix(topic, c.topicBase) {
		return
	}
	rest := topic[len(c.topicBase):]

	// Handle Homie special topics
	if rest == "$state" {
		c.logger.Debug("device state update", "state", string(payload))
		return
	}
	if rest == "$description" {
		c.logger.Debug("received $description", "bytes", len(payload))
		if err := c.state.SetDescription(payload); err != nil {
			c.logger.Error("failed to parse $description", "error", err)
		}
		return
	}
	// Skip other $ topics ($extensions, $children, etc.)
	if strings.HasPrefix(rest, "$") {
		return
	}

	// Parse node/property from "node/property"
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		c.logger.Debug("skipping non-property topic", "suffix", rest)
		return
	}

	node := rest[:slash]
	property := rest[slash+1:]

	// Skip nested $ topics under nodes
	if strings.HasPrefix(property, "$") {
		return
	}

	c.state.Update(node, property, payload)

	c.logger.Debug("state updated",
		"node", node,
		"property", property,
		"value", string(payload),
	)
}
