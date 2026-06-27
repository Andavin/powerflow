package main

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A QuestDB /exec response for: SELECT "column", type FROM table_columns('panel_core')
const sampleColumnsJSON = `{
  "query": "SELECT \"column\", type FROM table_columns('panel_core')",
  "columns": [{"name":"column","type":"STRING"},{"name":"type","type":"STRING"}],
  "dataset": [
    ["device_id","SYMBOL"],
    ["ts","TIMESTAMP"],
    ["hardware_version","VARCHAR"],
    ["postal_code","LONG"],
    ["l1_voltage","DOUBLE"],
    ["breaker_rating","LONG"],
    ["grid_islandable","BOOLEAN"]
  ],
  "count": 7
}`

func TestParseColumnTypes(t *testing.T) {
	got, err := parseColumnTypes([]byte(sampleColumnsJSON))
	if err != nil {
		t.Fatalf("parseColumnTypes error: %v", err)
	}
	want := map[string]string{
		"device_id":        "SYMBOL",
		"ts":               "TIMESTAMP",
		"hardware_version": "VARCHAR",
		"postal_code":      "LONG",
		"l1_voltage":       "DOUBLE",
		"breaker_rating":   "LONG",
		"grid_islandable":  "BOOLEAN",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d columns, want %d: %v", len(got), len(want), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("column %q: got %q, want %q", k, got[k], v)
		}
	}
}

// postal_code is pinned to VARCHAR but the live column is LONG — exactly the
// un-migrated case the check must catch. hardware_version (VARCHAR) and the
// numeric/boolean pins match, so they must NOT be reported.
func TestDiffPinnedTypes_DetectsMismatch(t *testing.T) {
	live := map[string]string{
		"hardware_version": "VARCHAR",
		"postal_code":      "LONG", // mismatch: pinned VARCHAR
		"l1_voltage":       "DOUBLE",
		"breaker_rating":   "LONG",
		"grid_islandable":  "BOOLEAN",
	}
	got := diffPinnedTypes("panel_core", live)

	if len(got) != 1 {
		t.Fatalf("expected exactly 1 mismatch, got %d: %v", len(got), got)
	}
	m := got[0]
	if m.Column != "postal_code" || m.Want != "VARCHAR" || m.Got != "LONG" {
		t.Errorf("unexpected mismatch: %+v", m)
	}
}

func TestDiffPinnedTypes_AllMatchNoReport(t *testing.T) {
	live := map[string]string{
		"hardware_version": "VARCHAR",
		"postal_code":      "VARCHAR",
		"l1_voltage":       "DOUBLE",
		"breaker_rating":   "LONG",
		"grid_islandable":  "BOOLEAN",
	}
	if got := diffPinnedTypes("panel_core", live); len(got) != 0 {
		t.Errorf("expected no mismatches, got: %v", got)
	}
}

// Columns not yet present in the live schema must not be flagged — the pinned
// DDL creates them with the right type.
func TestDiffPinnedTypes_AbsentColumnNotReported(t *testing.T) {
	live := map[string]string{"l1_voltage": "DOUBLE"} // everything else absent
	if got := diffPinnedTypes("panel_core", live); len(got) != 0 {
		t.Errorf("absent columns should not be reported, got: %v", got)
	}
}

// Case-insensitive type comparison (QuestDB may report lower/upper case).
func TestDiffPinnedTypes_CaseInsensitive(t *testing.T) {
	live := map[string]string{"hardware_version": "varchar", "l1_voltage": "double"}
	if got := diffPinnedTypes("panel_core", live); len(got) != 0 {
		t.Errorf("case should not matter, got: %v", got)
	}
}

// End-to-end: VerifyPinnedColumns queries QuestDB over HTTP and logs a loud
// warning naming the mismatched column and the conflicting live type.
func TestVerifyPinnedColumns_LogsLiveMismatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/exec" {
			t.Errorf("expected /exec, got %s", r.URL.Path)
		}
		io.WriteString(w, sampleColumnsJSON) // postal_code reported as LONG
	}))
	defer srv.Close()

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	qw := testWriter(t, srv.URL, logger)

	qw.VerifyPinnedColumns()

	out := logBuf.String()
	if !strings.Contains(out, "postal_code") {
		t.Errorf("expected a warning naming postal_code, got: %s", out)
	}
	if !strings.Contains(out, "LONG") {
		t.Errorf("expected the live type LONG in the warning, got: %s", out)
	}
	if !strings.Contains(out, "level=WARN") {
		t.Errorf("mismatch should be logged at WARN, got: %s", out)
	}
}

func TestColumnTypeMismatch_StringIsReadable(t *testing.T) {
	m := columnTypeMismatch{Table: "panel_core", Column: "postal_code", Want: "VARCHAR", Got: "LONG"}
	s := m.String()
	if !strings.Contains(s, "postal_code") || !strings.Contains(s, "LONG") || !strings.Contains(s, "VARCHAR") {
		t.Errorf("unreadable mismatch string: %q", s)
	}
}
