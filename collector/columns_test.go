package main

import (
	"strings"
	"testing"
	"time"
)

var coerceTS = time.Date(2026, 6, 27, 0, 0, 0, 0, time.UTC)

// hardware_version and postal_code are identifier metadata: their values look
// numeric ("2", "59937") but they must be written as strings so a firmware
// $description that flips their declared datatype can't collide with the
// VARCHAR column and poison the whole ILP batch. This is the core regression
// fix.
func TestBuildRowLine_PinnedMetadataWrittenAsString(t *testing.T) {
	props := map[string]interface{}{
		"hardware_version": float64(2), // panel sends this as a numeric now
		"postal_code":      int64(59937),
	}
	got := buildRowLine("panel_core", "dev-1", nil, props, coerceTS)

	if !strings.Contains(got, `hardware_version="2"`) {
		t.Errorf("hardware_version should be a quoted string, got: %q", got)
	}
	if !strings.Contains(got, `postal_code="59937"`) {
		t.Errorf("postal_code should be a quoted string, got: %q", got)
	}
	// And must NOT appear as a bare numeric field (the bug).
	if strings.Contains(got, "hardware_version=2,") || strings.HasSuffix(firstField(got, "hardware_version"), "=2") {
		t.Errorf("hardware_version must not be a bare numeric: %q", got)
	}
}

func TestBuildRowLine_PinnedNumericStaysNumeric(t *testing.T) {
	props := map[string]interface{}{
		"l1_voltage":     float64(123.4),
		"breaker_rating": int64(200),
	}
	got := buildRowLine("panel_core", "dev-1", nil, props, coerceTS)

	if !strings.Contains(got, "l1_voltage=123.4") {
		t.Errorf("l1_voltage should stay a double field, got: %q", got)
	}
	if !strings.Contains(got, "breaker_rating=200i") {
		t.Errorf("breaker_rating should stay a long field, got: %q", got)
	}
}

func TestBuildRowLine_PinnedBooleanStaysBoolean(t *testing.T) {
	props := map[string]interface{}{"grid_islandable": true}
	got := buildRowLine("panel_core", "dev-1", nil, props, coerceTS)
	if !strings.Contains(got, "grid_islandable=t") {
		t.Errorf("grid_islandable should be a bool field, got: %q", got)
	}
}

// A pinned double column whose value still parses must be coerced; a string
// hardware_version coming through (e.g. "2.0") must end up quoted, not dropped.
func TestBuildRowLine_PinnedStringFromStringValue(t *testing.T) {
	props := map[string]interface{}{"hardware_version": "2.0"}
	got := buildRowLine("panel_core", "dev-1", nil, props, coerceTS)
	if !strings.Contains(got, `hardware_version="2.0"`) {
		t.Errorf("string hardware_version should be quoted unchanged, got: %q", got)
	}
}

// Columns we have NOT pinned must keep the existing type-inference behavior so
// new firmware fields still flow through.
func TestBuildRowLine_UnpinnedColumnUsesInference(t *testing.T) {
	props := map[string]interface{}{"some_new_field": int64(7)}
	got := buildRowLine("panel_core", "dev-1", nil, props, coerceTS)
	if !strings.Contains(got, "some_new_field=7i") {
		t.Errorf("unpinned column should use inference (int -> 7i), got: %q", got)
	}
}

// Tables we have not pinned at all must be completely unaffected.
func TestBuildRowLine_UnpinnedTableUnaffected(t *testing.T) {
	props := map[string]interface{}{"hardware_version": float64(2)}
	got := buildRowLine("power_flows", "dev-1", nil, props, coerceTS)
	if !strings.Contains(got, "hardware_version=2") {
		t.Errorf("unpinned table should not coerce, got: %q", got)
	}
}

// pinnedColumnDDL must emit idempotent ALTER statements so dropped/missing
// columns are (re)created with their authoritative type at startup.
func TestPinnedColumnDDL(t *testing.T) {
	all := strings.Join(pinnedColumnDDL(), "\n")

	want := []string{
		// the two columns dropped on the live DB must come back as VARCHAR
		"ALTER TABLE panel_core ADD COLUMN IF NOT EXISTS hardware_version VARCHAR",
		"ALTER TABLE panel_core ADD COLUMN IF NOT EXISTS postal_code VARCHAR",
		// representative coverage of each pinned type
		"ALTER TABLE panel_core ADD COLUMN IF NOT EXISTS l1_voltage DOUBLE",
		"ALTER TABLE panel_core ADD COLUMN IF NOT EXISTS breaker_rating LONG",
		"ALTER TABLE panel_core ADD COLUMN IF NOT EXISTS grid_islandable BOOLEAN",
		"ALTER TABLE circuits ADD COLUMN IF NOT EXISTS imported_energy DOUBLE",
	}
	for _, w := range want {
		if !strings.Contains(all, w) {
			t.Errorf("pinnedColumnDDL() missing statement:\n  %s\ngot:\n%s", w, all)
		}
	}

	// One statement per pinned column, no more.
	n := 0
	for _, cols := range columnTypes {
		n += len(cols)
	}
	if len(pinnedColumnDDL()) != n {
		t.Errorf("expected %d DDL statements (one per pinned column), got %d", n, len(pinnedColumnDDL()))
	}
}

// firstField returns the "name=value" token for the named column, for assertions.
func firstField(line, col string) string {
	for _, tok := range strings.FieldsFunc(line, func(r rune) bool { return r == ',' || r == ' ' }) {
		if strings.HasPrefix(tok, col+"=") {
			return tok
		}
	}
	return ""
}
