package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestWriter(t *testing.T) *QuestDBWriter {
	t.Helper()
	q, err := NewQuestDBWriter(QuestDBConfig{Host: "127.0.0.1", HTTPPort: 9000}, "dev-1", testLogger())
	if err != nil {
		t.Fatal(err)
	}
	return q
}

// recordFlush advances a rejected table's streak and marks the rest fresh.
func TestRecordFlushHealth(t *testing.T) {
	q := newTestWriter(t)

	// Healthy flush of two tables.
	q.recordFlush(map[string]bool{"circuits": true, "power_flows": true}, nil)
	if h := q.Health(); !h.Healthy {
		t.Fatalf("expected healthy, got %+v", h)
	}

	// circuits starts getting rejected; power_flows stays healthy.
	for i := 0; i < healthDegradeStreak; i++ {
		q.recordFlush(map[string]bool{"circuits": true, "power_flows": true},
			map[string]bool{"circuits": true})
	}

	table, streak := q.worstStreak()
	if table != "circuits" || streak != healthDegradeStreak {
		t.Errorf("worstStreak = %q/%d, want circuits/%d", table, streak, healthDegradeStreak)
	}
	rep := q.Health()
	if rep.Healthy {
		t.Error("expected degraded after sustained rejections")
	}
	if rep.Tables["power_flows"].RejectStreak != 0 {
		t.Error("power_flows should remain healthy while circuits is rejected")
	}

	// A subsequent good flush clears the streak (self-heal quarantined the column).
	q.recordFlush(map[string]bool{"circuits": true}, nil)
	if !q.Health().Healthy {
		t.Error("expected recovery after a clean flush")
	}
}

func TestHealthEndpointStatusCodes(t *testing.T) {
	q := newTestWriter(t)
	srv := httptest.NewServer(healthHandler(q))
	defer srv.Close()

	// Healthy → 200.
	q.recordFlush(map[string]bool{"circuits": true}, nil)
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("healthy status = %d, want 200", resp.StatusCode)
	}
	var rep HealthReport
	_ = json.NewDecoder(resp.Body).Decode(&rep)
	resp.Body.Close()
	if !rep.Healthy {
		t.Error("body should report healthy")
	}

	// Degrade circuits → 503.
	for i := 0; i < healthDegradeStreak; i++ {
		q.recordFlush(map[string]bool{"circuits": true}, map[string]bool{"circuits": true})
	}
	resp, err = http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("degraded status = %d, want 503", resp.StatusCode)
	}
	resp.Body.Close()
}
