package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestNewState(t *testing.T) {
	s := NewState("dev-1", testLogger())
	if s == nil {
		t.Fatal("NewState returned nil")
	}
	nodes := s.Nodes()
	if len(nodes) != 0 {
		t.Errorf("new state should have 0 nodes, got %d", len(nodes))
	}
}

func TestStateUpdateAndRead(t *testing.T) {
	s := NewState("dev-1", testLogger())

	s.Update("core", "voltage", []byte("120.5"))
	s.Update("core", "relay-state", []byte("CLOSED"))
	s.Update("circuit-1", "power", []byte("42.7"))

	nodes := s.Nodes()
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}

	coreProps := s.NodeValues("core")
	if coreProps == nil {
		t.Fatal("core node missing")
	}
	if v, ok := coreProps["voltage"].(float64); !ok || v != 120.5 {
		t.Errorf("voltage = %v, want 120.5", coreProps["voltage"])
	}
	if v, ok := coreProps["relay-state"].(string); !ok || v != "CLOSED" {
		t.Errorf("relay-state = %v, want CLOSED", coreProps["relay-state"])
	}

	c1Props := s.NodeValues("circuit-1")
	if v, ok := c1Props["power"].(float64); !ok || v != 42.7 {
		t.Errorf("power = %v, want 42.7", c1Props["power"])
	}
}

func TestStateNodeValuesReturnsNilForMissing(t *testing.T) {
	s := NewState("dev-1", testLogger())
	if s.NodeValues("nonexistent") != nil {
		t.Error("expected nil for missing node")
	}
}

func TestStateNodeValuesCopy(t *testing.T) {
	s := NewState("dev-1", testLogger())
	s.Update("n1", "key", []byte("value"))

	copy1 := s.NodeValues("n1")
	copy1["key"] = "mutated"

	copy2 := s.NodeValues("n1")
	if copy2["key"] != "value" {
		t.Error("NodeValues should return a copy; mutation leaked")
	}
}

func TestStateStats(t *testing.T) {
	s := NewState("dev-1", testLogger())

	msgCount, nodeCount, circuitCount, lastUpdate := s.Stats()
	if msgCount != 0 || nodeCount != 0 || circuitCount != 0 {
		t.Errorf("empty state stats: msg=%d node=%d circuit=%d", msgCount, nodeCount, circuitCount)
	}
	if !lastUpdate.IsZero() {
		t.Error("lastUpdate should be zero for empty state")
	}

	s.Update("core", "voltage", []byte("120"))
	s.Update("my-circuit", "power", []byte("50"))
	s.Update("my-circuit", "current", []byte("0.4"))

	msgCount, nodeCount, circuitCount, lastUpdate = s.Stats()
	if msgCount != 3 {
		t.Errorf("msgCount = %d, want 3", msgCount)
	}
	if nodeCount != 2 {
		t.Errorf("nodeCount = %d, want 2", nodeCount)
	}
	if circuitCount != 1 {
		t.Errorf("circuitCount = %d, want 1 (my-circuit)", circuitCount)
	}
	if lastUpdate.IsZero() {
		t.Error("lastUpdate should not be zero after updates")
	}
}

func TestStateNodeLastUpdate(t *testing.T) {
	s := NewState("dev-1", testLogger())

	if !s.NodeLastUpdate("core").IsZero() {
		t.Error("expected zero time for unseen node")
	}

	before := time.Now()
	s.Update("core", "voltage", []byte("120"))
	after := time.Now()

	ts := s.NodeLastUpdate("core")
	if ts.Before(before) || ts.After(after) {
		t.Errorf("NodeLastUpdate = %v, expected between %v and %v", ts, before, after)
	}
}

func TestSetDescription(t *testing.T) {
	s := NewState("dev-1", testLogger())

	if s.HasDescription() {
		t.Error("should not have description initially")
	}

	desc := DeviceDescription{
		Homie:   "5.0",
		Version: 1,
		Name:    "SPAN Panel",
		Nodes: map[string]NodeSchema{
			"core":       {Name: "Core"},
			"circuit-ab": {Name: "Kitchen"},
		},
	}
	data, _ := json.Marshal(desc)
	if err := s.SetDescription(data); err != nil {
		t.Fatalf("SetDescription: %v", err)
	}

	if !s.HasDescription() {
		t.Error("should have description after SetDescription")
	}
	if !s.IsDescribedNode("core") {
		t.Error("core should be described")
	}
	if !s.IsDescribedNode("circuit-ab") {
		t.Error("circuit-ab should be described")
	}
	if s.IsDescribedNode("unknown-node") {
		t.Error("unknown-node should not be described")
	}
}

