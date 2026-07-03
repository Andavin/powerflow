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

	// lowStreak counts consecutive readings whose counter went *backwards*
	// relative to this cached baseline. A single transient dip (e.g. a panel
	// reboot republishing a retained 0) must not rebase the baseline, or the
	// next real reading produces a delta equal to the whole lifetime counter.
	// The baseline is only rebased once the low value persists across
	// resetConfirmReadings readings (a genuine counter reset).
	lowStreak int
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

// Guards against the two failure modes that produced the per-circuit energy
// spike (see ENERGY-SPIKE-FINDINGS.md):
//
//   - resetConfirmReadings: a counter that reads lower than its baseline is
//     treated as a transient glitch until it stays low for this many readings,
//     at which point it is accepted as a genuine reset and the baseline rebased.
//     Until then the baseline is preserved, so a momentary dip-to-0 that
//     recovers yields a normal delta against the true baseline (no spike).
//
//   - The power ceiling: any positive delta whose implied average power exceeds
//     a plausible bound is rejected (and the baseline rebased) rather than
//     emitted. The bound is derived per-circuit from the breaker rating when
//     available, else a conservative whole-panel fallback. A lifetime-cumulative
//     emitted as one delta implies megawatts, so it is caught with a huge margin
//     while legitimate catch-up deltas after a gap stay well under.
const (
	resetConfirmReadings = 3
	mainsVoltage         = 240.0   // US split-phase; used only to size the ceiling
	ceilingSafetyFactor  = 1.5     // headroom over a breaker's nameplate max
	globalCeilingWatts   = 100_000 // fallback when no breaker rating is known (~400A service)
)

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

	// maxAvgWatts is the ceiling used for nodes without a breaker rating
	// (e.g. the panel lugs). Circuits derive their own ceiling from
	// breaker-rating. Exposed as a field so tests with compressed time bases
	// can raise it; production uses globalCeilingWatts.
	maxAvgWatts float64
}

func NewEnergyTracker(logger *slog.Logger) *EnergyTracker {
	return &EnergyTracker{
		cache:       make(map[string]*EnergyReading),
		logger:      logger.With("component", "energy"),
		maxAvgWatts: globalCeilingWatts,
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

		// First reading for this node — cache the baseline, emit nothing. Unlike
		// the previous implementation, the cache is NOT overwritten unconditionally
		// on every call: each branch below decides whether the baseline advances,
		// so a single anomalous reading can no longer poison it.
		if !hasPrev {
			t.cache[nodeID] = &EnergyReading{
				ImportedEnergy: imported,
				ExportedEnergy: exported,
				Timestamp:      nodeTS,
			}
			t.logger.Debug("energy baseline cached", "node", nodeID, "type", nodeType)
			continue
		}

		periodMs := float64(nodeTS.Sub(prev.Timestamp).Milliseconds())
		if periodMs <= 0 {
			// No newer reading for this node since the baseline — nothing to do,
			// and crucially do NOT touch the baseline.
			continue
		}

		impDelta := imported - prev.ImportedEnergy
		expDelta := exported - prev.ExportedEnergy

		// --- Counter went backwards: transient glitch vs. genuine reset -------
		if impDelta < 0 || expDelta < 0 {
			prev.lowStreak++
			if prev.lowStreak < resetConfirmReadings {
				// Preserve the baseline. A momentary dip (retained 0 on reboot)
				// must not rebase, or the recovery reading becomes a full-
				// lifetime delta. The next non-decreasing reading is computed
				// against the true baseline and yields a normal delta.
				t.logger.Warn("transient low energy reading ignored; baseline preserved",
					"node", nodeID,
					"imported_delta", impDelta,
					"exported_delta", expDelta,
					"streak", prev.lowStreak,
				)
				continue
			}
			// The low value has persisted — accept it as a real counter reset
			// and rebase the baseline to it.
			t.logger.Warn("energy counter reset confirmed; baseline rebased",
				"node", nodeID,
				"imported", imported,
				"exported", exported,
				"streak", prev.lowStreak,
			)
			t.cache[nodeID] = &EnergyReading{
				ImportedEnergy: imported,
				ExportedEnergy: exported,
				Timestamp:      nodeTS,
			}
			continue
		}

		// A non-decreasing reading clears any pending low streak.
		prev.lowStreak = 0

		avgImportW := impDelta * msPerHour / periodMs
		avgExportW := expDelta * msPerHour / periodMs

		// --- Power ceiling: reject implausible positive deltas ----------------
		// This is the backstop for any path that still produces an oversized
		// delta (e.g. a baseline poisoned before this fix, or an unforeseen
		// glitch). Rebase to the current reading and skip, so the spurious
		// energy is neither emitted nor carried into the next delta.
		ceiling := t.ceilingWatts(props)
		if avgImportW > ceiling || avgExportW > ceiling {
			t.logger.Warn("energy delta exceeds power ceiling; skipping and rebasing",
				"node", nodeID,
				"avg_import_w", avgImportW,
				"avg_export_w", avgExportW,
				"ceiling_w", ceiling,
				"imported_delta", impDelta,
				"exported_delta", expDelta,
			)
			t.cache[nodeID] = &EnergyReading{
				ImportedEnergy: imported,
				ExportedEnergy: exported,
				Timestamp:      nodeTS,
			}
			continue
		}

		// No energy moved this period in either direction — skip the delta to
		// keep power_usage from filling with mostly-zero rows, but advance the
		// baseline so the next non-zero delta covers only the period since this
		// reading (we do NOT inflate the next period over skipped readings).
		if impDelta == 0 && expDelta == 0 {
			t.cache[nodeID] = &EnergyReading{
				ImportedEnergy: imported,
				ExportedEnergy: exported,
				Timestamp:      nodeTS,
			}
			continue
		}

		// Normal delta — advance the baseline and emit.
		t.cache[nodeID] = &EnergyReading{
			ImportedEnergy: imported,
			ExportedEnergy: exported,
			Timestamp:      nodeTS,
		}
		deltas = append(deltas, EnergyDelta{
			NodeID:     nodeID,
			NodeType:   nodeType,
			Name:       name,
			ImportedWh: impDelta,
			ExportedWh: expDelta,
			PeriodMs:   periodMs,
			AvgImportW: avgImportW,
			AvgExportW: avgExportW,
			Timestamp:  nodeTS,
		})
	}

	return deltas
}

// ceilingWatts returns the maximum plausible average power for a node's delta.
// When the node carries a breaker rating (circuits do), the ceiling is that
// rating scaled by mains voltage and a safety factor; otherwise a conservative
// whole-panel fallback is used. The ceiling only needs to sit far below a
// lifetime-cumulative-as-delta (megawatts) while staying above any real
// catch-up delta, so exact voltage is immaterial.
func (t *EnergyTracker) ceilingWatts(props map[string]interface{}) float64 {
	if rating, ok := getFloat(props, "breaker-rating"); ok && rating > 0 {
		return rating * mainsVoltage * ceilingSafetyFactor
	}
	return t.maxAvgWatts
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
