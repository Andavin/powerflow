package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// Authoritative column types
// ---------------------------------------------------------------------------
//
// The QuestDB column type for an ILP column is locked by the FIRST value ever
// written to it. The SPAN panel's Homie $description, however, can change a
// property's declared datatype across firmware updates — so a value the
// collector once wrote as a string can later arrive as a float (or vice versa)
// and collide with the locked column. Over ILP that collision is not local:
// QuestDB rejects the offending line AND aborts the rest of the TCP buffer,
// silently dropping every other table's rows batched behind it.
//
// columnTypes makes the COLLECTOR the source of truth for the columns we care
// about: each listed column is always encoded as the pinned type regardless of
// what the panel currently declares. Identifier/label metadata whose values
// merely look numeric (hardware_version "2", postal_code "59937") is pinned to
// string so it can never again be sent as a number into a VARCHAR column.
//
// Only columns with authoritative ground truth (panel_core, circuits) are
// listed. Anything absent flows through the existing $description-driven
// inference, so genuinely new firmware fields still appear automatically.

type qType int

const (
	qString qType = iota
	qDouble
	qLong
	qBoolean
)

// qddl is the QuestDB DDL type name for this pinned type.
func (t qType) qddl() string {
	switch t {
	case qDouble:
		return "DOUBLE"
	case qLong:
		return "LONG"
	case qBoolean:
		return "BOOLEAN"
	default:
		return "VARCHAR"
	}
}

// columnTypes maps table -> snake_case column -> pinned type.
var columnTypes = map[string]map[string]qType{
	"panel_core": {
		// identifier / label metadata — always strings (VARCHAR)
		"hardware_version":      qString,
		"software_version":      qString,
		"serial_number":         qString,
		"model":                 qString,
		"vendor_name":           qString,
		"vendor_cloud":          qString,
		"wifi_ssid":             qString,
		"postal_code":           qString,
		"time_zone":             qString,
		"door":                  qString,
		"relay":                 qString,
		"dominant_power_source": qString,
		// measurements
		"l1_voltage": qDouble,
		"l2_voltage": qDouble,
		// counts
		"breaker_rating": qLong,
		// flags
		"grid_islandable": qBoolean,
		"ethernet":        qBoolean,
		"wifi":            qBoolean,
	},
	"circuits": {
		"relay":           qString,
		"relay_requester": qString,
		"shed_priority":   qString,
		"current":         qDouble,
		"active_power":    qDouble,
		"imported_energy": qDouble,
		"exported_energy": qDouble,
		"space":           qLong,
		"breaker_rating":  qLong,
		"pcs_priority":    qLong,
		"sheddable":       qBoolean,
		"pcs_managed":     qBoolean,
		"never_backup":    qBoolean,
		"always_on":       qBoolean,
		"dipole":          qBoolean,
	},
	"power_flows": {
		// The four instantaneous power channels (watts). Pinning them makes the
		// columns exist immediately after CREATE TABLE — before any ILP write —
		// so the hourly rollup view (see viewDDL) can be created on a fresh
		// database, and locks their type against a firmware change.
		"site":    qDouble,
		"pv":      qDouble,
		"grid":    qDouble,
		"battery": qDouble,
	},
}

// allPinnedColumns returns every pinned column name across all tables. The
// strict-schema filter unions this in so a pinned column (which powerflow may
// depend on) is never dropped even if the panel's $description omits it.
func allPinnedColumns() map[string]bool {
	out := map[string]bool{}
	for _, cols := range columnTypes {
		for col := range cols {
			out[col] = true
		}
	}
	return out
}

// pinnedType returns the authoritative type for table.col, if one is pinned.
func pinnedType(table, col string) (qType, bool) {
	cols, ok := columnTypes[table]
	if !ok {
		return 0, false
	}
	t, ok := cols[col]
	return t, ok
}

// writePinnedField writes val to the ILP line coerced to the column's pinned
// type, and reports whether the column was pinned. When false, the caller falls
// back to type inference. A pinned numeric column whose value cannot be coerced
// to a number is skipped rather than written as a mismatching type — never emit
// a type the locked column would reject.
func writePinnedField(line *ilpLine, table, col string, val interface{}) bool {
	t, ok := pinnedType(table, col)
	if !ok {
		return false
	}
	switch t {
	case qString:
		line.strF(col, coerceString(val))
	case qDouble:
		if f, ok := coerceFloat(val); ok {
			line.floatF(col, f)
		}
	case qLong:
		if n, ok := coerceInt(val); ok {
			line.intF(col, n)
		}
	case qBoolean:
		line.boolF(col, coerceBool(val))
	}
	return true
}

// pinnedColumnDDL returns idempotent ALTER statements that ensure every pinned
// column exists with its authoritative QuestDB type. Run after the base
// CREATE TABLE DDL: it materialises columns the panel may not have published
// yet, and recreates any that were dropped to fix a type mismatch (e.g.
// hardware_version/postal_code) with the correct type. ADD COLUMN IF NOT EXISTS
// never alters an existing column, so it is safe to run on every startup.
func pinnedColumnDDL() []string {
	tables := make([]string, 0, len(columnTypes))
	for table := range columnTypes {
		tables = append(tables, table)
	}
	sort.Strings(tables)

	var stmts []string
	for _, table := range tables {
		cols := columnTypes[table]
		names := make([]string, 0, len(cols))
		for col := range cols {
			names = append(names, col)
		}
		sort.Strings(names)
		for _, col := range names {
			stmts = append(stmts, fmt.Sprintf(
				"ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s",
				table, col, cols[col].qddl()))
		}
	}
	return stmts
}

func coerceString(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(x, 10)
	case bool:
		return strconv.FormatBool(x)
	default:
		return fmt.Sprint(x)
	}
}

func coerceFloat(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int64:
		return float64(x), true
	case string:
		f, err := strconv.ParseFloat(x, 64)
		return f, err == nil
	}
	return 0, false
}

func coerceInt(v interface{}) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case float64:
		return int64(x), true
	case string:
		n, err := strconv.ParseInt(x, 10, 64)
		return n, err == nil
	}
	return 0, false
}

func coerceBool(v interface{}) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return strings.EqualFold(x, "true")
	}
	return false
}
