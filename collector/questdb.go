package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Table routing
// ---------------------------------------------------------------------------

// nodeTableMap routes SPAN node IDs to QuestDB table names.
var nodeTableMap = map[string]string{
	"core":            "panel_core",
	"lugs-upstream":   "panel_lugs",
	"lugs-downstream": "panel_lugs",
	"power-flows":     "power_flows",
	"pcs":             "panel_pcs",
	"bess":            "panel_bess",
}

// symbolProps lists snake_case property names written as ILP tags (SYMBOL columns).
var symbolProps = map[string]bool{
	"name":             true,
	"relay_state":      true,
	"main_relay_state": true,
	"door_state":       true,
	"power_source":     true,
	"firmware_version": true,
	"priority":         true,
	"inverter_state":   true,
	"dsp_board_state":  true,
	"charge_status":    true,
}

// ---------------------------------------------------------------------------
// DDL — only SYMBOL + timestamp columns; ILP auto-creates the rest
// ---------------------------------------------------------------------------

var tableDDL = []string{
	`CREATE TABLE IF NOT EXISTS panel_core (device_id SYMBOL, ts TIMESTAMP) timestamp(ts) PARTITION BY DAY WAL DEDUP UPSERT KEYS(ts, device_id)`,
	`CREATE TABLE IF NOT EXISTS panel_lugs (device_id SYMBOL, direction SYMBOL, ts TIMESTAMP) timestamp(ts) PARTITION BY DAY WAL DEDUP UPSERT KEYS(ts, device_id, direction)`,
	`CREATE TABLE IF NOT EXISTS power_flows (device_id SYMBOL, ts TIMESTAMP) timestamp(ts) PARTITION BY DAY WAL DEDUP UPSERT KEYS(ts, device_id)`,
	`CREATE TABLE IF NOT EXISTS panel_pcs (device_id SYMBOL, ts TIMESTAMP) timestamp(ts) PARTITION BY DAY WAL DEDUP UPSERT KEYS(ts, device_id)`,
	`CREATE TABLE IF NOT EXISTS panel_bess (device_id SYMBOL, ts TIMESTAMP) timestamp(ts) PARTITION BY DAY WAL DEDUP UPSERT KEYS(ts, device_id)`,
	`CREATE TABLE IF NOT EXISTS circuits (device_id SYMBOL, circuit_id SYMBOL, name SYMBOL, ts TIMESTAMP) timestamp(ts) PARTITION BY DAY WAL DEDUP UPSERT KEYS(ts, device_id, circuit_id)`,
	`CREATE TABLE IF NOT EXISTS power_usage (device_id SYMBOL, node_id SYMBOL, node_type SYMBOL, name SYMBOL, ts TIMESTAMP) timestamp(ts) PARTITION BY DAY WAL DEDUP UPSERT KEYS(ts, device_id, node_id)`,
	`CREATE TABLE IF NOT EXISTS unknown_topics (device_id SYMBOL, node_id SYMBOL, ts TIMESTAMP) timestamp(ts) PARTITION BY DAY WAL DEDUP UPSERT KEYS(ts, device_id, node_id)`,
}

// Materialized views — hourly rollups QuestDB maintains incrementally as
// power_flows is written. The Powerflow web app reads these for long-range
// (week/month/year) charts, scanning a few thousand pre-aggregated rows instead
// of tens of millions of raw ones. Created after the base table + its pinned
// columns exist (the SELECT references site/pv/grid/battery). Stores per-hour
// averages, sign-split component sums, and the sample count so the app can
// re-aggregate to coarser buckets with an exact count-weighted average.
var viewDDL = []string{
	`CREATE MATERIALIZED VIEW IF NOT EXISTS power_flows_1h AS (
		SELECT
			ts, device_id,
			avg(site) site_w, avg(pv) pv_w, avg(grid) grid_w, avg(battery) battery_w,
			sum(CASE WHEN battery > 0 THEN battery ELSE 0 END) batt_charge_sum,
			sum(CASE WHEN battery < 0 THEN -battery ELSE 0 END) batt_discharge_sum,
			sum(CASE WHEN grid < 0 THEN -grid ELSE 0 END) grid_import_sum,
			sum(CASE WHEN grid > 0 THEN grid ELSE 0 END) grid_export_sum,
			count() n
		FROM power_flows
		SAMPLE BY 1h
	) PARTITION BY MONTH`,
}

