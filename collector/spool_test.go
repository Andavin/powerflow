package main

import (
	"path/filepath"
	"testing"
)

// Batches survive in memory and drain oldest-first for replay.
func TestRetrySpoolInMemory(t *testing.T) {
	s := newRetrySpool("", spoolMemCap, spoolFileCap, testLogger())
	if s.pending() {
		t.Fatal("new spool should be empty")
	}
	s.enqueue([]byte("a\n"))
	s.enqueue([]byte("b\n"))
	if !s.pending() {
		t.Fatal("spool should have pending batches")
	}
	got := string(s.drain())
	if got != "a\nb\n" {
		t.Errorf("drain = %q, want %q", got, "a\nb\n")
	}
	if s.pending() {
		t.Error("spool should be empty after drain")
	}
}

// When the memory cap is exceeded and a dir is set, oldest batches spill to the
// file and are recovered (disk-first) on drain.
func TestRetrySpoolDiskOverflow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "retry.ilp")
	// Tiny cap so the second batch forces the first to disk.
	s := newRetrySpool(path, 4, spoolFileCap, testLogger())

	s.enqueue([]byte("old\n")) // 4 bytes, fits
	s.enqueue([]byte("new\n")) // pushes total over cap → "old\n" spills to disk

	got := string(s.drain())
	if got != "old\nnew\n" { // disk (old) first, then memory (new)
		t.Errorf("drain = %q, want %q", got, "old\nnew\n")
	}
	if s.pending() {
		t.Error("spool should be empty after drain (memory + file cleared)")
	}
}

// A dropped batch (no dir, cap exceeded) is not retained, but never crashes.
func TestRetrySpoolMemoryCapDropsOldest(t *testing.T) {
	s := newRetrySpool("", 4, spoolFileCap, testLogger())
	s.enqueue([]byte("old\n"))
	s.enqueue([]byte("new\n")) // "old\n" dropped (no disk), "new\n" kept
	if got := string(s.drain()); got != "new\n" {
		t.Errorf("drain = %q, want %q (oldest dropped)", got, "new\n")
	}
}