func TestSetDescriptionInvalidJSON(t *testing.T) {
	s := NewState("dev-1", testLogger())
	err := s.SetDescription([]byte("{invalid"))
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestIsDescribedNodeNoDescription(t *testing.T) {
	s := NewState("dev-1", testLogger())
	if s.IsDescribedNode("anything") {
		t.Error("should return false when no description loaded")
	}
}

func TestParseByDatatype(t *testing.T) {
	tests := []struct {
		datatype string
		raw      string
		expect   interface{}
	}{
		{"float", "3.14", 3.14},
		{"float", "42", 42.0},
		{"float", "not-a-number", "not-a-number"},
		{"integer", "42", int64(42)},
		{"integer", "not-int", "not-int"},
		{"boolean", "true", true},
		{"boolean", "True", true},
		{"boolean", "false", false},
		{"boolean", "FALSE", false},
		{"string", "hello", "hello"},
		{"enum", "CLOSED", "CLOSED"},
		{"unknown-type", "value", "value"},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("%s/%s", tt.datatype, tt.raw), func(t *testing.T) {
			got := parseByDatatype(tt.datatype, tt.raw)
			if got != tt.expect {
				t.Errorf("parseByDatatype(%q, %q) = %v (%T), want %v (%T)",
					tt.datatype, tt.raw, got, got, tt.expect, tt.expect)
			}
		})
	}
}

func TestParseInfer(t *testing.T) {
	tests := []struct {
		raw    string
		expect interface{}
	}{
		{"42", int64(42)},
		{"0", int64(0)},
		{"-7", int64(-7)},
		{"3.14", 3.14},
		{"0.0", 0.0},
		{"-2.5", -2.5},
		{"true", true},
		{"True", true},
		{"TRUE", true},
		{"false", false},
		{"False", false},
		{"hello", "hello"},
		{"", ""},
		{"CLOSED", "CLOSED"},
	}

	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			got := parseInfer(tt.raw)
			if got != tt.expect {
				t.Errorf("parseInfer(%q) = %v (%T), want %v (%T)",
					tt.raw, got, got, tt.expect, tt.expect)
			}
		})
	}
}

func TestCopyMap(t *testing.T) {
	src := map[string]interface{}{
		"a": 1.0,
		"b": "hello",
		"c": true,
	}
	dst := copyMap(src)

	if len(dst) != len(src) {
		t.Fatalf("lengths differ: %d vs %d", len(dst), len(src))
	}
	for k, v := range src {
		if dst[k] != v {
			t.Errorf("dst[%q] = %v, want %v", k, dst[k], v)
		}
	}

	// Mutation isolation
	dst["a"] = 999.0
	if src["a"] == 999.0 {
		t.Error("mutation of copy affected original")
	}
}

func TestParseValueWithSchema(t *testing.T) {
	s := NewState("dev-1", testLogger())

	desc := DeviceDescription{
		Nodes: map[string]NodeSchema{
			"core": {
				Properties: map[string]PropertySchema{
					"voltage":     {Datatype: "float"},
					"relay-state": {Datatype: "string"},
					"breaker-on":  {Datatype: "boolean"},
					"phase-count": {Datatype: "integer"},
				},
			},
		},
	}
	data, _ := json.Marshal(desc)
	s.SetDescription(data)

	s.Update("core", "voltage", []byte("120.5"))
	s.Update("core", "relay-state", []byte("CLOSED"))
	s.Update("core", "breaker-on", []byte("true"))
	s.Update("core", "phase-count", []byte("2"))

	props := s.NodeValues("core")
	if v, ok := props["voltage"].(float64); !ok || v != 120.5 {
		t.Errorf("voltage = %v", props["voltage"])
	}
	if v, ok := props["relay-state"].(string); !ok || v != "CLOSED" {
		t.Errorf("relay-state = %v", props["relay-state"])
	}
	if v, ok := props["breaker-on"].(bool); !ok || !v {
		t.Errorf("breaker-on = %v", props["breaker-on"])
	}
	if v, ok := props["phase-count"].(int64); !ok || v != 2 {
		t.Errorf("phase-count = %v", props["phase-count"])
	}
}

func TestStateRandomizedUpdates(t *testing.T) {
	s := NewState("dev-1", testLogger())
	r := rand.New(rand.NewSource(42))

	nodeIDs := []string{"core", "lugs-upstream", "circuit-a", "circuit-b", "unknown-x"}
	props := []string{"voltage", "power", "current", "energy"}

	const iterations = 500
	for i := 0; i < iterations; i++ {
		node := nodeIDs[r.Intn(len(nodeIDs))]
		prop := props[r.Intn(len(props))]
		val := fmt.Sprintf("%.2f", r.Float64()*1000)
		s.Update(node, prop, []byte(val))
	}

	msgCount, nodeCount, _, _ := s.Stats()
	if msgCount != iterations {
		t.Errorf("msgCount = %d, want %d", msgCount, iterations)
	}
	if nodeCount != len(nodeIDs) {
		t.Errorf("nodeCount = %d, want %d", nodeCount, len(nodeIDs))
	}

	for _, nid := range nodeIDs {
		vals := s.NodeValues(nid)
		if vals == nil {
			t.Errorf("node %q missing", nid)
		}
	}
}
