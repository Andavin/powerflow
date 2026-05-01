package main

import (
	"log/slog"
	"time"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EnergyReading struct {
	ImportedEnergy float64
	ExportedEnergy float64
	Timestamp      time.Time
}

type EnergyDelta struct {
	NodeID     string
	NodeType   string // "circuit", "upstream", "downstream"
	Name       string
	ImportedWh float64
	ExportedWh float64
	PeriodMs   float64   // milliseconds between readings
	AvgImportW float64   // average import power (W) over the period
	AvgExportW float64   // average export power (W) over the period
	Timestamp  time.Time // MQTT arrival time of the reading that produced this delta
}

const msPerHour = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// EnergyTracker — caches previous readings and computes deltas
// ---------------------------------------------------------------------------

// energyNodeInfo maps system node IDs that carry energy data to their type/name.
var energyNodeInfo = map[string]struct{ nodeType, name string }{
	"lugs-upstream":   {"upstream", "upstream"},
	"lugs-downstream": {"downstream", "downstream"},
}

type EnergyTracker struct {
	cache  map[string]*EnergyReading // keyed by node ID
	logger *slog.Logger
}

func NewEnergyTracker(logger *slog.Logger) *EnergyTracker {
	return &EnergyTracker{
		cache:  make(map[string]*EnergyReading),
		logger: logger.With("component", "energy"),
	}
}

// Process examines every node with imported/exported energy values, computes
// the delta from the cached previous reading, and returns the deltas.
// First call per node returns no delta (baseline only).
func (t *EnergyTracker) Process(state *State) []EnergyDelta {
	var deltas []EnergyDelta

	for _, nodeID := range state.Nodes() {
		props := state.NodeValues(nodeID)
		if props == nil {
			continue
		}

		imported, hasImp := getFloat(props, "imported-energy")
		exported, hasExp := getFloat(props, "exported-energy")
		if !hasImp && !hasExp {
			continue
		}

		// Classify node
		var nodeType, name string
		if info, ok := energyNodeInfo[nodeID]; ok {
			nodeType = info.nodeType
			name = info.name
		} else if _, isSystem := knownNodes[nodeID]; !isSystem {
			nodeType = "circuit"
			name = nodeID
			if n, ok := props["name"]; ok {
				if s, ok := n.(string); ok && s != "" {
					name = s
				}
			}
		} else {
			continue
		}

		// Use the MQTT arrival time for this node, not time.Now()
		nodeTS := state.NodeLastUpdate(nodeID)
		if nodeTS.IsZero() {
			continue
		}

		prev, hasPrev := t.cache[nodeID]

		t.cache[nodeID] = &EnergyReading{
			ImportedEnergy: imported,
			ExportedEnergy: exported,
			Timestamp:      nodeTS,
		}

		if !hasPrev {
			t.logger.Debug("energy baseline cached", "node", nodeID, "type", nodeType)
			continue
		}

		periodMs := float64(nodeTS.Sub(prev.Timestamp).Milliseconds())
		if periodMs <= 0 {
			continue
		}

		impDelta := imported - prev.ImportedEnergy
		expDelta := exported - prev.ExportedEnergy

		if impDelta < 0 || expDelta < 0 {
			// Cache was already overwritten with the new (post-reset) reading
			// above, so the next call computes a fresh positive delta from
			// the rebased baseline. No additional bookkeeping needed.
			t.logger.Warn("energy counter reset detected; baseline rebased, skipping this delta",
				"node", nodeID,
				"imported_delta", impDelta,
				"exported_delta", expDelta,
			)
			continue
		}

		// No energy moved this period in either direction — skip the delta to
		// keep power_usage from filling with mostly-zero rows. The cache was
		// already updated above, so the next non-zero delta correctly covers
		// only the period since this skipped reading (we do NOT inflate the
		// next period to span over skipped readings).
		if impDelta == 0 && expDelta == 0 {
			continue
		}

		deltas = append(deltas, EnergyDelta{
			NodeID:     nodeID,
			NodeType:   nodeType,
			Name:       name,
			ImportedWh: impDelta,
			ExportedWh: expDelta,
			PeriodMs:   periodMs,
			AvgImportW: impDelta * msPerHour / periodMs,
			AvgExportW: expDelta * msPerHour / periodMs,
			Timestamp:  nodeTS,
		})
	}

	return deltas
}

func getFloat(props map[string]interface{}, key string) (float64, bool) {
	v, ok := props[key]
	if !ok {
		return 0, false
	}
	switch f := v.(type) {
	case float64:
		return f, true
	case int64:
		return float64(f), true
	}
	return 0, false
}
