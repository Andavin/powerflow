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
// Update result
// ---------------------------------------------------------------------------

type UpdateResult struct {
	NodeID      string
	Timestamp   time.Time
	Ready       bool // all described properties have been received
	BecameReady bool // this update caused the transition to ready
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

	// Readiness tracking — populated once $description arrives
	receivedProps map[string]map[string]bool
	readyNodes    map[string]bool // per-node readiness

	// Hybrid readiness: a node is also marked ready once readinessGrace has
	// elapsed since its first message, even if some described properties
	// never publish. firstSeenAt and propCounts feed that decision and the
	// "ready with missing properties" diagnostic log.
	firstSeenAt    map[string]time.Time      // node → time of first observed property
	propCounts     map[string]map[string]int // node → property → publish count
	readinessGrace time.Duration             // 0 disables the timer fallback (strict-only mode)

	// nowFn is overridable in tests so the readiness timer can be advanced
	// without sleeping. Defaults to time.Now in NewState.
	nowFn func() time.Time

	// Pending buffer: property updates that arrived before $description.
	// On a fresh connection, Homie 5 retained messages can land in any
	// order, and parseInfer's type guess for an early property write would
	// auto-create the QuestDB column with the wrong type (e.g. LONG for
	// "59937") that later parseByDatatype string writes can't fit. We
	// buffer pre-description updates and replay them in SetDescription so
	// the FIRST ILP write always uses the description's declared datatype.
	pending []pendingUpdate
}

// pendingUpdate is a snapshot of an MQTT property update that arrived before
// $description was loaded. The payload is copied so the caller can reuse the
// underlying buffer.
type pendingUpdate struct {
	node, property string
	payload        []byte
	arrivedAt      time.Time
}

// NewState constructs a State for the given device. readinessGrace is the
// maximum time a described node will wait for all its properties before being
// marked ready with whatever has arrived; pass 0 to retain the original
// strict-only behavior (no fallback).
func NewState(deviceID string, logger *slog.Logger, readinessGrace time.Duration) *State {
	return &State{
		deviceID:       deviceID,
		values:         make(map[string]map[string]interface{}),
		nodeUpdated:    make(map[string]time.Time),
		receivedProps:  make(map[string]map[string]bool),
		readyNodes:     make(map[string]bool),
		firstSeenAt:    make(map[string]time.Time),
		propCounts:     make(map[string]map[string]int),
		readinessGrace: readinessGrace,
		nowFn:          time.Now,
		logger:         logger.With("component", "state"),
	}
}

// SetDescription parses and stores the Homie $description payload, then
// replays any updates that arrived before description was loaded.
// Returns the list of node IDs that became ready as a result.
func (s *State) SetDescription(data []byte) (readyNodeIDs []string, err error) {
	var desc DeviceDescription
	if err := json.Unmarshal(data, &desc); err != nil {
		return nil, fmt.Errorf("parse $description: %w", err)
	}

	s.mu.Lock()

	// Snapshot the buffer and clear before setting description so each
	// applyUpdateLocked call sees s.description != nil and goes through
	// parseByDatatype rather than parseInfer.
	pending := s.pending
	s.pending = nil
	s.description = &desc

	// Replay buffered updates. This is the column-type-locking fix: the
	// first ILP write of every described property now uses the type the
	// panel declares, not whatever parseInfer guesses from the raw bytes.
	bufferedReady := make(map[string]bool, len(pending))
	for _, p := range pending {
		result := s.applyUpdateLocked(p.node, p.property, p.payload, p.arrivedAt)
		if result.BecameReady {
			bufferedReady[p.node] = true
		}
	}
	for nodeID := range bufferedReady {
		readyNodeIDs = append(readyNodeIDs, nodeID)
	}

	// Check each described node — if all its properties already received, mark ready
	for nodeID := range desc.Nodes {
		if !s.readyNodes[nodeID] && s.checkNodeReadyLocked(nodeID) {
			s.readyNodes[nodeID] = true
			readyNodeIDs = append(readyNodeIDs, nodeID)
		}
	}

	// Already-received nodes NOT in description are unknown → immediately ready
	for nodeID := range s.values {
		if _, described := desc.Nodes[nodeID]; !described && !s.readyNodes[nodeID] {
			s.readyNodes[nodeID] = true
			readyNodeIDs = append(readyNodeIDs, nodeID)
		}
	}
	s.mu.Unlock()

	// Count circuits vs known nodes for logging
	circuitCount := 0
	totalProps := 0
	for nodeID, schema := range desc.Nodes {
		if _, known := knownNodes[nodeID]; !known {
			circuitCount++
		}
		totalProps += len(schema.Properties)
	}

	s.logger.Info("loaded device description",
		"name", desc.Name,
		"homie", desc.Homie,
		"total_nodes", len(desc.Nodes),
		"circuits", circuitCount,
		"total_properties", totalProps,
		"nodes_immediately_ready", len(readyNodeIDs),
		"buffered_updates_replayed", len(pending),
	)
	return readyNodeIDs, nil
}