// ---------------------------------------------------------------------------
// ILP line builder — InfluxDB Line Protocol (sent to QuestDB over HTTP /write)
// ---------------------------------------------------------------------------

type ilpLine struct {
	buf       strings.Builder
	hasFields bool
}

func newILP(table string) *ilpLine {
	l := &ilpLine{}
	l.buf.WriteString(escILPName(table))
	return l
}

func (l *ilpLine) tag(name, value string) {
	if value == "" {
		return
	}
	l.buf.WriteByte(',')
	l.buf.WriteString(escILPName(name))
	l.buf.WriteByte('=')
	l.buf.WriteString(escILPTag(value))
}

func (l *ilpLine) sep() {
	if l.hasFields {
		l.buf.WriteByte(',')
	} else {
		l.buf.WriteByte(' ')
		l.hasFields = true
	}
}

func (l *ilpLine) floatF(name string, v float64) {
	l.sep()
	l.buf.WriteString(escILPName(name))
	l.buf.WriteByte('=')
	l.buf.WriteString(strconv.FormatFloat(v, 'f', -1, 64))
}

func (l *ilpLine) intF(name string, v int64) {
	l.sep()
	l.buf.WriteString(escILPName(name))
	l.buf.WriteByte('=')
	l.buf.WriteString(strconv.FormatInt(v, 10))
	l.buf.WriteByte('i')
}

func (l *ilpLine) boolF(name string, v bool) {
	l.sep()
	l.buf.WriteString(escILPName(name))
	l.buf.WriteByte('=')
	if v {
		l.buf.WriteByte('t')
	} else {
		l.buf.WriteByte('f')
	}
}

func (l *ilpLine) strF(name, v string) {
	l.sep()
	l.buf.WriteString(escILPName(name))
	l.buf.WriteString(`="`)
	l.buf.WriteString(escILPStr(v))
	l.buf.WriteByte('"')
}

// at finalises the line with a nanosecond timestamp. Returns "" if no fields were written.
func (l *ilpLine) at(ts time.Time) string {
	if !l.hasFields {
		return ""
	}
	l.buf.WriteByte(' ')
	l.buf.WriteString(strconv.FormatInt(ts.UnixNano(), 10))
	l.buf.WriteByte('\n')
	return l.buf.String()
}

func escILPName(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, " ", "\\ ")
	s = strings.ReplaceAll(s, ",", "\\,")
	s = strings.ReplaceAll(s, "=", "\\=")
	return s
}

func escILPTag(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, " ", "\\ ")
	s = strings.ReplaceAll(s, ",", "\\,")
	s = strings.ReplaceAll(s, "=", "\\=")
	s = strings.ReplaceAll(s, "\n", "")
	return s
}

func escILPStr(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "\"", "\\\"")
	s = strings.ReplaceAll(s, "\n", "\\n")
	return s
}

// ---------------------------------------------------------------------------
// QuestDBWriter
// ---------------------------------------------------------------------------

type QuestDBWriter struct {
	buf      bytes.Buffer
	cfg      QuestDBConfig
	deviceID string
	writeURL string
	logger   *slog.Logger

	// quarantine holds columns QuestDB rejected (invalid name, or a type
	// mismatch on an unpinned column), keyed table -> reported column name. A
	// rejected column is re-emitted from cached node state on every flush and
	// would reject that table's whole batch indefinitely; dropping it lets the
	// table's other columns keep flowing and recovers the table with no
	// operator restart. Populated in Flush, read on the same writer goroutine
	// when building rows.
	quarantine map[string]map[string]bool

	// pending is the set of tables written into the current buffer, so Flush
	// knows which tables' health to update. Writer-goroutine-only.
	pending map[string]bool

	// mu guards health, which is read by the /healthz handler and watchdog on
	// other goroutines. nowFn is overridable in tests.
	mu     sync.Mutex
	health map[string]*tableHealth
	nowFn  func() time.Time

	// spool retains batches that failed to send (QuestDB unreachable) so a
	// transient outage doesn't lose data — replayed on the next successful flush.
	spool *retrySpool
}

