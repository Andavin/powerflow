package main

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
	"time"
)

func TestGetFloat(t *testing.T) {
	tests := []struct {
		name  string
		props map[string]interface{}
		key   string
		want  float64
		ok    bool
	}{
		{"float64 value", map[string]interface{}{"e": 3.14}, "e", 3.14, true},
		{"int64 value", map[string]interface{}{"e": int64(42)}, "e", 42.0, true},
		{"missing key", map[string]interface{}{"other": 1.0}, "e", 0, false},
		{"string value", map[string]interface{}{"e": "hello"}, "e", 0, false},
		{"bool value", map[string]interface{}{"e": true}, "e", 0, false},
		{"zero float", map[string]interface{}{"e": 0.0}, "e", 0.0, true},
		{"negative int", map[string]interface{}{"e": int64(-100)}, "e", -100.0, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := getFloat(tt.props, tt.key)
			if ok != tt.ok {
				t.Errorf("ok = %v, want %v", ok, tt.ok)
			}
			if got != tt.want {
				t.Errorf("value = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEnergyTrackerFirstCallBaseline(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))

	deltas := tracker.Process(s)
	if len(deltas) != 0 {
		t.Errorf("first call should return no deltas, got %d", len(deltas))
	}
}

func TestEnergyTrackerSecondCallDelta(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	// First reading — baseline
	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	tracker.Process(s)

	// Wait a tiny bit to ensure timestamp difference
	time.Sleep(2 * time.Millisecond)

	// Second reading — delta
	s.Update("lugs-upstream", "imported-energy", []byte("110.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("55.0"))
	deltas := tracker.Process(s)

	if len(deltas) != 1 {
		t.Fatalf("expected 1 delta, got %d", len(deltas))
	}

	d := deltas[0]
	if d.NodeID != "lugs-upstream" {
		t.Errorf("NodeID = %q", d.NodeID)
	}
	if d.NodeType != "upstream" {
		t.Errorf("NodeType = %q, want upstream", d.NodeType)
	}
	if d.Name != "upstream" {
		t.Errorf("Name = %q, want upstream", d.Name)
	}
	if math.Abs(d.ImportedWh-10.0) > 0.001 {
		t.Errorf("ImportedWh = %f, want 10.0", d.ImportedWh)
	}
	if math.Abs(d.ExportedWh-5.0) > 0.001 {
		t.Errorf("ExportedWh = %f, want 5.0", d.ExportedWh)
	}
	if d.PeriodMs <= 0 {
		t.Errorf("PeriodMs = %f, should be > 0", d.PeriodMs)
	}

	// Verify average power calculation: impDelta * msPerHour / periodMs
	expectedAvgImport := 10.0 * msPerHour / d.PeriodMs
	if math.Abs(d.AvgImportW-expectedAvgImport) > 0.001 {
		t.Errorf("AvgImportW = %f, want %f", d.AvgImportW, expectedAvgImport)
	}
	expectedAvgExport := 5.0 * msPerHour / d.PeriodMs
	if math.Abs(d.AvgExportW-expectedAvgExport) > 0.001 {
		t.Errorf("AvgExportW = %f, want %f", d.AvgExportW, expectedAvgExport)
	}
}

func TestEnergyTrackerCounterReset(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	tracker.Process(s)

	time.Sleep(2 * time.Millisecond)

	// Counter reset — lower values
	s.Update("lugs-upstream", "imported-energy", []byte("10.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("5.0"))
	deltas := tracker.Process(s)

	if len(deltas) != 0 {
		t.Errorf("counter reset should produce no deltas, got %d", len(deltas))
	}
}

// TestEnergyTrackerCounterResetRebasesBaseline verifies that after a counter
// reset is detected, the next non-decreasing reading produces a correct delta
// relative to the post-reset value — not relative to the pre-reset baseline.
// (Regression guard for the cache-update ordering in Process.)
func TestEnergyTrackerCounterResetRebasesBaseline(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	// Establish a high baseline.
	s.Update("lugs-upstream", "imported-energy", []byte("1000.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("500.0"))
	tracker.Process(s)
	time.Sleep(2 * time.Millisecond)

	// Counter reset to low values — no delta emitted, but baseline must be
	// rebased to (10, 5) so the next reading is a small positive delta.
	s.Update("lugs-upstream", "imported-energy", []byte("10.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("5.0"))
	if d := tracker.Process(s); len(d) != 0 {
		t.Fatalf("reset reading should produce no delta, got %d", len(d))
	}
	time.Sleep(2 * time.Millisecond)

	// Next reading: should yield delta against (10, 5), NOT (1000, 500).
	// If the cache had not been rebased, this reading (15, 7) would still
	// be negative relative to the pre-reset baseline and be skipped — so
	// asserting a non-empty delta proves rebase happened.
	s.Update("lugs-upstream", "imported-energy", []byte("15.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("7.0"))
	deltas := tracker.Process(s)
	if len(deltas) != 1 {
		t.Fatalf("expected 1 delta after rebase, got %d", len(deltas))
	}
	if deltas[0].ImportedWh != 5.0 {
		t.Errorf("imported delta = %v, want 5.0 (15 - rebased 10)", deltas[0].ImportedWh)
	}
	if deltas[0].ExportedWh != 2.0 {
		t.Errorf("exported delta = %v, want 2.0 (7 - rebased 5)", deltas[0].ExportedWh)
	}
}

// TestEnergyTrackerSkipsZeroDelta verifies that a reading where neither the
// imported nor exported counter advanced produces NO delta — keeping the
// power_usage table from filling with rows that contribute nothing.
func TestEnergyTrackerSkipsZeroDelta(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	tracker.Process(s)
	time.Sleep(2 * time.Millisecond)

	// Same values — no energy moved this period.
	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	deltas := tracker.Process(s)

	if len(deltas) != 0 {
		t.Errorf("expected 0 deltas when both counters unchanged, got %d", len(deltas))
	}
}

// TestEnergyTrackerEmitsWhenOnlyOneCounterMoves verifies that we still emit
// a delta when only one of imported/exported changed — the user explicitly wants
// asymmetric movement (e.g., importing without exporting) recorded.
func TestEnergyTrackerEmitsWhenOnlyOneCounterMoves(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	tracker.Process(s)
	time.Sleep(2 * time.Millisecond)

	// Only imported moved.
	s.Update("lugs-upstream", "imported-energy", []byte("110.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	d := tracker.Process(s)
	if len(d) != 1 || d[0].ImportedWh != 10.0 || d[0].ExportedWh != 0.0 {
		t.Fatalf("imported-only: expected 1 delta (10, 0), got %+v", d)
	}
	time.Sleep(2 * time.Millisecond)

	// Only exported moved.
	s.Update("lugs-upstream", "imported-energy", []byte("110.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("55.0"))
	d = tracker.Process(s)
	if len(d) != 1 || d[0].ImportedWh != 0.0 || d[0].ExportedWh != 5.0 {
		t.Fatalf("exported-only: expected 1 delta (0, 5), got %+v", d)
	}
}

// TestEnergyTrackerZeroSkipDoesNotInflateNextPeriod verifies the cache-update
// invariant after a zero-delta skip: the next non-zero delta covers only the
// time since the LAST observation (the skipped reading), not the time since
// the last EMITTED reading. Otherwise a long idle window would attribute a
// late energy increment to a much longer period and underreport avg power.
func TestEnergyTrackerZeroSkipDoesNotInflateNextPeriod(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	tracker.Process(s) // baseline cached, no delta
	time.Sleep(10 * time.Millisecond)

	// Zero-delta — should be skipped, but cache must update so the next
	// delta's period starts here, not 10ms ago.
	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	if d := tracker.Process(s); len(d) != 0 {
		t.Fatalf("expected zero-delta reading to be skipped, got %d deltas", len(d))
	}
	time.Sleep(10 * time.Millisecond)

	// Non-zero — period should be ~10ms (since the skipped reading), not ~20ms
	// (since the baseline). Allow a wide margin for sleep jitter on shared CI.
	s.Update("lugs-upstream", "imported-energy", []byte("110.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	d := tracker.Process(s)
	if len(d) != 1 {
		t.Fatalf("expected 1 delta, got %d", len(d))
	}
	if d[0].PeriodMs > 18 { // 10ms expected, allow up to ~18ms for jitter
		t.Errorf("period = %vms, want ~10ms (NOT ~20ms — that would mean cache wasn't updated on skip)", d[0].PeriodMs)
	}
	if d[0].ImportedWh != 10.0 {
		t.Errorf("imported delta = %v, want 10.0", d[0].ImportedWh)
	}
}

func TestEnergyTrackerCircuitNode(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	// Circuit node — not in knownNodes or energyNodeInfo
	s.Update("abc123", "imported-energy", []byte("200.0"))
	s.Update("abc123", "exported-energy", []byte("0.0"))
	s.Update("abc123", "name", []byte("Kitchen"))
	tracker.Process(s)

	time.Sleep(2 * time.Millisecond)

	s.Update("abc123", "imported-energy", []byte("210.0"))
	s.Update("abc123", "exported-energy", []byte("0.0"))
	deltas := tracker.Process(s)

	if len(deltas) != 1 {
		t.Fatalf("expected 1 delta, got %d", len(deltas))
	}
	if deltas[0].NodeType != "circuit" {
		t.Errorf("NodeType = %q, want circuit", deltas[0].NodeType)
	}
	if deltas[0].Name != "Kitchen" {
		t.Errorf("Name = %q, want Kitchen", deltas[0].Name)
	}
}

func TestEnergyTrackerCircuitNoName(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	// Circuit without a name property — should use node ID
	s.Update("hex-circuit", "imported-energy", []byte("100.0"))
	s.Update("hex-circuit", "exported-energy", []byte("0.0"))
	tracker.Process(s)

	time.Sleep(2 * time.Millisecond)

	s.Update("hex-circuit", "imported-energy", []byte("105.0"))
	s.Update("hex-circuit", "exported-energy", []byte("0.0"))
	deltas := tracker.Process(s)

	if len(deltas) != 1 {
		t.Fatalf("expected 1 delta, got %d", len(deltas))
	}
	if deltas[0].Name != "hex-circuit" {
		t.Errorf("Name = %q, want hex-circuit (node ID fallback)", deltas[0].Name)
	}
}

func TestEnergyTrackerSkipsSystemNodes(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	// "core" is in knownNodes but NOT in energyNodeInfo → should be skipped
	s.Update("core", "imported-energy", []byte("999.0"))
	s.Update("core", "exported-energy", []byte("0.0"))
	tracker.Process(s)

	time.Sleep(2 * time.Millisecond)

	s.Update("core", "imported-energy", []byte("1000.0"))
	s.Update("core", "exported-energy", []byte("0.0"))
	deltas := tracker.Process(s)

	if len(deltas) != 0 {
		t.Errorf("system nodes without energyNodeInfo should be skipped, got %d deltas", len(deltas))
	}
}

func TestEnergyTrackerNoEnergyProps(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	s.Update("some-node", "voltage", []byte("120.0"))
	s.Update("some-node", "current", []byte("5.0"))

	deltas := tracker.Process(s)
	if len(deltas) != 0 {
		t.Errorf("nodes without energy props should produce no deltas, got %d", len(deltas))
	}
}

func TestEnergyTrackerMultipleNodes(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())

	// Baseline
	s.Update("lugs-upstream", "imported-energy", []byte("100.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("50.0"))
	s.Update("lugs-downstream", "imported-energy", []byte("200.0"))
	s.Update("lugs-downstream", "exported-energy", []byte("100.0"))
	s.Update("circuit-a", "imported-energy", []byte("300.0"))
	s.Update("circuit-a", "exported-energy", []byte("0.0"))
	tracker.Process(s)

	time.Sleep(2 * time.Millisecond)

	// Second reading
	s.Update("lugs-upstream", "imported-energy", []byte("110.0"))
	s.Update("lugs-upstream", "exported-energy", []byte("55.0"))
	s.Update("lugs-downstream", "imported-energy", []byte("220.0"))
	s.Update("lugs-downstream", "exported-energy", []byte("110.0"))
	s.Update("circuit-a", "imported-energy", []byte("315.0"))
	s.Update("circuit-a", "exported-energy", []byte("0.0"))
	deltas := tracker.Process(s)

	if len(deltas) != 3 {
		t.Fatalf("expected 3 deltas, got %d", len(deltas))
	}

	byNode := map[string]EnergyDelta{}
	for _, d := range deltas {
		byNode[d.NodeID] = d
	}

	if d, ok := byNode["lugs-upstream"]; !ok {
		t.Error("missing lugs-upstream delta")
	} else if math.Abs(d.ImportedWh-10.0) > 0.001 {
		t.Errorf("upstream imported = %f, want 10.0", d.ImportedWh)
	}

	if d, ok := byNode["lugs-downstream"]; !ok {
		t.Error("missing lugs-downstream delta")
	} else if math.Abs(d.ImportedWh-20.0) > 0.001 {
		t.Errorf("downstream imported = %f, want 20.0", d.ImportedWh)
	}

	if d, ok := byNode["circuit-a"]; !ok {
		t.Error("missing circuit-a delta")
	} else if math.Abs(d.ImportedWh-15.0) > 0.001 {
		t.Errorf("circuit-a imported = %f, want 15.0", d.ImportedWh)
	}
}

func TestEnergyTrackerRandomized(t *testing.T) {
	s := NewState("dev-1", testLogger(), time.Hour)
	tracker := NewEnergyTracker(testLogger())
	r := rand.New(rand.NewSource(99))

	const numCircuits = 10
	circuitIDs := make([]string, numCircuits)
	for i := range circuitIDs {
		circuitIDs[i] = fmt.Sprintf("circuit-%d", i)
	}

	// Initialize all circuits with random baselines
	baselines := make(map[string]float64, numCircuits)
	for _, cid := range circuitIDs {
		baseline := r.Float64() * 10000
		baselines[cid] = baseline
		s.Update(cid, "imported-energy", []byte(fmt.Sprintf("%.2f", baseline)))
		s.Update(cid, "exported-energy", []byte("0"))
	}
	tracker.Process(s)

	time.Sleep(2 * time.Millisecond)

	// Add random increments
	increments := make(map[string]float64, numCircuits)
	for _, cid := range circuitIDs {
		inc := r.Float64() * 100 // 0-100 Wh
		increments[cid] = inc
		newVal := baselines[cid] + inc
		s.Update(cid, "imported-energy", []byte(fmt.Sprintf("%.2f", newVal)))
		s.Update(cid, "exported-energy", []byte("0"))
	}
	deltas := tracker.Process(s)

	if len(deltas) != numCircuits {
		t.Fatalf("expected %d deltas, got %d", numCircuits, len(deltas))
	}

	byNode := map[string]EnergyDelta{}
	for _, d := range deltas {
		byNode[d.NodeID] = d
	}

	for _, cid := range circuitIDs {
		d, ok := byNode[cid]
		if !ok {
			t.Errorf("missing delta for %s", cid)
			continue
		}
		if d.NodeType != "circuit" {
			t.Errorf("%s: NodeType = %q, want circuit", cid, d.NodeType)
		}
		// Allow small float rounding
		if math.Abs(d.ImportedWh-increments[cid]) > 0.02 {
			t.Errorf("%s: ImportedWh = %f, want ~%f", cid, d.ImportedWh, increments[cid])
		}
		if d.AvgImportW <= 0 {
			t.Errorf("%s: AvgImportW should be > 0, got %f", cid, d.AvgImportW)
		}
	}
}
