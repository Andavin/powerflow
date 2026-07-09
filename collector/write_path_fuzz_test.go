package main

import (
	"strings"
	"testing"
	"time"
)

// FuzzWritePathColumns is the class-level guard the relay/set incident motivated:
// no property name — however malformed — may reach QuestDB as a column key. It
// drives an arbitrary (property, value) through State.Update and buildRowLine and
// asserts that any property whose column is not a valid identifier never appears
// as a `col=` key in the emitted ILP line (it must be dropped), while a valid
// anchor field is still written. This catches ANY poison-column input, not just
// the specific sub-topics we already filter.
func FuzzWritePathColumns(f *testing.F) {
	seeds := []struct{ prop, val string }{
		{"relay/set", "1"},
		{"relay/$settable", "true"},
		{"active-power", "5.0"},
		{"name", "Fridge"},
		{"weird key", "x"},
		{"a=b", "1"},
		{"a,b", "1"},
		{`a"b`, "x"},
		{"/leading", "1"},
		{"emoji✨", "1"},
		{"has\nnewline", "1"},
		{`back\slash`, "1"},
		{"", ""},
	}
	for _, s := range seeds {
		f.Add(s.prop, s.val)
	}

	f.Fuzz(func(t *testing.T, prop, val string) {
		st := newPostDescState(t, 0)
		st.Update("c1", "voltage", []byte("120")) // valid anchor field, always present
		st.Update("c1", prop, []byte(val))
		props := st.NodeValues("c1")

		line := buildRowLine("circuits", "dev", map[string]string{"circuit_id": "c1"}, props, time.Unix(0, 0))

		for p := range props {
			col := propToColumn(p)
			// col=="" carries no key (an empty property produces no column); the
			// substring test would spuriously match every "=" otherwise.
			if col != "" && !isValidColumnName(col) && strings.Contains(line, col+"=") {
				t.Fatalf("invalid column %q leaked as a key into %q", col, line)
			}
		}
		// A non-empty line must still be structurally sane (anchor field present).
		if line != "" {
			if !strings.HasPrefix(line, "circuits,") || !strings.Contains(line, "voltage=") {
				t.Fatalf("malformed line: %q", line)
			}
		}
	})
}
