# span-stats

A small, dependency-light Go service that subscribes to a **SPAN smart panel's
MQTT feed** (Homie 5.0 convention), snapshots the panel state, and writes
structured time-series data to **QuestDB**. It is the ingestion half of a pair:
the [`powerflow`](https://github.com/Andavin/powerflow) dashboard reads the
QuestDB tables this collector produces.

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

The [`powerflow`](https://github.com/Andavin/powerflow) dashboard queries these
tables. **Renaming a table/column or changing a pinned type is a breaking
change** — keep them stable.

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

## Configuration

Config is YAML (default path `/config/config.yml`). If it doesn't exist the
collector writes a template and exits so you can edit it. See
[`config/config.example.yml`](./config/config.example.yml).

| Key | Meaning |
|-----|---------|
| `mqtt.server` / `port` / `ca_cert` | Panel MQTT broker (TLS when `ca_cert` set) |
| `span.device_id` | Your panel's serial (the MQTT topic segment) |
| `span.readiness_grace` | How long to wait for all of a node's described properties before flushing its first row |
| `questdb.host` / `http_port` | QuestDB (DDL + ILP-on-HTTP ingestion) |
| `questdb.write_interval` | Flush cadence |
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
- **Watchdog** — the process exits for a supervisor restart on total MQTT
  silence *or* a table that keeps rejecting writes, so a stall self-recovers.
- **`/healthz`** — reports per-table last-write and rejection streaks (200/503);
  point an uptime monitor at it, or set `health.alert_webhook` for a push.

## Running

```bash
docker compose up -d          # starts QuestDB + the collector
```

Mount your real `config.yml` and `ca.pem` into `/config` (see `compose.yml`).

## Development

```bash
go build ./...
go vet ./...
go test ./...
```

The code is plain Go with only `paho.mqtt.golang` and `yaml.v3` as
dependencies; all SQL/ILP building and parsing is unit-tested.

## License

[MIT](./LICENSE)
