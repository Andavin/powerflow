package main

import (
	"strings"
	"testing"
	"time"
)

// The real QuestDB ILP-HTTP error body for the relay/set incident (invalid
// column name), and a representative cast/type-mismatch error.
const (
	invalidNameBody = `{"code":"invalid","message":"failed to parse line protocol:\nerrors encountered on line(s):\nerror in line 1: table: circuits; invalid column name: relay/","line":1,"errorId":"467e483a37c1-0"}`
	castErrorBody   = `{"code":"invalid","message":"failed to parse line protocol:\nerrors encountered on line(s):\nerror in line 3: table: panel_core, column: postal_code; cast error from protocol type: STRING to column type: DOUBLE","line":3,"errorId":"abc-1"}`
	multiErrorBody  = `{"code":"invalid","message":"failed to parse line protocol:\nerrors encountered on line(s):\nerror in line 1: table: circuits; invalid column name: relay/\nerror in line 2: table: panel_core, column: postal_code; cast error from protocol type: STRING to column type: DOUBLE","line":2,"errorId":"z-9"}`
)

func TestParseColumnRejections(t *testing.T) {
	tests := []struct {
		name string
		body string
		want []ilpRejection
	}{
		{"invalid name", invalidNameBody, []ilpRejection{{"circuits", "relay/"}}},
		{"cast error", castErrorBody, []ilpRejection{{"panel_core", "postal_code"}}},
		{"multiple", multiErrorBody, []ilpRejection{
			{"circuits", "relay/"},
			{"panel_core", "postal_code"},
		}},
		{"unparseable", `{"code":"invalid","message":"totally different"}`, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseColumnRejections(tt.body)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d rejections %v, want %d %v", len(got), got, len(tt.want), tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("rejection[%d] = %v, want %v", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// A cast-error column is a full identifier → exact match; an invalid-name
// column is truncated by QuestDB → prefix match against the full property.
func TestColumnRejectedMatching(t *testing.T) {
	bad := map[string]bool{"relay/": true, "postal_code": true}
	cases := []struct {
		col  string
		want bool
	}{
		{"relay/set", true},      // prefix-matches the truncated "relay/"
		{"relay", false},         // valid column with same stem must NOT be dropped
		{"postal_code", true},    // exact match
		{"postal_code_2", false}, // exact-only for identifier names
		{"active_power", false},
	}
	for _, c := range cases {
		if got := columnRejected(c.col, bad); got != c.want {
			t.Errorf("columnRejected(%q) = %v, want %v", c.col, got, c.want)
		}
	}
}

// End-to-end: once a column is quarantined, writeRow must stop emitting it while
// still writing the row's valid columns.
func TestWriterDropsQuarantinedColumn(t *testing.T) {
	q, err := NewQuestDBWriter(QuestDBConfig{Host: "127.0.0.1", HTTPPort: 9000}, "dev-1", testLogger())
	if err != nil {
		t.Fatal(err)
	}
	q.quarantineColumn("panel_core", "postal_code")

	props := map[string]interface{}{
		"postal_code": "59937", // quarantined → must be dropped
		"l1-voltage":  240.0,   // valid → must remain
	}
	q.writeRow("panel_core", nil, props, time.Unix(0, 0))

	line := q.buf.String()
	if strings.Contains(line, "postal_code") {
		t.Errorf("quarantined column leaked: %q", line)
	}
	if !strings.Contains(line, "l1_voltage=240") {
		t.Errorf("valid column dropped: %q", line)
	}
}
