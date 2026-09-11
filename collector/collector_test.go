package main

import (
	"log/slog"
	"testing"
)

func TestParseTopic(t *testing.T) {
	base := "ebus/5/dev-1/"

	tests := []struct {
		name     string
		topic    string
		wantNode string
		wantProp string
		wantSpec string
		wantIgn  bool
		wantNP   bool
		wantNS   bool
	}{
		{
			name:     "normal property",
			topic:    "ebus/5/dev-1/core/voltage",
			wantNode: "core",
			wantProp: "voltage",
		},
		{
			name:     "circuit property",
			topic:    "ebus/5/dev-1/abc123/power",
			wantNode: "abc123",
			wantProp: "power",
		},
		{
			name:     "kebab-case property",
			topic:    "ebus/5/dev-1/core/relay-state",
			wantNode: "core",
			wantProp: "relay-state",
		},
		{
			name:     "$description",
			topic:    "ebus/5/dev-1/$description",
			wantSpec: "$description",
		},
		{
			name:     "$state",
			topic:    "ebus/5/dev-1/$state",
			wantSpec: "$state",
		},
		{
			name:    "other $ topic",
			topic:   "ebus/5/dev-1/$extensions",
			wantIgn: true,
		},
		{
			name:    "nested $ under node",
			topic:   "ebus/5/dev-1/core/$name",
			wantIgn: true,
		},
		{
			// Relay command sub-topic: must be ignored, not parsed as the
			// property "relay/set" (which becomes an invalid "relay/" column
			// and poisons the whole circuits batch).
			name:    "relay command sub-topic",
			topic:   "ebus/5/dev-1/circuit-3/relay/set",
			wantIgn: true,
		},
		{
			name:    "nested attribute sub-topic",
			topic:   "ebus/5/dev-1/circuit-3/relay/$settable",
			wantIgn: true,
		},
		{
			name:     "relay state property still parses",
			topic:    "ebus/5/dev-1/circuit-3/relay",
			wantNode: "circuit-3",
			wantProp: "relay",
		},
		{
			name:   "wrong prefix",
			topic:  "other/topic/completely",
			wantNP: true,
		},
		{
			name:   "no slash after node",
			topic:  "ebus/5/dev-1/just-a-node",
			wantNS: true,
		},
		{
			// A property with further slashes is a sub-topic, not state — it
			// is ignored rather than parsed into an invalid "prop/" column.
			name:    "deeply nested sub-topic is ignored",
			topic:   "ebus/5/dev-1/node/prop/sub",
			wantIgn: true,
		},
		{
			name:   "empty rest",
			topic:  "ebus/5/dev-1/",
			wantNS: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := parseTopic(base, tt.topic)

			if r.Node != tt.wantNode {
				t.Errorf("Node = %q, want %q", r.Node, tt.wantNode)
			}
			if r.Property != tt.wantProp {
				t.Errorf("Property = %q, want %q", r.Property, tt.wantProp)
			}
			if r.Special != tt.wantSpec {
				t.Errorf("Special = %q, want %q", r.Special, tt.wantSpec)
			}
			if r.Ignored != tt.wantIgn {
				t.Errorf("Ignored = %v, want %v", r.Ignored, tt.wantIgn)
			}
			if r.NoPrefix != tt.wantNP {
				t.Errorf("NoPrefix = %v, want %v", r.NoPrefix, tt.wantNP)
			}
			if r.NoSlash != tt.wantNS {
				t.Errorf("NoSlash = %v, want %v", r.NoSlash, tt.wantNS)
			}
		})
	}
}

func TestParseTopicDifferentBases(t *testing.T) {
	tests := []struct {
		base     string
		topic    string
		wantNode string
		wantProp string
	}{
		{"ebus/5/dev-a/", "ebus/5/dev-a/core/voltage", "core", "voltage"},
		{"custom/prefix/mydev/", "custom/prefix/mydev/n1/p1", "n1", "p1"},
		{"a/b/c/", "a/b/c/node/prop", "node", "prop"},
	}
	for _, tt := range tests {
		t.Run(tt.base, func(t *testing.T) {
			r := parseTopic(tt.base, tt.topic)
			if r.Node != tt.wantNode || r.Property != tt.wantProp {
				t.Errorf("got Node=%q Property=%q, want %q/%q", r.Node, r.Property, tt.wantNode, tt.wantProp)
			}
		})
	}
}

