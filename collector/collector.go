package main

import (
	"log/slog"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// Collector parses incoming MQTT messages and routes property updates into
// State. It does NOT own the MQTT client or its subscription lifecycle —
// subscribing happens in createMQTTClient's OnConnect handler so that it
// fires on initial connect AND every reconnect (the panel rotates its TLS
// cert daily and force-disconnects all clients, requiring re-subscribe
// since CleanSession=true means the broker forgets subscriptions on drop).
type Collector struct {
	state     *State
	topicBase string // e.g. "ebus/5/<panel-serial>/"
	logger    *slog.Logger
	onUpdate  func(UpdateResult) // called after each state update when ready
}

func NewCollector(state *State, cfg SpanConfig, logger *slog.Logger, onUpdate func(UpdateResult)) *Collector {
	return &Collector{
		state:     state,
		topicBase: cfg.TopicBase(),
		logger:    logger.With("component", "collector"),
		onUpdate:  onUpdate,
	}
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

	// Only single-segment Homie property IDs are real state. The `#`
	// subscription also delivers command sub-topics (".../relay/set") and
	// nested attribute topics (".../relay/$settable" or ".../$name"); parsing
	// those as properties yields invalid column names like "relay/" that
	// QuestDB rejects, poisoning every subsequent circuits batch (the bad
	// property sticks in the node's cached snapshot and is re-sent each flush).
	// Legit properties are always one segment (relay, active-power, soe, ...),
	// so drop anything containing '/' or starting with '$'.
	if strings.ContainsRune(property, '/') || strings.HasPrefix(property, "$") {
		return topicResult{Ignored: true}
	}

	return topicResult{Node: node, Property: property}
}

// OnMessage is the Paho MessageHandler. It's exported so it can be passed
// to createMQTTClient as the client's default publish handler.
func (c *Collector) OnMessage(_ mqtt.Client, msg mqtt.Message) {
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
