package main

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// Collector subscribes to the SPAN panel's MQTT topics and updates State.
type Collector struct {
	client    mqtt.Client
	state     *State
	topicBase string // e.g. "ebus/5/REPLACE-WITH-YOUR-PANEL-SERIAL/"
	subTopic  string // e.g. "ebus/5/REPLACE-WITH-YOUR-PANEL-SERIAL/#"
	logger    *slog.Logger
	onUpdate  func(UpdateResult) // called after each state update when ready
}

func NewCollector(client mqtt.Client, state *State, cfg SpanConfig, logger *slog.Logger, onUpdate func(UpdateResult)) *Collector {
	return &Collector{
		client:    client,
		state:     state,
		topicBase: cfg.TopicBase(),
		subTopic:  cfg.SubscribeTopic(),
		logger:    logger.With("component", "collector"),
		onUpdate:  onUpdate,
	}
}

// subscribeTimeout bounds the wait for SUBACK. A broker that accepts the
// TCP/TLS handshake but never responds to SUBSCRIBE would otherwise hang
// here forever.
const subscribeTimeout = 10 * time.Second

// Subscribe starts receiving messages from the SPAN panel.
func (c *Collector) Subscribe() error {
	c.logger.Info("subscribing to SPAN data", "topic", c.subTopic)

	token := c.client.Subscribe(c.subTopic, 1, c.onMessage)
	if !token.WaitTimeout(subscribeTimeout) {
		return fmt.Errorf("subscribe to %q timed out after %s", c.subTopic, subscribeTimeout)
	}
	if err := token.Error(); err != nil {
		return err
	}

	c.logger.Info("subscribed successfully", "topic", c.subTopic)
	return nil
}

// topicResult describes the parsed outcome of an MQTT topic.
type topicResult struct {
	Node     string // non-empty for data topics
	Property string // non-empty for data topics
	Special  string // "$state", "$description", etc. — non-empty for Homie system topics
	Ignored  bool   // true if the topic should be silently dropped
	NoPrefix bool   // true if the topic didn't match the base prefix
	NoSlash  bool   // true if the rest had no slash (not a node/property pair)
}

// parseTopic extracts the node and property from a full MQTT topic
// relative to the expected topicBase prefix. It classifies Homie $-topics
// and filters topics that should not produce state updates.
func parseTopic(topicBase, fullTopic string) topicResult {
	if !strings.HasPrefix(fullTopic, topicBase) {
		return topicResult{NoPrefix: true}
	}
	rest := fullTopic[len(topicBase):]

	// Homie special topics at device level
	if rest == "$state" || rest == "$description" {
		return topicResult{Special: rest}
	}
	if strings.HasPrefix(rest, "$") {
		return topicResult{Ignored: true}
	}

	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return topicResult{NoSlash: true}
	}

	node := rest[:slash]
	property := rest[slash+1:]

	// Skip nested $ topics under nodes
	if strings.HasPrefix(property, "$") {
		return topicResult{Ignored: true}
	}

	return topicResult{Node: node, Property: property}
}

func (c *Collector) onMessage(_ mqtt.Client, msg mqtt.Message) {
	topic := msg.Topic()
	payload := msg.Payload()

	tr := parseTopic(c.topicBase, topic)

	if tr.NoPrefix || tr.Ignored || tr.NoSlash {
		if tr.NoSlash {
			c.logger.Debug("skipping non-property topic", "suffix", topic[len(c.topicBase):])
		}
		return
	}

	if tr.Special == "$state" {
		c.logger.Debug("device state update", "state", string(payload))
		return
	}
	if tr.Special == "$description" {
		c.logger.Debug("received $description", "bytes", len(payload))
		readyNodes, err := c.state.SetDescription(payload)
		if err != nil {
			c.logger.Error("failed to parse $description", "error", err)
			return
		}
		if c.onUpdate != nil {
			now := time.Now()
			for _, nodeID := range readyNodes {
				c.onUpdate(UpdateResult{
					NodeID:      nodeID,
					Ready:       true,
					BecameReady: true,
					Timestamp:   now,
				})
			}
		}
		return
	}

	ur := c.state.Update(tr.Node, tr.Property, payload)

	if c.onUpdate != nil && ur.Ready {
		c.onUpdate(ur)
	}

	c.logger.Debug("state updated",
		"node", tr.Node,
		"property", tr.Property,
		"value", string(payload),
	)
}