// tableHealth tracks per-table write outcomes for the freshness watchdog and
// /healthz. A rising RejectStreak means the table's batch keeps being rejected
// even after self-heal — the signal that a table has silently stalled.
type tableHealth struct {
	LastOK       time.Time `json:"last_ok"`
	RejectStreak int       `json:"reject_streak"`
	RejectTotal  uint64    `json:"reject_total"`
}

var qdbHTTP = &http.Client{Timeout: 30 * time.Second}

// NewQuestDBWriter constructs a writer that ingests over ILP-on-HTTP (the
// /write endpoint). It does not dial: the HTTP client connects lazily on the
// first flush, so a brief QuestDB outage at startup is not fatal.
func NewQuestDBWriter(cfg QuestDBConfig, deviceID string, logger *slog.Logger) (*QuestDBWriter, error) {
	log := logger.With("component", "questdb")

	spoolPath := ""
	if cfg.SpoolDir != "" {
		if err := os.MkdirAll(cfg.SpoolDir, 0o755); err != nil {
			return nil, fmt.Errorf("create spool dir %s: %w", cfg.SpoolDir, err)
		}
		spoolPath = filepath.Join(cfg.SpoolDir, "retry.ilp")
	}

	// Caps come from config (parsed in ParseConfig). Fall back to the built-in
	// defaults when a writer is constructed directly (e.g. tests) without going
	// through ParseConfig, which leaves the parsed fields at their zero value.
	memCap := cfg.parsedMemCap
	if memCap <= 0 {
		memCap = spoolMemCap
	}
	fileCap := cfg.parsedFileCap
	if fileCap <= 0 {
		fileCap = spoolFileCap
	}

	return &QuestDBWriter{
		cfg:      cfg,
		deviceID: deviceID,
		// precision=n → line-protocol timestamps are nanoseconds (UnixNano).
		writeURL:   fmt.Sprintf("http://%s:%d/write?precision=n", cfg.Host, cfg.HTTPPort),
		logger:     log,
		quarantine: make(map[string]map[string]bool),
		pending:    make(map[string]bool),
		health:     make(map[string]*tableHealth),
		nowFn:      time.Now,
		spool:      newRetrySpool(spoolPath, memCap, fileCap, log),
	}, nil
}

// CreateTables executes DDL via QuestDB's HTTP /exec endpoint.
func (q *QuestDBWriter) CreateTables() error {
	for _, ddl := range tableDDL {
		if err := q.execHTTP(ddl); err != nil {
			return fmt.Errorf("DDL failed: %w\n  statement: %s", err, ddl)
		}
	}

	// Materialise pinned columns with their authoritative types. Idempotent
	// (ADD COLUMN IF NOT EXISTS) and recreates any column dropped to fix a type
	// mismatch (e.g. hardware_version/postal_code) with the correct type.
	colDDL := pinnedColumnDDL()
	for _, ddl := range colDDL {
		if err := q.execHTTP(ddl); err != nil {
			return fmt.Errorf("column DDL failed: %w\n  statement: %s", err, ddl)
		}
	}

	// Rollup materialized views, after the base tables + pinned columns they
	// reference. Incrementally maintained by QuestDB from here on.
	for _, ddl := range viewDDL {
		if err := q.execHTTP(ddl); err != nil {
			return fmt.Errorf("view DDL failed: %w\n  statement: %s", err, ddl)
		}
	}

	q.logger.Info("QuestDB tables verified",
		"tables", len(tableDDL), "pinned_columns", len(colDDL), "views", len(viewDDL))
	return nil
}

