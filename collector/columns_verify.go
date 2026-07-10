package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// columnTypeMismatch records a pinned column whose live QuestDB type differs
// from the type the collector will write.
type columnTypeMismatch struct {
	Table, Column, Want, Got string
}

func (m columnTypeMismatch) String() string {
	return fmt.Sprintf("%s.%s is %s in QuestDB but the collector writes %s",
		m.Table, m.Column, m.Got, m.Want)
}

// parseColumnTypes extracts a column-name → QuestDB-type map from a QuestDB
// /exec JSON response whose dataset rows are [columnName, type].
func parseColumnTypes(body []byte) (map[string]string, error) {
	var resp struct {
		Dataset [][]interface{} `json:"dataset"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("parse table_columns response: %w", err)
	}
	out := make(map[string]string, len(resp.Dataset))
	for _, row := range resp.Dataset {
		if len(row) < 2 {
			continue
		}
		name, ok1 := row[0].(string)
		typ, ok2 := row[1].(string)
		if ok1 && ok2 {
			out[name] = strings.ToUpper(typ)
		}
	}
	return out, nil
}

// diffPinnedTypes returns the pinned columns of table whose live type disagrees
// with the pinned type. Columns absent from live are not reported — the pinned
// DDL (ADD COLUMN IF NOT EXISTS) will create them with the correct type.
func diffPinnedTypes(table string, live map[string]string) []columnTypeMismatch {
	cols, ok := columnTypes[table]
	if !ok {
		return nil
	}
	names := make([]string, 0, len(cols))
	for col := range cols {
		names = append(names, col)
	}
	sort.Strings(names)

	var out []columnTypeMismatch
	for _, col := range names {
		want := cols[col].qddl()
		got, present := live[col]
		if !present {
			continue // pinned DDL will create it with the right type
		}
		if !strings.EqualFold(got, want) {
			out = append(out, columnTypeMismatch{
				Table: table, Column: col, Want: want, Got: strings.ToUpper(got),
			})
		}
	}
	return out
}

// VerifyPinnedColumns checks every pinned table's live column types against the
// pins and logs a loud warning per mismatch. Best-effort and non-fatal: a query
// failure or a mismatch never blocks startup (HTTP ingestion isolates a bad
// column to its own table). Run AFTER CreateTables so freshly-added columns are
// already present.
func (q *QuestDBWriter) VerifyPinnedColumns() {
	tables := make([]string, 0, len(columnTypes))
	for t := range columnTypes {
		tables = append(tables, t)
	}
	sort.Strings(tables)

	total := 0
	for _, table := range tables {
		live, err := q.fetchColumnTypes(table)
		if err != nil {
			q.logger.Warn("could not verify pinned column types", "table", table, "error", err)
			continue
		}
		for _, m := range diffPinnedTypes(table, live) {
			total++
			q.logger.Warn("pinned column type does not match QuestDB; rows for this table will be rejected until the column is migrated",
				"table", m.Table, "column", m.Column, "questdb_type", m.Got, "collector_writes", m.Want,
				"fix", fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s; -- it is recreated as %s on the next write", m.Table, m.Column, m.Want))
		}
	}
	if total == 0 {
		q.logger.Info("pinned column types verified against QuestDB", "tables", len(tables))
	} else {
		q.logger.Warn("pinned column type mismatches detected", "count", total)
	}
}

// fetchColumnTypes queries QuestDB for a table's live column types.
func (q *QuestDBWriter) fetchColumnTypes(table string) (map[string]string, error) {
	query := fmt.Sprintf("SELECT \"column\", type FROM table_columns('%s')", table)
	u := fmt.Sprintf("http://%s:%d/exec?query=%s",
		q.cfg.Host, q.cfg.HTTPPort, url.QueryEscape(query))

	resp, err := qdbHTTP.Get(u)
	if err != nil {
		return nil, fmt.Errorf("query column types: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("query column types: HTTP %d", resp.StatusCode)
	}
	dec := json.NewDecoder(resp.Body)
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode column types: %w", err)
	}
	return parseColumnTypes(raw)
}