// Update stores a single property value, parsing it according to the schema.
// If $description has not yet been loaded, the update is buffered and replayed
// from SetDescription so the FIRST parse of every property is description-aware
// (preventing parseInfer from guessing a type that conflicts with the
// description's declared datatype).
func (s *State) Update(node, property string, payload []byte) UpdateResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.nowFn()

	if s.description == nil {
		// Copy payload — Paho reuses the underlying buffer between calls.
		buf := make([]byte, len(payload))
		copy(buf, payload)
		s.pending = append(s.pending, pendingUpdate{
			node: node, property: property,
			payload: buf, arrivedAt: now,
		})
		return UpdateResult{NodeID: node, Timestamp: now}
	}

	return s.applyUpdateLocked(node, property, payload, now)
}

// applyUpdateLocked is the unbuffered update path, shared between Update (for
// post-description messages) and SetDescription (for replaying buffered ones).
// Caller must hold s.mu for writing.
func (s *State) applyUpdateLocked(node, property string, payload []byte, now time.Time) UpdateResult {
	if s.values[node] == nil {
		s.values[node] = make(map[string]interface{})
	}

	s.values[node][property] = s.parseValue(node, property, payload)
	s.nodeUpdated[node] = now
	s.lastUpdate = now
	s.msgCount++

	// Track received properties for readiness
	if s.receivedProps[node] == nil {
		s.receivedProps[node] = make(map[string]bool)
	}
	s.receivedProps[node][property] = true

	// Track first-seen time and publish counts for the grace-timer fallback
	if _, exists := s.firstSeenAt[node]; !exists {
		s.firstSeenAt[node] = now
	}
	if s.propCounts[node] == nil {
		s.propCounts[node] = make(map[string]int)
	}
	s.propCounts[node][property]++

	result := UpdateResult{
		NodeID:    node,
		Timestamp: now,
	}

	if s.readyNodes[node] {
		result.Ready = true
	} else if s.checkNodeReadyLocked(node) {
		s.readyNodes[node] = true
		result.Ready = true
		result.BecameReady = true
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

// IsReady reports whether all described nodes have received all their properties.
func (s *State) IsReady() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.description == nil {
		return false
	}
	for nodeID := range s.description.Nodes {
		if !s.readyNodes[nodeID] {
			return false
		}
	}
	return true
}

// IsNodeReady reports whether a specific node has received all its described properties.
func (s *State) IsNodeReady(nodeID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.readyNodes[nodeID]
}

// checkNodeReadyLocked decides whether a described node should be marked ready.
// Must be called with s.mu held. Two paths to ready:
//
//  1. Strict — every described property has been received at least once.
//  2. Grace timer — readinessGrace has elapsed since the first message for
//     this node. The remaining properties are presumed to be either
//     event-only (Homie retained=false) or simply not published by the panel
//     for this particular node. A warn log lists what's still missing.
//
// readinessGrace == 0 disables path 2 (strict-only mode).
func (s *State) checkNodeReadyLocked(nodeID string) bool {
	if s.description == nil {
		return false
	}
	schema, described := s.description.Nodes[nodeID]
	if !described {
		return true // unknown node — immediately ready
	}

	// Path 1: strict description match
	received := s.receivedProps[nodeID]
	if received == nil && len(schema.Properties) == 0 {
		return true
	}
	allReceived := received != nil
	for propID := range schema.Properties {
		if !received[propID] {
			allReceived = false
			break
		}
	}
	if allReceived {
		return true
	}

	// Path 2: grace-timer fallback
	if s.readinessGrace <= 0 {
		return false
	}
	first, hasFirst := s.firstSeenAt[nodeID]
	if !hasFirst || s.nowFn().Sub(first) < s.readinessGrace {
		return false
	}
	return s.markReadyWithMissingLocked(nodeID, schema)
}

// markReadyWithMissingLocked emits a warn log enumerating which described
// properties were never received before the grace timer fired. It always
// returns true so callers can use it inline. Must be called with s.mu held.
func (s *State) markReadyWithMissingLocked(nodeID string, schema NodeSchema) bool {
	received := s.receivedProps[nodeID]
	var missing []string
	for propID := range schema.Properties {
		if received == nil || !received[propID] {
			missing = append(missing, propID)
		}
	}
	if len(missing) > 0 {
		// Count properties seen multiple times — operational signal that the
		// retained burst likely completed before grace expired.
		var multiseen int
		for _, c := range s.propCounts[nodeID] {
			if c >= 2 {
				multiseen++
			}
		}
		s.logger.Warn("node ready with missing described properties",
			"node", nodeID,
			"missing", missing,
			"elapsed", s.nowFn().Sub(s.firstSeenAt[nodeID]).Round(time.Millisecond),
			"props_seen_multiple_times", multiseen,
		)
	}
	return true
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

// DescribedProperties returns the set of property IDs the $description declares
// for a node, plus whether the node is described with a non-empty schema. Used
// by the optional strict-schema filter to drop undeclared properties. Returns
// (nil, false) for unknown/undescribed nodes so the caller leaves them untouched
// (unknown nodes are captured wholesale in unknown_topics).
func (s *State) DescribedProperties(nodeID string) (map[string]bool, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.description == nil {
		return nil, false
	}
	schema, ok := s.description.Nodes[nodeID]
	if !ok || len(schema.Properties) == 0 {
		return nil, false
	}
	out := make(map[string]bool, len(schema.Properties))
	for propID := range schema.Properties {
		out[propID] = true
	}
	return out, true
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
				value, ok := parseByDatatype(ps.Datatype, raw)
				if !ok {
					// Datatype was numeric but raw didn't parse — value is now
					// the raw string instead of the expected float/int. This
					// produces a type-mismatch error at the QuestDB ILP flush
					// layer with no per-property breadcrumb, so log here.
					s.logger.Warn("property parse failed; using raw string",
						"node", node,
						"property", property,
						"datatype", ps.Datatype,
						"raw", raw,
					)
				}
				return value
			}
		}
	}

	// Fallback: intelligent type inference
	return parseInfer(raw)
}

// parseByDatatype converts raw to the type indicated by datatype. The second
// return value reports whether parsing matched the requested datatype:
//
//   - true: value is float64/int64/bool/string per datatype.
//   - false: datatype was numeric but raw didn't parse; value is the raw
//     string (so the row is still recorded, but the caller may want to log).
//
// Boolean and string/enum/unknown datatypes never fail (boolean defaults to
// false for anything not equal to "true").
func parseByDatatype(datatype, raw string) (value interface{}, ok bool) {
	switch datatype {
	case "float":
		if v, err := strconv.ParseFloat(raw, 64); err == nil {
			return v, true
		}
		return raw, false
	case "integer":
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return v, true
		}
		return raw, false
	case "boolean":
		return strings.EqualFold(raw, "true"), true
	}
	// string, enum, or unknown — raw IS the expected representation
	return raw, true
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
