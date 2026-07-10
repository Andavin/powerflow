package main

import (
	"bytes"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"
)

// testWriter builds a QuestDBWriter pointed at the given base URL's host/port,
// using HTTP for ingestion.
func testWriter(t *testing.T, baseURL string, logger *slog.Logger) *QuestDBWriter {
	t.Helper()
	u, err := url.Parse(baseURL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	host, portStr, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatalf("split host port: %v", err)
	}
	port, _ := strconv.Atoi(portStr)
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	w, err := NewQuestDBWriter(QuestDBConfig{Host: host, HTTPPort: port, ILPPort: port}, "dev-1", logger)
	if err != nil {
		t.Fatalf("NewQuestDBWriter: %v", err)
	}
	return w
}

// Flush must POST the buffered ILP to the /write endpoint and clear the buffer.
func TestQuestDBWriter_FlushPostsILPOverHTTP(t *testing.T) {
	var mu sync.Mutex
	var reqs []string
	var lastPath, lastMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		reqs = append(reqs, string(body))
		lastPath, lastMethod = r.URL.Path, r.Method
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	qw := testWriter(t, srv.URL, nil)
	props := map[string]interface{}{"hardware_version": float64(2), "l1_voltage": 123.4}
	qw.WriteNodeUpdate("core", props, time.Unix(0, 0), true)

	if err := qw.Flush(); err != nil {
		t.Fatalf("Flush returned error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(reqs) != 1 {
		t.Fatalf("expected exactly 1 HTTP request, got %d", len(reqs))
	}
	if lastMethod != http.MethodPost {
		t.Errorf("expected POST, got %s", lastMethod)
	}
	if lastPath != "/write" {
		t.Errorf("expected path /write, got %s", lastPath)
	}
	if !bytes.Contains([]byte(reqs[0]), []byte(`hardware_version="2"`)) {
		t.Errorf("request body missing ILP payload: %q", reqs[0])
	}
}

// An empty buffer must not generate an HTTP request, and Flush must reset the
// buffer so the same rows are never sent twice.
func TestQuestDBWriter_FlushEmptyAndResets(t *testing.T) {
	var mu sync.Mutex
	count := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		count++
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	qw := testWriter(t, srv.URL, nil)

	// Empty flush → no request.
	if err := qw.Flush(); err != nil {
		t.Fatalf("empty Flush error: %v", err)
	}
	// One write, two flushes → exactly one request (buffer reset after first).
	qw.WriteNodeUpdate("core", map[string]interface{}{"l1_voltage": 1.0}, time.Unix(0, 0), true)
	_ = qw.Flush()
	_ = qw.Flush()

	mu.Lock()
	defer mu.Unlock()
	if count != 1 {
		t.Fatalf("expected 1 request total, got %d", count)
	}
}

// A data error (HTTP 4xx) must be surfaced in the logs (per-line feedback) and
// must NOT be escalated as a transport failure — QuestDB isolates the bad table
// and commits the rest, so the writer keeps going.
func TestQuestDBWriter_DataErrorIsLoggedNotFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":"cast error for column hardware_version","line":1}`)
	}))
	defer srv.Close()

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	qw := testWriter(t, srv.URL, logger)

	qw.WriteNodeUpdate("core", map[string]interface{}{"l1_voltage": 1.0}, time.Unix(0, 0), true)
	if err := qw.Flush(); err != nil {
		t.Fatalf("data error should not be returned as a fatal flush error, got: %v", err)
	}
	if !bytes.Contains(logBuf.Bytes(), []byte("hardware_version")) {
		t.Errorf("expected the QuestDB error body to be logged, got: %s", logBuf.String())
	}
}

// The constructor must not require a live server (HTTP client connects lazily),
// so a writer can be created even when QuestDB is briefly unreachable.
func TestNewQuestDBWriter_DoesNotDial(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	// Port 1 is not listening; the old TCP constructor would fail here.
	w, err := NewQuestDBWriter(QuestDBConfig{Host: "127.0.0.1", HTTPPort: 1, ILPPort: 1}, "dev-1", logger)
	if err != nil {
		t.Fatalf("constructor should not dial / fail: %v", err)
	}
	if w == nil {
		t.Fatal("expected a writer")
	}
}
