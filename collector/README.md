# Powerflow Collector

A small, dependency-light Go service that subscribes to a **SPAN smart panel's
MQTT feed** (Homie 5.0 convention), snapshots the panel state, and writes
structured time-series data to **QuestDB**. It is the ingestion half of the
stack: the Powerflow dashboard (this repository's root) reads the QuestDB
tables this collector produces.

> [!NOTE]
> **Meant to run on a private network.** This connects to a panel-local MQTT
> broker and a local QuestDB; it is not hardened for public-internet exposure.
>
> **Written with AI.** This codebase was authored largely with AI assistance
> (Claude Code). It's a personal project — review it before relying on it.

## How it works

```
SPAN panel ──MQTT/TLS (Homie 5.0)──▶ collector ──ILP-over-HTTP──▶ QuestDB ──▶ powerflow
```

1. **Subscribe.** On connect (and every reconnect — the panel rotates its TLS
   cert daily and force-disconnects), the collector subscribes to
   `ebus/5/<panel-serial>/#` and routes every property update into an in-memory
   `State`.
2. **Describe first.** Property updates that arrive before the Homie
   `$description` are buffered and replayed once it loads, so every column's
   QuestDB type is locked from the panel's declared datatype rather than guessed.
3. **Flush.** On a timer (`write_interval`, default 5s) the buffered node
   snapshots are written to QuestDB over ILP-on-HTTP (per-row error isolation),
   and per-circuit energy deltas are computed and written.

### Energy deltas & spike protection

The panel publishes **cumulative** `imported-energy` / `exported-energy`
registers per circuit. The collector turns them into per-interval deltas
(`power_usage` table). Two guards keep a transient bad reading from becoming a
huge fake spike:

- **Baseline preservation.** A reading that goes *backwards* is treated as a
  transient glitch (e.g. a retained `0` republished on reboot) and the baseline
  is **preserved** — it is only rebased once the low value persists across
  several readings (a genuine counter reset). This stops a momentary dip from
  poisoning the baseline and making the recovery reading a lifetime-sized delta.
- **Power ceiling.** Any delta whose implied average power exceeds a plausible
  bound (per-circuit from `breaker-rating`, else a whole-panel fallback) is
  rejected and the baseline rebased, rather than emitted.

## QuestDB schema (compatibility contract)

The Powerflow dashboard (this repository's root) queries these tables.
**Renaming a table/column or changing a pinned type is a breaking change** —
keep them stable.

| Table          | Key columns consumed downstream |
|----------------|---------------------------------|
| `power_flows`  | `device_id, ts, site, grid, pv, battery` |
| `panel_bess`   | `device_id, ts, soc, soe, grid_state, connected` |
| `circuits`     | `device_id, ts, circuit_id, name, active_power, relay, space, breaker_rating, sheddable, always_on` (plus cumulative `imported_energy` / `exported_energy`) |
| `power_usage`  | `device_id, ts, node_id, node_type, name, imported_wh, exported_wh` (`exported_wh` is a circuit's consumption) |
| `panel_core`, `panel_lugs`, `panel_pcs`, `unknown_topics` | additional panel data / diagnostics |

All tables are `PARTITION BY DAY … WAL` with `DEDUP UPSERT KEYS(ts, …)`. A subset
of columns is **type-pinned** in [`columns.go`](./columns.go) so a firmware
change to the panel's declared datatype can't poison a locked QuestDB column.

The collector also creates an **hourly materialized view** `power_flows_1h`
(QuestDB maintains it incrementally). The dashboard reads it for long-range
(week/month/year) charts, scanning a few thousand pre-aggregated rows instead of
millions of raw ones. It stores per-hour averages, sign-split component sums, and
the sample count, so coarser buckets re-aggregate with an exact count-weighted
average.

## Configuration

Config is YAML (default path `/config/config.yml`, optional). It's the **shared
stack config** — the same file the Powerflow web app reads — so the collector
uses the `mqtt` / `span` / `questdb` sections and ignores the web-only
`powerflow` section. See [`config/config.example.yml`](../config/config.example.yml)
at the repository root. Run `span-collector -init` to scaffold a starter file.

If the file is missing the collector runs entirely from built-in defaults plus
`SPAN_*` environment overrides (see below), so it can run with no file at all.

| Key | Meaning |
|-----|---------|
| `mqtt.server` / `port` / `ca_cert` | Panel MQTT broker (TLS when `ca_cert` set) |
| `span.device_id` | Your panel's serial (the MQTT topic segment) |
| `span.readiness_grace` | How long to wait for all of a node's described properties before flushing its first row |
| `questdb.host` / `http_port` | QuestDB (DDL + ILP-on-HTTP ingestion) |
| `questdb.write_interval` | Flush cadence |
| `questdb.spool_dir` | Disk-overflow dir for the retry spool (empty = memory only) |
| `questdb.spool_mem_cap` / `spool_file_cap` | Retry-spool memory / disk caps, binary sizes (default `32MiB` / `256MiB`) |
| `health.port` | Port for `GET /healthz` (0 disables) |
| `health.alert_webhook` | Optional URL POSTed on degrade/recovery (e.g. an `ntfy.sh` topic) |

All keys can also be set via `SPAN_*` environment variables (e.g.
`SPAN_DEVICE_ID`, `SPAN_HEALTH_PORT`), which override the file. Secrets
(`config.yml`, `ca.pem`) are gitignored and never committed.

## Resilience

The collector is built so a single bad message or a QuestDB hiccup can't silently
stop ingestion:

- **Ingress filtering** — command/attribute sub-topics (`.../relay/set`) are
  ignored, both by a narrowed `+/+` subscription and by `parseTopic`; only valid
  single-segment properties become columns.
- **Self-heal** — if QuestDB rejects a column (invalid name, or a type mismatch
  on an unpinned column), the collector quarantines just that column and keeps
  writing the rest of the table, instead of re-sending the poison every flush.
- **Retry spool** — batches that fail to send during a QuestDB outage are
  retained (in memory, overflowing to `questdb.spool_dir` on disk) and replayed
  when it returns, so a restart/blip doesn't lose data. DEDUP makes replay safe.
  A graceful shutdown flushes the in-memory backlog to `spool_dir` too, so a
  restart *during* an outage replays it rather than losing it (needs a
  `spool_dir` on a mounted volume; lower `spool_mem_cap` to persist sooner).
- **Watchdog** — the process exits for a supervisor restart on total MQTT
  silence *or* a table that keeps rejecting writes, so a stall self-recovers.
- **`/healthz`** — reports per-table last-write and rejection streaks (200/503);
  point an uptime monitor at it, or set `health.alert_webhook` for a push.

## Running

The collector runs as part of the full stack from the repository-root
[`compose.yml`](../compose.yml) (QuestDB + collector + web app), pulling the
published image `ghcr.io/andavin/powerflow-collector`:

```bash
docker compose up -d          # from the repository root
```

Configuration is the shared `config/config.yml` and the panel `ca.pem`, mounted
into `/config` (see the root README's Deploy section). To run just the binary
outside Docker, point `-config` at a local file: `go run . -config ./config.yml`.

## Development

```bash
go build ./...
go vet ./...
go test ./...
```

The code is plain Go with only `paho.mqtt.golang` and `yaml.v3` as
dependencies; all SQL/ILP building and parsing is unit-tested.

## License

[Apache 2.0](../LICENSE) — covers this whole repository.
