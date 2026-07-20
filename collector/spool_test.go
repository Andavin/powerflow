package main

import (
	"os"
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

// peek must return the pending payload WITHOUT clearing the spool or deleting
// the on-disk overflow — the durability fix. Only commit() clears it. (The old
// drain-before-replay deleted the file up front, so a crash mid-replay lost the
// disk-resident data for the whole outage.)
func TestRetrySpoolPeekKeepsDiskUntilCommit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "retry.ilp")
	s := newRetrySpool(path, 4, spoolFileCap, testLogger()) // tiny cap → spill to disk
	s.enqueue([]byte("old\n"))                              // 4 bytes, fits
	s.enqueue([]byte("new\n"))                              // pushes over cap → "old\n" spills to disk

	if got := string(s.peek()); got != "old\nnew\n" {
		t.Fatalf("peek = %q, want %q", got, "old\nnew\n")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("disk spool must survive peek: %v", err)
	}
	if !s.pending() {
		t.Fatal("peek must not clear the spool")
	}
	// Idempotent: a second peek still sees everything.
	if got := string(s.peek()); got != "old\nnew\n" {
		t.Fatalf("second peek = %q, want %q", got, "old\nnew\n")
	}

	s.commit()
	if s.pending() {
		t.Error("commit must clear the spool")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("commit must remove the disk spool file, stat err = %v", err)
	}
}

// persist must write the in-memory backlog to disk so a fresh spool over the
// same path replays it — the graceful-shutdown-during-outage durability
// guarantee. Uses a normal (large) mem cap: nothing spills on its own, so this
// isolates persist() rather than the enqueue overflow path.
func TestRetrySpoolPersistToDisk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "retry.ilp")
	s := newRetrySpool(path, spoolMemCap, spoolFileCap, testLogger())
	s.enqueue([]byte("a\n"))
	s.enqueue([]byte("b\n"))

	// Under the mem cap: nothing on disk yet.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected no disk file before persist, stat err = %v", err)
	}
	if n := s.persist(); n != 4 {
		t.Errorf("persist wrote %d bytes, want 4", n)
	}

	// A brand-new spool over the same path must recover the batches from disk.
	s2 := newRetrySpool(path, spoolMemCap, spoolFileCap, testLogger())
	if !s2.pending() {
		t.Fatal("persisted batches must be pending for a fresh spool")
	}
	if got := string(s2.peek()); got != "a\nb\n" {
		t.Errorf("recovered payload = %q, want %q", got, "a\nb\n")
	}
}

// persist is a no-op that keeps the memory backlog when disk overflow is
// disabled (no dir): there's nothing durable to do, but it must not drop data
// or panic.
func TestRetrySpoolPersistNoDir(t *testing.T) {
	s := newRetrySpool("", spoolMemCap, spoolFileCap, testLogger())
	s.enqueue([]byte("x\n"))
	if n := s.persist(); n != 0 {
		t.Errorf("persist with no dir wrote %d bytes, want 0", n)
	}
	if !s.pending() {
		t.Error("batch should remain pending in memory when there's no spool dir")
	}
}
