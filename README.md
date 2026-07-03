# Powerflow

A fast, real-time energy dashboard for a home power panel, backed by the panel's
live MQTT feed and the QuestDB history that `span-stats` ingests. It mirrors the
panel app's phone experience (live flow animation, circuits, stats) and adds a
richer desktop dashboard plus custom timeframes and period-over-period
comparisons.

Built to fix two specific pain points: the stock app's sluggishness, and its
shallow historical views.

> [!NOTE]
> **Meant to run on a private network.** Powerflow is designed to sit on a
> trusted LAN or private overlay (e.g. Tailscale), reachable only by its
> operator's own devices — it is not hardened for direct exposure to the public
> internet. It still requires a login, but treat that as defence-in-depth, not a
> perimeter.
>
> **Written with AI.** This codebase was authored largely with AI assistance
> (Claude Code). It's a personal project; review it yourself before relying on
> it.

## Features

- **Live flow** — animated solar / grid / battery → panel → home diagram driven
  by a Server-Sent Events stream.
- **Circuits** — every circuit's live draw, with search and sorting, plus an
  optional breaker control (turn a circuit on/off) gated behind a config flag.
- **Stats** — Home / Solar / Battery / Grid over Today / Week / Month / Year or
  an arbitrary custom range, with compare-to-previous-period and a percent-change
  delta: generation, consumption, battery charge/discharge with a
  state-of-charge overlay, grid import/export, and a per-circuit breakdown.
- **Desktop dashboard** — multi-panel overview for large screens.
- **Login** — signed-cookie sessions.

## Tech

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4 ·
Recharts · SWR · Vitest · Playwright. No database driver — QuestDB is queried
over its HTTP `/exec` API; the live feed uses `mqtt.js`.

## Data model

QuestDB stores raw signed values; the app normalises them (see
`src/lib/transform.ts`) so that **home = solar + grid + battery**:

| Domain        | Source                  | Sign convention                         |
| ------------- | ----------------------- | --------------------------------------- |
| `solarW`      | `power_flows.pv`        | production = `-pv` (≥ 0)                |
| `gridW`       | `power_flows.grid`      | `+` import / `-` export (`-grid`)       |
| `batteryW`    | `power_flows.battery`   | `+` discharge / `-` charge (`-battery`) |
| `homeW`       | `power_flows.site`      | load (≥ 0)                              |
| circuit watts | `circuits.active_power` | consumption = `-active_power`           |

Energy (kWh) is the time-integral of average power per timezone-aligned bucket
(`SAMPLE BY … ALIGN TO CALENDAR TIME ZONE`), with the in-progress bucket clipped
to now. All day boundaries use the panel timezone (default `America/Denver`).

## Configuration

Copy `.env.example` to `.env.local` and set values:

| Variable                    | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `POWERFLOW_DATA_MODE`       | `live` (QuestDB + MQTT) or `mock` (deterministic fixtures) |
| `QUESTDB_URL`               | QuestDB HTTP endpoint (`/exec`)                          |
| `POWERFLOW_TIMEZONE`        | Panel timezone (default `America/Denver`)                |
| `POWERFLOW_DEVICE_ID`       | Scope queries to a device (blank = most recent; required for live) |
| `POWERFLOW_PASSWORD`        | Login password                                           |
| `POWERFLOW_SESSION_SECRET`  | Long random string signing sessions (≥ 32 chars)         |
| `POWERFLOW_AUTH_DISABLED`   | `1` to bypass auth (tests / trusted LAN only)            |
| `POWERFLOW_CONTROL_ENABLED` | `1` to enable breaker control; default `0` (read-only)   |
| `POWERFLOW_MQTT_*`          | Broker URL / credentials / CA / topic prefix for the live feed |

## Real-time transport

The live feed — flow, top consumers, and the full circuit list — reaches the
browser over a single SSE stream (`/api/stream`), fed directly by the panel's
**MQTT**. There is no QuestDB polling on the live path: the server subscribes
only to `power-flows`, `bess`, and per-circuit `active_power`/`relay`, and folds
them into a coalesced snapshot. Circuit names/metadata are the one thing read
from QuestDB, and only rarely.

