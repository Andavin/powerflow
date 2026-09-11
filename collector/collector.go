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
	state       *State
	topicBase   string // e.g. "ebus/5/<panel-serial>/" — panel device prefix
	topicParent string // e.g. "ebus/5/"               — broker-wide prefix
	deviceID    string // panel serial, to skip panel topics in child handler
	logger      *slog.Logger
	onUpdate    func(UpdateResult) // called after each state update when ready
}

func NewCollector(state *State, cfg SpanConfig, logger *slog.Logger, onUpdate func(UpdateResult)) *Collector {
	return &Collector{
		state:       state,
		topicBase:   cfg.TopicBase(),
		topicParent: cfg.TopicPrefix + "/",
		deviceID:    cfg.DeviceID,
		logger:      logger.With("component", "collector"),
		onUpdate:    onUpdate,
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

// flatCircuitProp maps a Homie 5 circuit device's sub-node/property pair to a
// flat property name compatible with the circuits table and energy tracker.
//
// Firmware r202633+ promotes each breaker from a nested node within the panel
// device to its own Homie 5 device with sub-nodes (meter, info, switch,
// breaker, load-shed, pcs, connection). This function restores the flat names
// the earlier firmware published directly on the circuit node, preserving
// backward compatibility with existing QuestDB columns and the energy tracker's
// "imported-energy", "exported-energy", and "breaker-rating" lookups.
func flatCircuitProp(node, property string) string {
	switch node {
	case "meter", "info", "switch":
		// Primary nodes: property names are unique across nodes, use as-is.
		return property
	case "breaker":
		// "rating" → "breaker-rating" matches EnergyTracker's ceiling lookup.
		return "breaker-" + property
	case "load-shed":
		if property == "priority" {
			return "shed-priority"
		}
		return "shed-" + property
	case "pcs":
		return "pcs-" + property
	case "connection":
		return "connection-" + property
	}
	return node + "-" + property
}

// handleChildDeviceTopic processes MQTT topics for circuit devices published
// under the shared topic prefix but outside the panel device's own path.
// Firmware r202633+ publishes each breaker as its own Homie 5 device at
// "<prefix>/<circuit-uuid>/<node>/<property>" rather than as a node within
// the panel device. This method routes those messages into State as flat
// circuit node updates so the rest of the pipeline is unchanged.
func (c *Collector) handleChildDeviceTopic(topic string, payload []byte) {
	if !strings.HasPrefix(topic, c.topicParent) {
		return
	}
	rest := topic[len(c.topicParent):]

	firstSlash := strings.IndexByte(rest, '/')
	if firstSlash < 0 {
		return
	}
	deviceUUID := rest[:firstSlash]
	if deviceUUID == c.deviceID {
		return // already handled by the panel-device path
	}
	subpath := rest[firstSlash+1:]

	// Skip Homie system topics ($description, $state, etc.)
	if strings.HasPrefix(subpath, "$") {
		return
	}

	// Expect exactly <node>/<property>
	slash := strings.IndexByte(subpath, '/')
	if slash < 0 {
		return
	}
	node := subpath[:slash]
	property := subpath[slash+1:]

	// Drop nested sub-topics ("<node>/<property>/set") and attribute topics ("<node>/$name")
	if strings.ContainsRune(property, '/') || strings.HasPrefix(property, "$") {
		return
	}

	flatProp := flatCircuitProp(node, property)
	ur := c.state.Update(deviceUUID, flatProp, payload)

	if c.onUpdate != nil && ur.Ready {
		c.onUpdate(ur)
	}

	c.logger.Debug("circuit device updated",
		"device", deviceUUID,
		"node", node,
		"property", property,
		"flat", flatProp,
		"value", string(payload),
	)
}

// OnMessage is the Paho MessageHandler. It's exported so it can be passed
// to createMQTTClient as the client's default publish handler.
func (c *Collector) OnMessage(_ mqtt.Client, msg mqtt.Message) {
	topic := msg.Topic()
	payload := msg.Payload()

	tr := parseTopic(c.topicBase, topic)

	if tr.NoPrefix || tr.Ignored || tr.NoSlash {
		if tr.NoPrefix {
			c.handleChildDeviceTopic(topic, payload)
		} else if tr.NoSlash {
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
