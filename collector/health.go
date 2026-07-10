package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// startHealthServer serves GET /healthz with the writer's per-table health:
// 200 + JSON when healthy, 503 + JSON when any table is degraded (rejecting past
// the threshold). port <= 0 disables it and returns nil. The self-restart
// watchdog runs independently, so data-loss protection never depends on this.
func startHealthServer(port int, writer *QuestDBWriter, logger *slog.Logger) *http.Server {
	if port <= 0 {
		return nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthHandler(writer))
	srv := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: mux}
	go func() {
		logger.Info("health endpoint listening", "addr", srv.Addr, "path", "/healthz")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("health endpoint failed", "error", err)
		}
	}()
	return srv
}

// healthHandler serves the writer's health report as JSON, 200 when healthy and
// 503 when degraded, so an uptime monitor can alert on the status code alone.
func healthHandler(writer *QuestDBWriter) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		report := writer.Health()
		w.Header().Set("Content-Type", "application/json")
		if !report.Healthy {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(report)
	}
}

var alertHTTP = &http.Client{Timeout: 10 * time.Second}

// postAlert sends a short text alert to webhook (empty = no-op). The format
// (Title header + text body) matches ntfy.sh, so a topic URL there gives a
// zero-config phone push; a plain POST also works for most other receivers.
// Best-effort: failures are logged, never fatal.
func postAlert(webhook, title, body string, logger *slog.Logger) {
	if webhook == "" {
		return
	}
	req, err := http.NewRequest(http.MethodPost, webhook, strings.NewReader(body))
	if err != nil {
		logger.Warn("alert webhook request build failed", "error", err)
		return
	}
	req.Header.Set("Title", title)
	resp, err := alertHTTP.Do(req)
	if err != nil {
		logger.Warn("alert webhook post failed", "error", err)
		return
	}
	resp.Body.Close()
}