func (q *QuestDBWriter) execHTTP(query string) error {
	u := fmt.Sprintf("http://%s:%d/exec?query=%s",
		q.cfg.Host, q.cfg.HTTPPort, url.QueryEscape(query))

	resp, err := qdbHTTP.Get(u)
	if err != nil {
		return fmt.Errorf("HTTP request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	return nil
}

// WriteNodeUpdate writes a single node's data to the ILP buffer,
// routing it to the correct table based on nodeID and isDescribed.
func (q *QuestDBWriter) WriteNodeUpdate(nodeID string, props map[string]interface{}, ts time.Time, isDescribed bool) {
	if table, ok := nodeTableMap[nodeID]; ok {
		extras := map[string]string{}
		switch nodeID {
		case "lugs-upstream":
			extras["direction"] = "upstream"
		case "lugs-downstream":
			extras["direction"] = "downstream"
		}
		q.writeRow(table, extras, props, ts)
	} else if isDescribed {
		extras := map[string]string{"circuit_id": nodeID}
		q.writeRow("circuits", extras, props, ts)
	} else {
		q.writeUnknownNode(nodeID, props, ts)
	}
}

// WriteEnergyDeltas writes all energy deltas to the ILP buffer,
// using each delta's own MQTT arrival timestamp.
func (q *QuestDBWriter) WriteEnergyDeltas(deltas []EnergyDelta) {
	for i := range deltas {
		q.writeEnergyDelta(&deltas[i], deltas[i].Timestamp)
	}
}

// Flush POSTs the buffered ILP batch to QuestDB's /write endpoint and clears
// the buffer. Unlike the raw ILP/TCP stream — where one malformed line aborts
// the rest of the batch and drops the connection — the HTTP endpoint commits
// per table: a bad line is rejected (and reported) only for its own table,
// while every other table in the batch still commits. A transport failure
// returns an error and the batch is lost; a data error (non-2xx) is logged with
// QuestDB's message and swallowed so the healthy tables keep flowing.
func (q *QuestDBWriter) Flush() error {
	if q.buf.Len() == 0 && !q.spool.pending() {
		return nil
	}

	// Snapshot and reset the set of tables in this batch so we can attribute
	// the outcome to them below.
	pending := q.pending
	q.pending = make(map[string]bool)

	// Prepend any batches that failed to send during an earlier outage so they
	// replay ahead of the current one. DEDUP makes re-sending idempotent. peek
	// leaves the spool in place — it's only cleared (commit) once QuestDB accepts
	// the payload, so a crash mid-POST can't lose the retained on-disk portion.
	current := append([]byte(nil), q.buf.Bytes()...)
	payload := append(q.spool.peek(), current...)
	q.buf.Reset()
	if len(payload) == 0 {
		return nil
	}

	resp, err := qdbHTTP.Post(q.writeURL, "text/plain; charset=utf-8", bytes.NewReader(payload))
	if err != nil {
		// Transport failure — QuestDB unreachable. The spooled portion is still
		// retained (peek didn't clear it); persist the current batch alongside it
		// so the whole payload survives a crash and replays when QuestDB returns.
		// Per-table health is left untouched (neither committed nor rejected);
		// LastOK ages, which the watchdog and /healthz surface.
		q.spool.enqueue(current)
		return fmt.Errorf("ILP HTTP write to %s: %w (batch queued for retry)", q.writeURL, err)
	}
	defer resp.Body.Close()
	// The request reached QuestDB — a 2xx, or a non-2xx we deliberately don't
	// retry (rejected rows are quarantined below, never re-sent). Either way the
	// peek'd payload is consumed, so clear the spool.
	q.spool.commit()

	rejected := map[string]bool{}
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		text := strings.TrimSpace(string(body))

		// Self-heal: quarantine every column QuestDB named so it is dropped from
		// future flushes, instead of re-sending it forever and rejecting the
		// table's batch every 5s (the failure mode that silently stalled the
		// circuits table for ~36h).
		for _, r := range parseColumnRejections(text) {
			rejected[r.table] = true
			if q.quarantineColumn(r.table, r.column) {
				q.logger.Error("QuestDB rejected a column; quarantining it so the table recovers (drops just this column until restart)",
					"table", r.table, "column", r.column)
			}
		}
		if len(rejected) == 0 {
			// Non-2xx but nothing attributable — surface it, and count every
			// table in the batch as rejected so a persistent unattributable
			// failure still trips the watchdog rather than looking healthy.
			q.logger.Error("QuestDB rejected ILP rows (unattributable)",
				"status", resp.StatusCode, "response", text)
			for t := range pending {
				rejected[t] = true
			}
		}
	}

	q.recordFlush(pending, rejected)
	return nil
}

// recordFlush updates per-table health after a flush: rejected tables advance
// their reject streak, the rest are marked freshly committed.
func (q *QuestDBWriter) recordFlush(pending, rejected map[string]bool) {
	now := q.nowFn()
	q.mu.Lock()
	defer q.mu.Unlock()
	for t := range pending {
		h := q.health[t]
		if h == nil {
			h = &tableHealth{}
			q.health[t] = h
		}
		if rejected[t] {
			h.RejectStreak++
			h.RejectTotal++
		} else {
			h.LastOK = now
			h.RejectStreak = 0
		}
	}
}

// buildRowLine builds an ILP line for a system/circuit node row.
func buildRowLine(table, deviceID string, extraSymbols map[string]string, props map[string]interface{}, ts time.Time) string {
	line := newILP(table)
	line.tag("device_id", deviceID)

	for k, v := range extraSymbols {
		line.tag(k, v)
	}

	// Tags first: string properties designated as SYMBOL
	for prop, val := range props {
		col := propToColumn(prop)
		if !isValidColumnName(col) {
			continue
		}
		if str, ok := val.(string); ok && symbolProps[col] {
			line.tag(col, str)
		}
	}

	// Fields: everything else
	for prop, val := range props {
		col := propToColumn(prop)

		// Backstop: never emit a column QuestDB would reject (e.g. a leaked
		// "relay/set" sub-topic → "relay/"). One invalid name aborts the entire
		// table's batch, so skip it here even if the parser guard missed it.
		if !isValidColumnName(col) {
			continue
		}

		// Symbol strings were already emitted as tags above.
		if _, ok := val.(string); ok && symbolProps[col] {
			continue
		}

		// Pinned columns are encoded as their authoritative type, overriding
		// whatever the panel's $description currently declares.
		if writePinnedField(line, table, col, val) {
			continue
		}

		switch v := val.(type) {
		case float64:
			line.floatF(col, v)
		case int64:
			line.intF(col, v)
		case bool:
			line.boolF(col, v)
		case string:
			line.strF(col, v)
		}
	}

	return line.at(ts)
}

// buildUnknownNodeLine builds an ILP line for an unknown/unrecognised node.
func buildUnknownNodeLine(deviceID, nodeID string, props map[string]interface{}, ts time.Time) (string, error) {
	jsonBytes, err := json.Marshal(props)
	if err != nil {
		return "", fmt.Errorf("marshal unknown node %s: %w", nodeID, err)
	}

	line := newILP("unknown_topics")
	line.tag("device_id", deviceID)
	line.tag("node_id", nodeID)
	line.strF("properties", string(jsonBytes))
	line.intF("property_count", int64(len(props)))

	return line.at(ts), nil
}

// buildEnergyDeltaLine builds an ILP line for a power_usage row.
func buildEnergyDeltaLine(deviceID string, d *EnergyDelta, ts time.Time) string {
	line := newILP("power_usage")
	line.tag("device_id", deviceID)
	line.tag("node_id", d.NodeID)
	line.tag("node_type", d.NodeType)
	line.tag("name", d.Name)
	line.floatF("imported_wh", d.ImportedWh)
	line.floatF("exported_wh", d.ExportedWh)
	line.floatF("period", d.PeriodMs)
	line.floatF("avg_import_w", d.AvgImportW)
	line.floatF("avg_export_w", d.AvgExportW)

	return line.at(ts)
}

func (q *QuestDBWriter) writeRow(table string, extraSymbols map[string]string, props map[string]interface{}, ts time.Time) {
	props = q.dropQuarantined(table, props)
	if s := buildRowLine(table, q.deviceID, extraSymbols, props, ts); s != "" {
		q.buf.WriteString(s)
		q.pending[table] = true
	}
}

func (q *QuestDBWriter) writeUnknownNode(nodeID string, props map[string]interface{}, ts time.Time) {
	s, err := buildUnknownNodeLine(q.deviceID, nodeID, props, ts)
	if err != nil {
		q.logger.Error("failed to marshal unknown node", "node", nodeID, "error", err)
		return
	}
	if s != "" {
		q.buf.WriteString(s)
		q.pending["unknown_topics"] = true
	}
}

func (q *QuestDBWriter) writeEnergyDelta(d *EnergyDelta, ts time.Time) {
	if s := buildEnergyDeltaLine(q.deviceID, d, ts); s != "" {
		q.buf.WriteString(s)
		q.pending["power_usage"] = true
	}
}

// Close flushes any buffered batch so it reaches QuestDB before shutdown, then
// persists anything still awaiting retry to the on-disk spool so a graceful
// restart replays it instead of losing it. Returns the flush error (if any).
func (q *QuestDBWriter) Close() error {
	err := q.Flush()
	if err != nil {
		// QuestDB was unreachable for the final flush; the batch is now in the
		// spool. Don't return yet — persist it below before surfacing the error.
		q.logger.Error("final ILP flush failed; retaining batch for replay on restart", "error", err)
	}
	// Persist any in-memory retry backlog (the just-failed batch plus any earlier
	// outage batches) to disk so it survives this shutdown and replays on restart.
	// A successful flush clears the spool, so this is a no-op in the happy path.
	if q.spool.pending() {
		if n := q.spool.persist(); n > 0 {
			q.logger.Warn("persisted unsent batches to the retry spool for replay on restart", "bytes", n)
		} else if q.cfg.SpoolDir == "" {
			q.logger.Error("unsent batches cannot be persisted (no questdb.spool_dir); they are lost on exit",
				"hint", "set questdb.spool_dir to a mounted volume so a restart mid-outage keeps data")
		}
	}
	return err
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func propToColumn(prop string) string {
	return strings.ReplaceAll(prop, "-", "_")
}

// ---------------------------------------------------------------------------
// Self-heal: quarantine columns QuestDB rejects
// ---------------------------------------------------------------------------

type ilpRejection struct{ table, column string }

var (
	reRejectTable   = regexp.MustCompile(`table:\s*([A-Za-z_][A-Za-z0-9_]*)`)
	reRejectBadName = regexp.MustCompile(`invalid column name:\s*([^\s"]+)`)
	reRejectCastCol = regexp.MustCompile(`column:\s*([A-Za-z_][A-Za-z0-9_]*)`)
)

// parseColumnRejections extracts (table, column) pairs from a QuestDB ILP-HTTP
// error body. QuestDB reports one error per bad line, e.g.
//
//	error in line 1: table: circuits; invalid column name: relay/
//	error in line 2: table: panel_core, column: postal_code; cast error ...
//
// so we split on "error in line" and read the table plus either an invalid
// column name or a cast-error column from each segment.
func parseColumnRejections(body string) []ilpRejection {
	// QuestDB returns JSON whose "message" carries the per-line errors with
	// escaped newlines. Decode it so `\n` becomes real whitespace that the
	// column regexes stop on; fall back to the raw body if it isn't JSON.
	text := body
	var parsed struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err == nil && parsed.Message != "" {
		text = parsed.Message
	}

	var out []ilpRejection
	seen := map[string]bool{}
	for _, seg := range strings.Split(text, "error in line") {
		tm := reRejectTable.FindStringSubmatch(seg)
		if tm == nil {
			continue
		}
		var col string
		if m := reRejectBadName.FindStringSubmatch(seg); m != nil {
			col = m[1]
		} else if m := reRejectCastCol.FindStringSubmatch(seg); m != nil {
			col = m[1]
		}
		if col == "" {
			continue
		}
		key := tm[1] + "\x00" + col
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ilpRejection{table: tm[1], column: col})
	}
	return out
}

// quarantineColumn records table.column as rejected. Returns true if this is
// newly quarantined (so the caller only logs the first time).
func (q *QuestDBWriter) quarantineColumn(table, col string) bool {
	if q.quarantine[table] == nil {
		q.quarantine[table] = map[string]bool{}
	}
	if q.quarantine[table][col] {
		return false
	}
	q.quarantine[table][col] = true
	return true
}

// dropQuarantined returns props without any column QuestDB has rejected for
// this table. Fast path: unchanged when nothing is quarantined for the table.
func (q *QuestDBWriter) dropQuarantined(table string, props map[string]interface{}) map[string]interface{} {
	bad := q.quarantine[table]
	if len(bad) == 0 {
		return props
	}
	out := make(map[string]interface{}, len(props))
	for k, v := range props {
		if columnRejected(propToColumn(k), bad) {
			continue
		}
		out[k] = v
	}
	return out
}

// ---------------------------------------------------------------------------
// Health snapshot (read by the watchdog and /healthz on other goroutines)
// ---------------------------------------------------------------------------

// healthDegradeStreak is the consecutive per-table rejection count at which a
// table is treated as degraded — i.e. it keeps failing even after self-heal. At
// the default 5s flush that is ~1 minute of continuous rejection.
const healthDegradeStreak = 12

// HealthReport is a point-in-time view of writer health, served by /healthz.
type HealthReport struct {
	Healthy bool                   `json:"healthy"`
	Tables  map[string]tableHealth `json:"tables"`
}

// worstStreak returns the table with the highest current reject streak.
func (q *QuestDBWriter) worstStreak() (table string, streak int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for t, h := range q.health {
		if h.RejectStreak > streak {
			streak, table = h.RejectStreak, t
		}
	}
	return table, streak
}

// Health returns a copy of per-table health plus an overall flag that is false
// when any table has been rejecting past the degrade threshold.
func (q *QuestDBWriter) Health() HealthReport {
	q.mu.Lock()
	defer q.mu.Unlock()
	tables := make(map[string]tableHealth, len(q.health))
	healthy := true
	for t, h := range q.health {
		tables[t] = *h
		if h.RejectStreak >= healthDegradeStreak {
			healthy = false
		}
	}
	return HealthReport{Healthy: healthy, Tables: tables}
}

// columnRejected reports whether col matches any quarantined name. A cast-error
// name is a full valid identifier (exact match). An invalid-name is truncated
// by QuestDB at its first invalid char (e.g. "relay/" for our "relay/set"), so
// when a quarantined name ends in a non-identifier char we match by prefix.
func columnRejected(col string, bad map[string]bool) bool {
	if bad[col] {
		return true
	}
	for q := range bad {
		if q == "" {
			continue
		}
		last := q[len(q)-1]
		identChar := last == '_' ||
			(last >= 'a' && last <= 'z') ||
			(last >= 'A' && last <= 'Z') ||
			(last >= '0' && last <= '9')
		if !identChar && strings.HasPrefix(col, q) {
			return true
		}
	}
	return false
}

// isValidColumnName reports whether col is a safe QuestDB/ILP column identifier:
// a leading letter or underscore followed by letters, digits, or underscores.
// Legit Homie properties normalise to this (relay, active_power, l1_voltage);
// leaked command/attribute sub-topics ("relay/set" → "relay/") do not, and must
// be dropped so a single bad name can't reject the whole table's ILP batch.
func isValidColumnName(col string) bool {
	if col == "" {
		return false
	}
	for i, r := range col {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_':
			// always allowed
		case r >= '0' && r <= '9':
			if i == 0 {
				return false // may not start with a digit
			}
		default:
			return false
		}
	}
	return true
}