func TestFlatCircuitProp(t *testing.T) {
	tests := []struct {
		node, property, want string
	}{
		// meter node — primary energy/power data, use property name directly
		{"meter", "active-power", "active-power"},
		{"meter", "imported-energy", "imported-energy"},
		{"meter", "exported-energy", "exported-energy"},
		{"meter", "current", "current"},
		// info node — circuit metadata
		{"info", "name", "name"},
		{"info", "spaces", "spaces"},
		// switch node — relay control
		{"switch", "relay", "relay"},
		{"switch", "relay-requester", "relay-requester"},
		{"switch", "relay-controllable", "relay-controllable"},
		// breaker node — prefix with "breaker-" for EnergyTracker ceiling lookup
		{"breaker", "rating", "breaker-rating"},
		{"breaker", "poles", "breaker-poles"},
		// load-shed node — map "priority" to "shed-priority" for backward compat
		{"load-shed", "priority", "shed-priority"},
		{"load-shed", "other", "shed-other"},
		// pcs node — prefix with "pcs-"
		{"pcs", "managed", "pcs-managed"},
		{"pcs", "priority", "pcs-priority"},
		// connection node
		{"connection", "feeds-device-id", "connection-feeds-device-id"},
		// unknown node — generic prefix
		{"unknown", "foo", "unknown-foo"},
	}

	for _, tt := range tests {
		got := flatCircuitProp(tt.node, tt.property)
		if got != tt.want {
			t.Errorf("flatCircuitProp(%q, %q) = %q, want %q", tt.node, tt.property, got, tt.want)
		}
	}
}

func TestHandleChildDeviceTopic(t *testing.T) {
	logger := slog.Default()
	state := NewState("nj-2338-00fq1", logger, 0)

	// The panel's own $description must arrive first — state buffers all updates
	// until then. Circuit device UUIDs are not in the panel description, so they
	// are treated as unknown nodes and become immediately ready.
	descJSON := `{"homie":"5.0","version":1,"name":"SPAN Panel","type":"panel","nodes":{}}`
	if _, err := state.SetDescription([]byte(descJSON)); err != nil {
		t.Fatalf("SetDescription: %v", err)
	}

	var gotNodeID, gotProp string
	var gotValue interface{}

	c := &Collector{
		state:       state,
		topicBase:   "ebus/5/nj-2338-00fq1/",
		topicParent: "ebus/5/",
		deviceID:    "nj-2338-00fq1",
		logger:      logger,
		onUpdate: func(ur UpdateResult) {
			gotNodeID = ur.NodeID
			if vals := state.NodeValues(ur.NodeID); vals != nil {
				gotProp = "active-power"
				gotValue = vals["active-power"]
			}
		},
	}

	// Circuit device property: ebus/5/<uuid>/meter/active-power
	uuid := "2e94d24ec65d46b2bafcb86afc4140c4"
	c.handleChildDeviceTopic("ebus/5/"+uuid+"/meter/active-power", []byte("-123.4"))

	if gotNodeID != uuid {
		t.Errorf("nodeID = %q, want %q", gotNodeID, uuid)
	}
	if gotProp != "active-power" {
		t.Errorf("prop = %q, want %q", gotProp, "active-power")
	}
	if v, ok := gotValue.(float64); !ok || v != -123.4 {
		t.Errorf("value = %v, want -123.4", gotValue)
	}
}

func TestHandleChildDeviceTopicIgnored(t *testing.T) {
	logger := slog.Default()
	state := NewState("nj-2338-00fq1", logger, 0)
	called := false
	c := &Collector{
		state:       state,
		topicBase:   "ebus/5/nj-2338-00fq1/",
		topicParent: "ebus/5/",
		deviceID:    "nj-2338-00fq1",
		logger:      logger,
		onUpdate:    func(ur UpdateResult) { called = true },
	}

	uuid := "2e94d24ec65d46b2bafcb86afc4140c4"
	// $description should be silently ignored
	c.handleChildDeviceTopic("ebus/5/"+uuid+"/$description", []byte("{}"))
	// $state should be silently ignored
	c.handleChildDeviceTopic("ebus/5/"+uuid+"/$state", []byte("ready"))
	// command sub-topic should be ignored
	c.handleChildDeviceTopic("ebus/5/"+uuid+"/switch/relay/set", []byte("OPEN"))
	// panel device's own topics should be ignored
	c.handleChildDeviceTopic("ebus/5/nj-2338-00fq1/meter/voltage-a", []byte("122.0"))

	if called {
		t.Error("onUpdate should not have been called for ignored topics")
	}
}
