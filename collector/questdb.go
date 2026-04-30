package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
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

// ---------------------------------------------------------------------------
// ILP line builder — InfluxDB Line Protocol over raw TCP
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
	conn     net.Conn
	buf      *bufio.Writer
	cfg      QuestDBConfig
	deviceID string
	logger   *slog.Logger
}

var qdbHTTP = &http.Client{Timeout: 30 * time.Second}

func NewQuestDBWriter(cfg QuestDBConfig, deviceID string, logger *slog.Logger) (*QuestDBWriter, error) {
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.ILPPort)
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect ILP at %s: %w", addr, err)
	}

	return &QuestDBWriter{
		conn:     conn,
		buf:      bufio.NewWriterSize(conn, 64*1024),
		cfg:      cfg,
		deviceID: deviceID,
		logger:   logger.With("component", "questdb"),
	}, nil
}

// CreateTables executes DDL via QuestDB's HTTP /exec endpoint.
func (q *QuestDBWriter) CreateTables() error {
	for _, ddl := range tableDDL {
		if err := q.execHTTP(ddl); err != nil {
			return fmt.Errorf("DDL failed: %w\n  statement: %s", err, ddl)
		}
	}
	q.logger.Info("QuestDB tables verified", "count", len(tableDDL))
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

// Flush writes the ILP buffer to QuestDB, reconnecting on failure.
func (q *QuestDBWriter) Flush() error {
	if err := q.buf.Flush(); err != nil {
		q.logger.Warn("ILP flush failed, reconnecting", "error", err)
		if rErr := q.reconnect(); rErr != nil {
			return fmt.Errorf("ILP flush: %w (reconnect: %v)", err, rErr)
		}
		return fmt.Errorf("ILP flush: %w (reconnected, batch lost)", err)
	}
	return nil
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
		if str, ok := val.(string); ok && symbolProps[col] {
			line.tag(col, str)
		}
	}

	// Fields: everything else
	for prop, val := range props {
		col := propToColumn(prop)
		switch v := val.(type) {
		case float64:
			line.floatF(col, v)
		case int64:
			line.intF(col, v)
		case bool:
			line.boolF(col, v)
		case string:
			if !symbolProps[col] {
				line.strF(col, v)
			}
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
	if s := buildRowLine(table, q.deviceID, extraSymbols, props, ts); s != "" {
		q.buf.WriteString(s)
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
	}
}

func (q *QuestDBWriter) writeEnergyDelta(d *EnergyDelta, ts time.Time) {
	if s := buildEnergyDeltaLine(q.deviceID, d, ts); s != "" {
		q.buf.WriteString(s)
	}
}

func (q *QuestDBWriter) reconnect() error {
	if q.conn != nil {
		q.conn.Close()
	}
	addr := fmt.Sprintf("%s:%d", q.cfg.Host, q.cfg.ILPPort)
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return fmt.Errorf("reconnect ILP at %s: %w", addr, err)
	}
	q.conn = conn
	q.buf.Reset(conn)
	q.logger.Info("ILP reconnected", "addr", addr)
	return nil
}

func (q *QuestDBWriter) Close() error {
	// Flush before closing so any buffered batch reaches QuestDB. A failure
	// here means data is lost (the connection is about to drop), so log it
	// loudly rather than silently swallowing the error.
	if err := q.buf.Flush(); err != nil {
		q.logger.Error("final ILP flush failed; buffered batch lost", "error", err)
	}
	return q.conn.Close()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func propToColumn(prop string) string {
	return strings.ReplaceAll(prop, "-", "_")
}
