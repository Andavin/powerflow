package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Homie $description schema types
// ---------------------------------------------------------------------------

type PropertySchema struct {
	Name     string `json:"name"`
	Datatype string `json:"datatype"`
	Unit     string `json:"unit,omitempty"`
	Format   string `json:"format,omitempty"`
	Settable bool   `json:"settable,omitempty"`
}

type NodeSchema struct {
	Name       string                    `json:"name"`
	Type       string                    `json:"type"`
	Properties map[string]PropertySchema `json:"properties"`
}

type DeviceDescription struct {
	Homie   string                `json:"homie"`
	Version int64                 `json:"version"`
	Name    string                `json:"name"`
	Type    string                `json:"type"`
	Nodes   map[string]NodeSchema `json:"nodes"`
}

// ---------------------------------------------------------------------------
// Well-known SPAN node IDs → output keys
// ---------------------------------------------------------------------------

var knownNodes = map[string]string{
	"core":            "panel",
	"lugs-upstream":   "upstream",
	"lugs-downstream": "downstream",
	"power-flows":     "power_flows",
	"pcs":             "pcs",
	"bess":            "bess",
}

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

// State maintains the latest value for every node/property received from SPAN.
type State struct {
	mu          sync.RWMutex
	deviceID    string
	description *DeviceDescription
	values      map[string]map[string]interface{} // node → property → value
	nodeUpdated map[string]time.Time              // node → last MQTT arrival time
	lastUpdate  time.Time
	msgCount    uint64
	logger      *slog.Logger
}

func NewState(deviceID string, logger *slog.Logger) *State {
	return &State{
		deviceID:    deviceID,
		values:      make(map[string]map[string]interface{}),
		nodeUpdated: make(map[string]time.Time),
		logger:      logger.With("component", "state"),
	}
}

// SetDescription parses and stores the Homie $description payload.
func (s *State) SetDescription(data []byte) error {
	var desc DeviceDescription
	if err := json.Unmarshal(data, &desc); err != nil {
		return fmt.Errorf("parse $description: %w", err)
	}

	s.mu.Lock()
	s.description = &desc
	s.mu.Unlock()

	// Count circuits vs known nodes
	circuitCount := 0
	for nodeID := range desc.Nodes {
		if _, known := knownNodes[nodeID]; !known {
			circuitCount++
		}
	}

	s.logger.Info("loaded device description",
		"name", desc.Name,
		"homie", desc.Homie,
		"total_nodes", len(desc.Nodes),
		"circuits", circuitCount,
	)
	return nil
}

// Update stores a single property value, parsing it according to the schema.
func (s *State) Update(node, property string, payload []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.values[node] == nil {
		s.values[node] = make(map[string]interface{})
	}

	now := time.Now()
	s.values[node][property] = s.parseValue(node, property, payload)
	s.nodeUpdated[node] = now
	s.lastUpdate = now
	s.msgCount++
}

// Stats returns counters for logging.
func (s *State) Stats() (msgCount uint64, nodeCount int, circuitCount int, lastUpdate time.Time) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	circuits := 0
	for node := range s.values {
		if _, known := knownNodes[node]; !known {
			circuits++
		}
	}
	return s.msgCount, len(s.values), circuits, s.lastUpdate
}

// IsDescribedNode reports whether the node exists in the Homie $description.
// Returns false if no description has been loaded yet.
func (s *State) IsDescribedNode(nodeID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.description == nil {
		return false
	}
	_, ok := s.description.Nodes[nodeID]
	return ok
}

// HasDescription reports whether the Homie $description has been loaded.
func (s *State) HasDescription() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.description != nil
}

// NodeLastUpdate returns the MQTT arrival time of the most recent message for a node.
func (s *State) NodeLastUpdate(nodeID string) time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.nodeUpdated[nodeID]
}

// Nodes returns all node IDs currently in state.
func (s *State) Nodes() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	nodes := make([]string, 0, len(s.values))
	for n := range s.values {
		nodes = append(nodes, n)
	}
	return nodes
}

// NodeValues returns a copy of all property values for a given node.
func (s *State) NodeValues(node string) map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	props, ok := s.values[node]
	if !ok {
		return nil
	}
	return copyMap(props)
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

func (s *State) parseValue(node, property string, payload []byte) interface{} {
	raw := string(payload)

	// Try schema-based parsing first
	if s.description != nil {
		if ns, ok := s.description.Nodes[node]; ok {
			if ps, ok := ns.Properties[property]; ok {
				return parseByDatatype(ps.Datatype, raw)
			}
		}
	}

	// Fallback: intelligent type inference
	return parseInfer(raw)
}

func parseByDatatype(datatype, raw string) interface{} {
	switch datatype {
	case "float":
		if v, err := strconv.ParseFloat(raw, 64); err == nil {
			return v
		}
	case "integer":
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return v
		}
	case "boolean":
		return strings.EqualFold(raw, "true")
	}
	// string, enum, or parse failure
	return raw
}

func parseInfer(raw string) interface{} {
	if v, err := strconv.ParseFloat(raw, 64); err == nil {
		if v == float64(int64(v)) && !strings.Contains(raw, ".") {
			return int64(v)
		}
		return v
	}
	if strings.EqualFold(raw, "true") {
		return true
	}
	if strings.EqualFold(raw, "false") {
		return false
	}
	return raw
}

func copyMap(src map[string]interface{}) map[string]interface{} {
	dst := make(map[string]interface{}, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}
