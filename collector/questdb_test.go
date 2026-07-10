package main

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"
)

func TestPropToColumn(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"relay-state", "relay_state"},
		{"imported-energy", "imported_energy"},
		{"voltage", "voltage"},
		{"a-b-c-d", "a_b_c_d"},
		{"no-dashes-here", "no_dashes_here"},
		{"already_snake", "already_snake"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := propToColumn(tt.input); got != tt.want {
				t.Errorf("propToColumn(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestEscILPName(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"simple", "simple"},
		{"has space", `has\ space`},
		{"has,comma", `has\,comma`},
		{"has=eq", `has\=eq`},
		{`has\back`, `has\\back`},
		{`a b,c=d\e`, `a\ b\,c\=d\\e`},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := escILPName(tt.input); got != tt.want {
				t.Errorf("escILPName(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestEscILPTag(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"simple", "simple"},
		{"has space", `has\ space`},
		{"has,comma", `has\,comma`},
		{"has=eq", `has\=eq`},
		{`has\back`, `has\\back`},
		{"has\nnewline", "hasnewline"}, // newlines stripped
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := escILPTag(tt.input); got != tt.want {
				t.Errorf("escILPTag(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestEscILPStr(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"simple", "simple"},
		{`has"quote`, `has\"quote`},
		{`has\back`, `has\\back`},
		{"has\nnewline", `has\nnewline`},
		{`a"b\c` + "\n" + "d", `a\"b\\c\nd`},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := escILPStr(tt.input); got != tt.want {
				t.Errorf("escILPStr(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestILPLineBasic(t *testing.T) {
	ts := time.Date(2024, 1, 15, 12, 0, 0, 0, time.UTC)

	line := newILP("my_table")
	line.tag("device_id", "dev-1")
	line.floatF("voltage", 120.5)
	line.intF("count", 42)
	line.boolF("active", true)
	line.strF("label", "hello")

	result := line.at(ts)

	if !strings.HasPrefix(result, "my_table,device_id=dev-1 ") {
		t.Errorf("prefix mismatch: %q", result)
	}
	if !strings.Contains(result, "voltage=120.5") {
		t.Errorf("missing voltage field: %q", result)
	}
	if !strings.Contains(result, "count=42i") {
		t.Errorf("missing count field: %q", result)
	}
	if !strings.Contains(result, "active=t") {
		t.Errorf("missing active field: %q", result)
	}
	if !strings.Contains(result, `label="hello"`) {
		t.Errorf("missing label field: %q", result)
	}
	expectedTS := fmt.Sprintf("%d", ts.UnixNano())
	if !strings.HasSuffix(result, expectedTS+"\n") {
		t.Errorf("timestamp suffix mismatch: %q", result)
	}
}

func TestILPLineEmptyTagSkipped(t *testing.T) {
	line := newILP("table")
	line.tag("filled", "val")
	line.tag("empty", "")
	line.floatF("x", 1.0)
	result := line.at(time.Now())

	if strings.Contains(result, "empty=") {
		t.Errorf("empty tag should be skipped: %q", result)
	}
}

func TestILPLineNoFieldsReturnsEmpty(t *testing.T) {
	line := newILP("table")
	line.tag("device_id", "dev-1")
	result := line.at(time.Now())

	if result != "" {
		t.Errorf("no fields should return empty string, got %q", result)
	}
}

func TestILPLineBoolFalse(t *testing.T) {
	line := newILP("t")
	line.boolF("flag", false)
	result := line.at(time.Now())

	if !strings.Contains(result, "flag=f") {
		t.Errorf("expected flag=f, got %q", result)
	}
}

func TestILPLineMultipleTags(t *testing.T) {
	line := newILP("t")
	line.tag("a", "1")
	line.tag("b", "2")
	line.tag("c", "3")
	line.floatF("val", 1.0)
	result := line.at(time.Now())

	// Tags should appear before the space separator
	spaceIdx := strings.Index(result, " ")
	tagPart := result[:spaceIdx]
	if !strings.Contains(tagPart, "a=1") || !strings.Contains(tagPart, "b=2") || !strings.Contains(tagPart, "c=3") {
		t.Errorf("missing tags in %q", tagPart)
	}
}

func TestBuildRowLine(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)

	props := map[string]interface{}{
		"voltage":     120.5,
		"relay-state": "CLOSED",
		"power":       1500.0,
		"breaker-on":  true,
	}

	result := buildRowLine("panel_core", "dev-1", nil, props, ts)

	if result == "" {
		t.Fatal("expected non-empty result")
	}
	if !strings.HasPrefix(result, "panel_core,device_id=dev-1") {
		t.Errorf("bad prefix: %q", result)
	}
	// relay_state is in symbolProps → should be a tag, not a field
	if !strings.Contains(result, "relay_state=CLOSED") {
		t.Errorf("relay_state should be a tag: %q", result)
	}
	// voltage should be a field
	if !strings.Contains(result, "voltage=120.5") {
		t.Errorf("missing voltage field: %q", result)
	}
}

func TestIsValidColumnName(t *testing.T) {
	tests := []struct {
		col  string
		want bool
	}{
		{"relay", true},
		{"active_power", true},
		{"l1_voltage", true},
		{"_private", true},
		{"", false},
		{"relay/", false}, // leaked "<circuit>/relay/set" → propToColumn keeps '/'
		{"relay/set", false},
		{"1phase", false}, // may not start with a digit
		{"has space", false},
		{"weird=name", false},
	}
	for _, tt := range tests {
		if got := isValidColumnName(tt.col); got != tt.want {
			t.Errorf("isValidColumnName(%q) = %v, want %v", tt.col, got, tt.want)
		}
	}
}

// TestBuildRowLineSkipsInvalidColumn is the backstop regression guard: even if a
// command/attribute sub-topic leaks through as a property, the row builder must
// drop that column (not emit "relay/") while still writing the valid columns —
// otherwise one bad name rejects the whole table's ILP batch.
func TestBuildRowLineSkipsInvalidColumn(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	props := map[string]interface{}{
		"relay":        "CLOSED", // valid (symbol)
		"relay/set":    "1",      // leaked command sub-topic → invalid column, must be skipped
		"active-power": 42.0,     // valid field
	}
	result := buildRowLine("circuits", "dev-1", nil, props, ts)

	if strings.Contains(result, "relay/") {
		t.Errorf("invalid column leaked into line: %q", result)
	}
	if !strings.Contains(result, "active_power=42") {
		t.Errorf("valid field should still be written: %q", result)
	}
}

func TestBuildRowLineWithExtras(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	extras := map[string]string{"direction": "upstream"}
	props := map[string]interface{}{"voltage": 120.0}

	result := buildRowLine("panel_lugs", "dev-1", extras, props, ts)

	if !strings.Contains(result, "direction=upstream") {
		t.Errorf("missing extra symbol: %q", result)
	}
}

func TestBuildRowLineEmptyProps(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	result := buildRowLine("panel_core", "dev-1", nil, map[string]interface{}{}, ts)

	if result != "" {
		t.Errorf("empty props should produce empty line, got %q", result)
	}
}

func TestBuildRowLineSymbolOnly(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	// Props that are all symbol-type strings — they become tags, not fields
	props := map[string]interface{}{
		"relay-state": "CLOSED",
		"name":        "Core",
	}

	result := buildRowLine("panel_core", "dev-1", nil, props, ts)

	// All values are symbols → no fields → empty
	if result != "" {
		t.Errorf("all-symbol props should produce empty line (no fields), got %q", result)
	}
}

func TestBuildUnknownNodeLine(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	props := map[string]interface{}{
		"voltage": 120.5,
		"status":  "OK",
	}

	result, err := buildUnknownNodeLine("dev-1", "mystery-node", props, ts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.HasPrefix(result, "unknown_topics,device_id=dev-1,node_id=mystery-node ") {
		t.Errorf("bad prefix: %q", result)
	}
	if !strings.Contains(result, `properties="`) {
		t.Errorf("missing properties field: %q", result)
	}
	if !strings.Contains(result, "property_count=2i") {
		t.Errorf("missing/wrong property_count: %q", result)
	}
}

func TestBuildUnknownNodeLineEmptyProps(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	result, err := buildUnknownNodeLine("dev-1", "node", map[string]interface{}{}, ts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "property_count=0i") {
		t.Errorf("expected property_count=0i: %q", result)
	}
}

func TestBuildEnergyDeltaLine(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	d := &EnergyDelta{
		NodeID:     "circuit-abc",
		NodeType:   "circuit",
		Name:       "Kitchen",
		ImportedWh: 10.5,
		ExportedWh: 2.3,
		PeriodMs:   5000,
		AvgImportW: 7560,
		AvgExportW: 1656,
	}

	result := buildEnergyDeltaLine("dev-1", d, ts)

	if !strings.HasPrefix(result, "power_usage,device_id=dev-1,node_id=circuit-abc,node_type=circuit,name=Kitchen ") {
		t.Errorf("bad prefix: %q", result)
	}
	if !strings.Contains(result, "imported_wh=10.5") {
		t.Errorf("missing imported_wh: %q", result)
	}
	if !strings.Contains(result, "exported_wh=2.3") {
		t.Errorf("missing exported_wh: %q", result)
	}
	if !strings.Contains(result, "period=5000") {
		t.Errorf("missing period: %q", result)
	}
	if !strings.Contains(result, "avg_import_w=7560") {
		t.Errorf("missing avg_import_w: %q", result)
	}
	if !strings.Contains(result, "avg_export_w=1656") {
		t.Errorf("missing avg_export_w: %q", result)
	}
}

func TestBuildEnergyDeltaLineSpecialChars(t *testing.T) {
	ts := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	d := &EnergyDelta{
		NodeID:     "node-with-dashes",
		NodeType:   "circuit",
		Name:       "EV Charger",
		ImportedWh: 1.0,
		ExportedWh: 0.0,
		PeriodMs:   1000,
		AvgImportW: 3600,
		AvgExportW: 0,
	}

	result := buildEnergyDeltaLine("dev-1", d, ts)
	// Space in name should be escaped in tag
	if !strings.Contains(result, `name=EV\ Charger`) {
		t.Errorf("space in tag value not escaped: %q", result)
	}
}

func TestBuildRowLineRandomized(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	ts := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

	for i := 0; i < 50; i++ {
		props := map[string]interface{}{}
		numProps := r.Intn(10) + 1
		for j := 0; j < numProps; j++ {
			key := fmt.Sprintf("prop-%d", j)
			switch r.Intn(4) {
			case 0:
				props[key] = r.Float64() * 1000
			case 1:
				props[key] = int64(r.Intn(10000))
			case 2:
				props[key] = r.Intn(2) == 0
			case 3:
				props[key] = fmt.Sprintf("str-%d", r.Intn(100))
			}
		}

		result := buildRowLine("test_table", "dev-1", nil, props, ts)

		// Should either be empty (if all props are symbols, which they won't be here) or valid ILP
		if result == "" {
			continue
		}
		if !strings.HasPrefix(result, "test_table,device_id=dev-1 ") {
			t.Errorf("iteration %d: bad prefix: %q", i, result)
		}
		if !strings.HasSuffix(result, "\n") {
			t.Errorf("iteration %d: missing newline: %q", i, result)
		}
	}
}

func TestNodeTableMapCoverage(t *testing.T) {
	// Verify every node in nodeTableMap is in knownNodes
	for nodeID := range nodeTableMap {
		if _, ok := knownNodes[nodeID]; !ok {
			t.Errorf("nodeTableMap has %q but knownNodes doesn't", nodeID)
		}
	}
}

func TestSymbolPropsArePropToColumn(t *testing.T) {
	// Verify symbolProps keys are already in snake_case
	for prop := range symbolProps {
		if strings.Contains(prop, "-") {
			t.Errorf("symbolProp %q contains dash — should be snake_case (propToColumn output)", prop)
		}
	}
}
