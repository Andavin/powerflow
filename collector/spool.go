package main

import (
	"log/slog"
	"os"
	"sync"
)

const (
	spoolMemCap  = 32 << 20  // 32 MiB kept in memory before spilling to disk
	spoolFileCap = 256 << 20 // 256 MiB on-disk overflow cap
)

// retrySpool retains ILP batches that failed to send because QuestDB was
// unreachable (a transport failure, where the whole batch is lost), so they can
// be replayed when it returns instead of being dropped. Recent batches stay in
// memory; once the in-memory total exceeds memCap the oldest spill to a single
// append-only file (when a dir is configured), itself capped so a long outage
// can't fill the disk. QuestDB's DEDUP UPSERT KEYS make replay idempotent, so
// re-sending a batch that partially landed is safe.
//
// A QuestDB dead-letter *table* was considered and rejected: the failure this
// guards against is "QuestDB unavailable", so only local durability survives it.
type retrySpool struct {
	mu      sync.Mutex
	batches [][]byte // in-memory FIFO of pending batches
	memSize int
	memCap  int
	path    string // append file for overflow; "" disables disk overflow
	fileCap int
	logger  *slog.Logger
}

func newRetrySpool(path string, memCap, fileCap int, logger *slog.Logger) *retrySpool {
	return &retrySpool{memCap: memCap, path: path, fileCap: fileCap, logger: logger}
}

// enqueue retains a failed batch for later replay, spilling oldest in-memory
// batches to disk (or dropping them, logged) when the memory cap is exceeded.
func (s *retrySpool) enqueue(batch []byte) {
	if len(batch) == 0 {
		return
	}
	b := append([]byte(nil), batch...)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.batches = append(s.batches, b)
	s.memSize += len(b)
	for s.memSize > s.memCap && len(s.batches) > 1 {
		oldest := s.batches[0]
		s.batches = s.batches[1:]
		s.memSize -= len(oldest)
		s.spillToDisk(oldest)
	}
}

// spillToDisk appends a batch to the overflow file, honoring the file cap, and
// returns the bytes written (0 if the batch was dropped). Must hold s.mu. Loss
// (disk disabled or file full) is logged, never silent.
func (s *retrySpool) spillToDisk(batch []byte) int {
	if s.path == "" {
		s.logger.Warn("retry buffer full and no spool dir; dropping oldest batch", "bytes", len(batch))
		return 0
	}
	if fi, err := os.Stat(s.path); err == nil && int(fi.Size())+len(batch) > s.fileCap {
		s.logger.Warn("retry spool file full; dropping oldest batch", "bytes", len(batch), "file", s.path)
		return 0
	}
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		s.logger.Warn("cannot open retry spool file; dropping oldest batch", "error", err)
		return 0
	}
	defer f.Close()
	if _, err := f.Write(batch); err != nil {
		s.logger.Warn("cannot write retry spool file; dropping oldest batch", "error", err)
		return 0
	}
	return len(batch)
}

// persist flushes all in-memory batches to the on-disk overflow file so a
// graceful shutdown during a QuestDB outage doesn't lose them: on the next start
// peek() replays them from disk. Returns the bytes actually written to disk (0
// when disk overflow is disabled or nothing is buffered). Honors the file cap
// via spillToDisk, which logs any drop. When disk overflow is disabled the
// in-memory batches are left untouched (nothing durable we can do).
func (s *retrySpool) persist() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" || len(s.batches) == 0 {
		return 0
	}
	n := 0
	for _, b := range s.batches {
		n += s.spillToDisk(b)
	}
	s.batches = nil
	s.memSize = 0
	return n
}

// peek returns every pending batch (disk first, then memory, oldest-first)
// concatenated for a single replay POST, WITHOUT clearing the spool. The on-disk
// overflow stays in place until commit(), so a crash mid-replay can't lose the
// durable portion. (Draining before the POST was confirmed used to pull the
// on-disk batches into memory for the whole outage, defeating the spool.)
func (s *retrySpool) peek() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()

	var out []byte
	if s.path != "" {
		if data, err := os.ReadFile(s.path); err == nil && len(data) > 0 {
			out = append(out, data...)
		}
	}
	for _, b := range s.batches {
		out = append(out, b...)
	}
	return out
}

// commit clears the spool once a peek()'d payload has been accepted by QuestDB:
// it removes the on-disk overflow and drops the in-memory FIFO.
func (s *retrySpool) commit() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path != "" {
		os.Remove(s.path)
	}
	s.batches = nil
	s.memSize = 0
}

// drain is peek+commit in one call: it returns the pending payload and clears
// the spool unconditionally. Used where the payload is always consumed (tests).
func (s *retrySpool) drain() []byte {
	out := s.peek()
	s.commit()
	return out
}

// pending reports whether any batches are awaiting replay (memory or disk).
func (s *retrySpool) pending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.batches) > 0 {
		return true
	}
	if s.path != "" {
		if fi, err := os.Stat(s.path); err == nil && fi.Size() > 0 {
			return true
		}
	}
	return false
}
