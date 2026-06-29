# Powerflow

A fast, real-time energy dashboard for a home power panel, backed by the live
QuestDB feed that `span-stats` ingests. It mirrors the panel app's phone
experience (live flow animation, circuits, stats) and adds a richer desktop
dashboard plus a history workbench with custom timeframes and
period-over-period comparisons.

Built to fix two specific pain points: the stock app's sluggishness, and its
shallow historical views.

## Features

- **Live flow** — animated solar / grid / battery → panel → home diagram driven
  by a Server-Sent Events stream (with a polling fallback).
- **Circuits** — every circuit's live draw, with search and sorting.
- **Stats** — Home / Solar / Battery / Grid over Today / Week / Month / Year:
  generation, consumption, battery charge/discharge with a state-of-charge
  overlay, grid import/export, and a per-circuit breakdown.
- **Desktop dashboard** — multi-panel overview with per-source sparklines.
- **History workbench** — arbitrary date ranges, quick presets, and
  compare-to-previous-period with a percent-change delta.
- **Login** — signed-cookie sessions (the app is meant to be internet-exposed).

## Tech

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4 ·
Recharts · Framer Motion · Vitest · Playwright. No database driver — QuestDB is
queried over its HTTP `/exec` API.

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
to now. All day boundaries use the panel timezone (`America/Denver`).

## Configuration

Copy `.env.example` to `.env.local` and set values:

| Variable                   | Purpose                                             |
| -------------------------- | --------------------------------------------------- |
| `POWERFLOW_DATA_MODE`      | `live` (QuestDB) or `mock` (deterministic fixtures) |
| `QUESTDB_URL`              | QuestDB HTTP endpoint                               |
| `POWERFLOW_TIMEZONE`       | Panel timezone (default `America/Denver`)           |
| `POWERFLOW_DEVICE_ID`      | Scope queries to a device (blank = most recent)     |
| `POWERFLOW_PASSWORD`       | Login password                                      |
| `POWERFLOW_SESSION_SECRET` | Long random string signing sessions                 |
| `POWERFLOW_AUTH_DISABLED`  | `1` to bypass auth (tests / trusted LAN only)       |
| `POWERFLOW_REALTIME`       | `mqtt` (event-driven) or `poll` (QuestDB, default)  |
| `POWERFLOW_MQTT_*`         | Broker URL/credentials/CA when `REALTIME=mqtt`      |

## Real-time transport

Live flow + top consumers reach the browser over SSE (`/api/stream`), fed by a
shared source:

- **`poll`** (default): the server reads QuestDB on a short interval.
- **`mqtt`**: subscribes directly to the panel's MQTT feed — only `power-flows`,
  `bess`, and per-circuit `active_power` — for event-driven updates with no DB
  polling. Circuit names are the one thing still read from QuestDB (rarely).
  Requires `POWERFLOW_DEVICE_ID` and the `POWERFLOW_MQTT_*` settings; mount the
  panel's `ca.pem` and point `POWERFLOW_MQTT_CA_FILE` at it.

Stats and history always query QuestDB (they're historical), on demand.

## Develop

```bash
npm install
npm run dev            # http://localhost:3000

npm test               # Vitest unit tests (no database needed)
npm run test:e2e       # Playwright (boots the app in mock mode)
npm run typecheck
npm run lint
```

Tests never touch the database: unit tests exercise pure logic and a fake
client; Playwright runs the app in `mock` mode.

## Deploy (Docker)

The image is a standalone Next.js server. Join the existing span compose network
so `questdb` resolves:

```bash
export POWERFLOW_PASSWORD='a-strong-password'
export POWERFLOW_SESSION_SECRET="$(openssl rand -hex 32)"
export SPAN_NETWORK=data_span      # the network span-stats' compose created

docker compose up -d --build
```

Put it behind your existing TLS-terminating reverse proxy.

## Layout

```
src/lib/          config, types, time, sql, transform, questdb client, repository, auth
src/app/api/      flow, circuits, stats, circuit-energy, stream (SSE), login, logout
src/app/(main)/   authenticated pages (flow/dashboard, circuits, stats, history)
src/components/   FlowDiagram, charts, screens, AppShell, primitives
e2e/              Playwright specs (mobile + desktop projects)
```
