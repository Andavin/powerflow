package main

import "testing"

// filterToAllowed keeps declared properties, pinned columns, and name; drops
// anything else a described node published.
func TestFilterToAllowed(t *testing.T) {
	declared := map[string]bool{"active-power": true, "relay": true}
	pins := map[string]bool{"imported_energy": true}
	props := map[string]interface{}{
		"active-power":    1.0,      // declared → keep
		"relay":           "CLOSED", // declared → keep
		"imported-energy": 5.0,      // pinned column (imported_energy) → keep
		"name":            "Fridge", // always kept (powerflow reads it)
		"mystery-field":   9.0,      // undeclared + unpinned → drop
	}
	out := filterToAllowed("c1", props, declared, pins, testLogger())

	for _, k := range []string{"active-power", "relay", "imported-energy", "name"} {
		if _, ok := out[k]; !ok {
			t.Errorf("%q should be kept", k)
		}
	}
	if _, ok := out["mystery-field"]; ok {
		t.Error("undeclared, unpinned property should be dropped")
	}
}

// allPinnedColumns unions every table's pins (protecting powerflow columns).
func TestAllPinnedColumnsIncludesCritical(t *testing.T) {
	pins := allPinnedColumns()
	for _, col := range []string{"active_power", "relay", "imported_energy", "breaker_rating"} {
		if !pins[col] {
			t.Errorf("expected %q in pinned columns", col)
		}
	}
}
