# Powerflow

A fast, real-time energy dashboard for a home power panel, backed by the panel's
live MQTT feed and the QuestDB history that the bundled [collector](./collector)
ingests. It mirrors the
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
- **Push notifications** — save the app to your phone's home screen and it
  can tell you when grid power goes out (and comes back), when the battery
  runs low, and when the collector stops writing.

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

The whole stack is configured the same way, layered like the collector:

```
built-in defaults  <  config.yml  <  environment variables
```

The primary source is the **shared `config.yml`** (see
[`config/config.example.yml`](./config/config.example.yml)) — the collector
reads its `mqtt` / `span` / `questdb` sections and the web app reads those plus a
web-only `powerflow` section. Environment variables override individual keys, so
you can keep secrets in `.env` or drive everything from the environment with no
file at all. The web app looks for the file at `/config/config.yml` (override
with `POWERFLOW_CONFIG_FILE`).

For **local dev** there's usually no file — put the values in `.env.local`
(loaded by `pnpm dev`). The web app's variables, each of which also overrides the
matching `config.yml` key:

| Variable                    | Overrides / purpose                                      |
| --------------------------- | -------------------------------------------------------- |
| `POWERFLOW_DATA_MODE`       | `live` (QuestDB + MQTT) or `mock` (deterministic fixtures) |
| `QUESTDB_URL`               | QuestDB HTTP endpoint (`/exec`) — else derived from `questdb.host`/`http_port` |
| `POWERFLOW_TIMEZONE`        | Panel timezone (default `America/Denver`)                |
| `POWERFLOW_DEVICE_ID`       | Scope queries to a device (blank = most recent; required for live) |
| `POWERFLOW_PASSWORD`        | Login password                                           |
| `POWERFLOW_SESSION_SECRET`  | Long random string signing sessions (≥ 32 chars)         |
| `POWERFLOW_AUTH_DISABLED`   | `1` to bypass auth (tests / trusted LAN only)            |
| `POWERFLOW_CONTROL_ENABLED` | `1` to enable breaker control; default `0` (read-only)   |
| `POWERFLOW_MQTT_*`          | Broker URL / credentials / CA / topic prefix — else derived from `mqtt.*` |
| `POWERFLOW_VAPID_PUBLIC_KEY` / `POWERFLOW_VAPID_PRIVATE_KEY` | Enables push notifications (`pnpm push:keygen`) |
| `POWERFLOW_VAPID_SUBJECT`   | Sender contact for the push services (default `mailto:admin@example.com`) |
| `POWERFLOW_DATA_DIR`        | Where push subscriptions are stored (default `/data`)    |
| `POWERFLOW_BATTERY_LOW_PERCENT` | SOC that triggers "battery low" (default `20`; `0` disables) |
| `POWERFLOW_STALE_AFTER`     | Stale-data patience before a "collector down" push (default `5m`) |

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

## Push notifications

Save Powerflow to your phone's home screen and it will offer to send
notifications — a card appears after sign-in with a **Turn on** button.
"Maybe later" hides it until the next sign-in. Once on, the card offers **Send a
test** so you can see one arrive before an outage does it for real. Turning
them off again is done in the phone's / browser's notification settings.

What gets sent, all decided by a watcher that runs inside the web app whether
or not a browser is open:

| Event                    | When                                                        |
| ------------------------ | ----------------------------------------------------------- |
| Grid power out / back    | The panel reports it is off-grid (running on the battery), then on-grid again |
| Battery low              | State of charge drops below `battery_low_percent` (default 20%); re-armed once it climbs 5 points clear |
| Collector down / resumed | No new data for `stale_after` (default 5 minutes), or QuestDB unreachable; then data flows again |

Setup: generate a VAPID key pair with `pnpm push:keygen` (or
`npx web-push generate-vapid-keys`) and put it in `config.yml` under
`powerflow.notify` or in `.env`. Subscriptions are stored as a small JSON file
in the `powerflow-data` volume (`/data` in the container).

Two things the browser insists on:

- **HTTPS.** Service workers, and so push, only exist in a secure context —
  plain `http://nas:3007` will never show the card. On a Tailnet, `tailscale
  serve` in front of the app gives you a real certificate with no other setup.
  On a self-signed certificate, Safari will register the worker but Chrome
  refuses outright (it says so in the console), so push can look broken in one
  browser and fine in the other on the same machine.
- **On iPhone, the app must be on the home screen.** Safari tabs have no push;
  the installed app does (iOS 16.4+).

Note that a grid notification can only reach you if the machine running
Powerflow, and your network, stay up during the outage.

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

The repo-root [`compose.yml`](./compose.yml) runs the **full stack** — QuestDB,
the [collector](./collector), and the web app — on one Docker network. Every
image is pulled from a registry; nothing is built locally:

- `ghcr.io/andavin/powerflow` — web app, tagged from `package.json`'s version
  (`.github/workflows/docker-publish.yml`)
- `ghcr.io/andavin/powerflow-collector` — collector, tagged from its Go
  `const version` (`.github/workflows/collector-publish.yml`)
- `questdb/questdb` — upstream image

On this network the web app reaches QuestDB at `http://questdb:9000` and shares
the panel's MQTT credentials + CA with the collector through the single
`config/config.yml`.

### First run

```bash
cp .env.example .env                              # image tags, PANEL_HOST/IP
cp config/config.example.yml config/config.yml    # panel + questdb + app config
#  ...place the panel's MQTT CA at config/ca.pem...
docker compose pull
docker compose up -d
```

`.env` carries compose settings (image tags, host port, `PANEL_HOST`/`PANEL_IP`)
and can override any config key; `config/config.yml` (gitignored) is the actual
configuration for both apps. The collector and web app reach the broker by
hostname so its TLS cert validates — compose maps `PANEL_HOST` (which must match
`mqtt.server` in `config.yml`) to `PANEL_IP` inside the containers via
`extra_hosts`.

> `config/ca.pem` must exist before `up`, or Docker will create a *directory* in
> its place. It's the panel's self-signed MQTT CA; grab it once, e.g.
> `openssl s_client -showcerts -connect "$PANEL_IP:8883" </dev/null` and save the
> CA certificate to `config/ca.pem`.

Both `config/config.yml` and `config/ca.pem` are gitignored;
`config/config.example.yml` is the committed template.

## Layout

This repository holds both halves of the stack:

```
collector/        Go service: subscribes to the panel's MQTT feed and writes
                  the QuestDB tables this app reads. Has its own README, tests,
                  Dockerfile, and CI (.github/workflows/collector-ci.yml).
compose.yml       Full-stack deployment: QuestDB + collector + web app.
config/            Shared stack config mounted into both apps at /config
                  (config.example.yml is the template; real config.yml + ca.pem
                  are gitignored).
```

The rest of the tree is the Powerflow web app:

```
src/lib/          config, types, time, sql, transform, questdb client, repository, auth, period, energy, palette
src/lib/live/     MQTT + mock live sources and the shared snapshot state
src/lib/notify/   push notifications: event wording, watch state machine, subscription store, sender, watcher
src/app/api/      stats, circuit-stats, circuit-energy, circuits/[id]/relay,
                  stream (SSE), freshness, push/*, login, logout, health
src/app/(main)/   authenticated pages (flow/dashboard, circuits, circuit detail, stats)
src/components/   FlowDiagram, charts, screens, AppShell, primitives, PeriodControls
e2e/              Playwright specs (mobile + desktop projects)
public/sw.js      Service worker (push + notification click only; no fetch handler)
```

## License

[Apache 2.0](./LICENSE) — covers the whole repository (web app and collector).
