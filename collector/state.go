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
	lastUpdate  time.Time
	msgCount    uint64
	logger      *slog.Logger
}

func NewState(deviceID string, logger *slog.Logger) *State {
	return &State{
		deviceID: deviceID,
		values:   make(map[string]map[string]interface{}),
		logger:   logger.With("component", "state"),
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

	s.values[node][property] = s.parseValue(node, property, payload)
	s.lastUpdate = time.Now()
	s.msgCount++
}

// Snapshot creates a structured copy of the current state for publishing.
func (s *State) Snapshot() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	snap := map[string]interface{}{
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"device_id": s.deviceID,
	}

	circuits := make(map[string]interface{})

	for node, props := range s.values {
		propsCopy := copyMap(props)

		if outKey, isKnown := knownNodes[node]; isKnown {
			snap[outKey] = propsCopy
		} else {
			// Circuit node — key by human-readable name
			circuitKey := node
			if name, ok := props["name"]; ok {
				if nameStr, ok := name.(string); ok && nameStr != "" {
					circuitKey = nameStr
				}
			}
			propsCopy["circuit_id"] = node
			circuits[circuitKey] = propsCopy
		}
	}

	if len(circuits) > 0 {
		snap["circuits"] = circuits
	}

	return snap
}

// CircuitSnapshots returns a map of circuit_name → properties (only circuits).
func (s *State) CircuitSnapshots() map[string]map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ts := time.Now().UTC().Format(time.RFC3339Nano)
	result := make(map[string]map[string]interface{})

	for node, props := range s.values {
		if _, isKnown := knownNodes[node]; isKnown {
			continue
		}
		circuitKey := node
		if name, ok := props["name"]; ok {
			if nameStr, ok := name.(string); ok && nameStr != "" {
				circuitKey = nameStr
			}
		}
		entry := copyMap(props)
		entry["circuit_id"] = node
		entry["device_id"] = s.deviceID
		entry["timestamp"] = ts
		result[circuitKey] = entry
	}
	return result
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