Live data mode therefore **requires MQTT**: set `POWERFLOW_MQTT_URL` and
`POWERFLOW_DEVICE_ID`, and mount the panel's `ca.pem` (point
`POWERFLOW_MQTT_CA_FILE` at it). If MQTT isn't configured in live mode the
stream endpoint returns 503. `mock` data mode uses a deterministic in-memory
source instead (tests / demos) and needs no broker or database.

Stats and history always query QuestDB (they're historical), on demand.

Breaker control, when enabled, publishes a relay command over the same MQTT
connection; even then only circuits SPAN marks settable and not always-on can be
toggled.

## Develop

This project uses **pnpm** (pinned via `package.json`'s `packageManager`; run
`corepack enable` once to get it).

```bash
pnpm install
pnpm dev               # http://localhost:3000

pnpm test              # Vitest unit tests (no database needed)
pnpm test:e2e          # Playwright (boots the app in mock mode)
pnpm typecheck
pnpm lint
```

Tests never touch the database or a broker: unit tests exercise pure logic and a
fake client; Playwright runs the app in `mock` mode.

## Deploy (Docker)

CI publishes a multi-arch image to **`ghcr.io/andavin/powerflow`** (tagged from
`package.json`'s version — see `.github/workflows/docker-publish.yml`). You run
that image rather than building locally.

### As part of the span stack (recommended)

Powerflow is designed to sit alongside the `span-collector` and `questdb`
services in the parent `span-stats` compose, on one Docker network. That lets it
reach QuestDB directly at `http://questdb:9000` (no host gateway) and share the
panel's MQTT credentials + CA with the collector. A **single `.env`** is the
source of truth for the whole stack:

```dotenv
# Images
POWERFLOW_TAG=0.1.0            # pin a release; QUESTDB_TAG likewise
# Panel + MQTT (shared by collector and Powerflow)
PANEL_HOST=span-...-.local
PANEL_IP=192.168.0.212
DEVICE_ID=nj-...
MQTT_USERNAME=...
MQTT_PASSWORD=...
MQTT_TOPIC_PREFIX=ebus/5
# Powerflow auth
POWERFLOW_PASSWORD=...
POWERFLOW_SESSION_SECRET=...   # openssl rand -hex 32
POWERFLOW_PORT=3007            # host port (-> container :3000)
```

The Powerflow service in that compose enables auth (`POWERFLOW_AUTH_DISABLED=0`)
and breaker control (`POWERFLOW_CONTROL_ENABLED=1`), points
`QUESTDB_URL` at `http://questdb:9000`, and mounts the panel CA read-only at
`/config/ca.pem` (the same `ca.pem` the collector uses — fetch it once with the
collector's `fetch-ca.sh`). Bring the stack up with:

```bash
cp .env.example .env          # fill in the secrets
./collector/fetch-ca.sh       # grab the panel's MQTT CA (once)
docker compose pull           # Powerflow image from GHCR
docker compose up -d --build  # --build compiles the local collector
```

> The CA `ca.pem` must exist before `up`, or Docker will create a *directory*
> in its place. `fetch-ca.sh` writes it for you.

### Standalone

Powerflow can also run on its own with the bundled `compose.yml`; set
`QUESTDB_URL` and the `POWERFLOW_MQTT_*` values in `.env` yourself. Either way,
reach it over your private network / Tailnet and put it behind a
TLS-terminating reverse proxy if you want HTTPS.

## Layout

```
src/lib/          config, types, time, sql, transform, questdb client, repository, auth, period, energy, palette
src/lib/live/     MQTT + mock live sources and the shared snapshot state
src/app/api/      stats, circuit-stats, circuit-energy, circuits/[id]/relay,
                  stream (SSE), login, logout, health
src/app/(main)/   authenticated pages (flow/dashboard, circuits, circuit detail, stats)
src/components/   FlowDiagram, charts, screens, AppShell, primitives, PeriodControls
e2e/              Playwright specs (mobile + desktop projects)
```
