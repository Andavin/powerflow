# Push notifications for the home-screen app

**Date:** 2026-09-11
**Status:** proposed

## Goal

When Powerflow is saved to a phone's home screen, it can raise an OS
notification for the few things worth interrupting someone for, even when the
app is closed:

- **Collector down / data resumed** — the collector stopped writing (or QuestDB
  is unreachable), and later, data is flowing again.
- **Grid down / grid restored** — the panel reports it is off-grid (running on
  the battery), and later, back on grid.
- **Battery low** — state of charge fell below a configurable threshold.

The offer to turn notifications on is an in-page banner, modelled on The Grand
Exchange's `PushPrompt`: a card with a button, never the browser's own prompt on
page load. Dismissing the banner hides it until the next login, when it is
offered again.

## Non-goals

- A settings page. Turning notifications off is done in the OS / browser; the
  only in-app control is the banner and its "send a test" affordance.
- Per-user scoping. Powerflow has one password and one operator; every stored
  subscription is one of the operator's devices.
- In-page toasts for these events. The flow screen already shows grid state and
  SOC live, and the freshness banner already covers "collector down" in-page.
- Offline support / caching in the service worker.

## Why a card and not the browser prompt

1. Safari requires a user gesture for `Notification.requestPermission()`; a
   prompt fired on load is rejected before anyone sees it.
2. A browser-level "deny" is permanent and only reversible from a settings
   page most people never find. The card is the cheap question; only someone
   who presses the button spends the one real ask.

## Architecture

```
                    ┌────────────────────────────────────────────────────┐
 browser            │ Next.js server (Node)                              │
 ─────────          │                                                    │
 NotificationsPrompt│  instrumentation.ts register()                     │
   │ POST subscribe │     └─ startNotifyWatcher()                        │
   ▼                │          ├─ live source (MQTT)  ──► grid / SOC     │
 /api/push/*  ──────┼──►  store (JSON file)                              │
                    │          ├─ freshness SQL (1/min) ──► stale        │
 sw.js  ◄───────────┼──  sender (web-push, VAPID) ◄── watch state machine│
  push event        │                                                    │
                    └────────────────────────────────────────────────────┘
```

One always-on watcher inside the web app. It is the only new long-lived thing;
everything it consumes already exists in-process: the shared MQTT live source
(today started lazily by the first SSE client; the watcher starts it eagerly),
the freshness SQL the banner uses, and the layered config.

Consequence: in `live` mode the web app holds a persistent MQTT connection
from boot, rather than only while a browser is streaming.

## Configuration

New `notify` block under the web-only `powerflow` section of `config.yml`,
each key overridable by an environment variable, following the existing
`pickStr`/`pickBool` precedence (env > file > default):

| config.yml key                        | env var                         | default                   |
| ------------------------------------- | ------------------------------- | ------------------------- |
| `powerflow.notify.vapid_public_key`   | `POWERFLOW_VAPID_PUBLIC_KEY`    | `""` (feature off)        |
| `powerflow.notify.vapid_private_key`  | `POWERFLOW_VAPID_PRIVATE_KEY`   | `""`                      |
| `powerflow.notify.vapid_subject`      | `POWERFLOW_VAPID_SUBJECT`       | `mailto:admin@example.com` |
| `powerflow.notify.data_dir`           | `POWERFLOW_DATA_DIR`            | `/data`                   |
| `powerflow.notify.battery_low_percent`| `POWERFLOW_BATTERY_LOW_PERCENT` | `20` (0 disables)         |
| `powerflow.notify.stale_after`        | `POWERFLOW_STALE_AFTER`         | `5m`                      |

Push is **configured** iff both VAPID keys are non-blank. When not configured:
no banner, `/api/push/config` returns `{ publicKey: null }`, the watcher still
runs its state machine but the sender is a no-op. Nothing throws.

`pnpm push:keygen` prints a fresh VAPID pair in both `config.yml` and `.env`
form. The public key reaches the browser via `GET /api/push/config`, not
`NEXT_PUBLIC_*`: the image is built once and configured per deployment, so a
build-time value would be wrong.

`stale_after` is deliberately longer than the in-page banner's one minute: a
banner that flickers for a minute is harmless; a phone buzzing for a 90-second
hiccup is not.

`compose.yml` gains a `powerflow-data` named volume mounted at `/data` in the
`powerflow` service (overridable to a host path like the QuestDB volume).

## Server modules

All under `src/lib/notify/`.

### `events.ts` — pure vocabulary

```ts
type NotifyEventKind =
  | "DATA_STALE" | "DATA_RESUMED"
  | "GRID_DOWN"  | "GRID_RESTORED"
  | "BATTERY_LOW";

interface PushPayload { title: string; body: string; path: string; tag: string }

function payloadFor(event: NotifyEvent): PushPayload
```

Wording lives here only. Tags collapse related notifications on the lock
screen: `DATA_STALE`/`DATA_RESUMED` share tag `data`, `GRID_*` share `grid`,
`BATTERY_LOW` uses `battery`, the test notification uses `test`. `path` is
always same-origin (`/` for grid/battery, `/` for data).

### `watch.ts` — pure state machine

```ts
interface WatchState { /* primed flags + last-known values */ }
function observeSnapshot(state, snapshot: FlowSnapshot, now): NotifyEvent[]
function observeFreshness(state, result: FreshnessResult, now, staleAfterMs): NotifyEvent[]
```

Edge-triggered with hysteresis, and **primed by the first observation** so a
restart during an outage does not re-announce it:

- **Grid:** `gridState` is off-grid when it is non-null and does not contain
  `ON_GRID` (SPAN reports e.g. `PANEL_ON_GRID` / `PANEL_OFF_GRID`; the exact
  strings are matched case-insensitively on the `ON_GRID` substring so an
  unknown variant errs toward "off-grid" only if it clearly isn't on-grid —
  null/unknown never fires). `GRID_DOWN` once on the on→off transition,
  `GRID_RESTORED` once on off→on.
- **Battery:** `BATTERY_LOW` when SOC crosses from `>= threshold` to
  `< threshold`. Re-arms only once SOC climbs back to `>= threshold + 5`, so a
  battery hovering at the line does not nag. Threshold `0` disables.
- **Data:** the freshness result is observed once a minute. `DATA_STALE` fires
  when `stale` has been continuously true for at least `stale_after` (measured
  from the first stale observation), once. `DATA_RESUMED` fires once when a
  subsequent result is not stale, only if `DATA_STALE` had fired. In `mock`
  mode freshness is never stale.

All of this is a pure function of `(state, input, now)` and is unit-tested with
fake time. `mock` data mode runs the watcher against the mock source, so the
wiring is exercised in CI, not just the pure parts.

### `store.ts` — subscriptions on disk

`<data_dir>/push-subscriptions.json`: an array of
`{ endpoint, p256dh, auth, createdAt }`, keyed on `endpoint` (upsert replaces
keys for an existing endpoint). Writes are atomic (write `.tmp`, rename). A
missing file is an empty list; an unreadable/corrupt file is logged and
treated as empty rather than crashing the server. `data_dir` is created on
first write.

### `push.ts` — sender

`sendToAll(payload): Promise<number>` — `web-push` is imported lazily and
VAPID details set immediately before each send. Fans out with
`Promise.allSettled`. A `404`/`410` from the push service deletes that
subscription (the browser is gone). Other failures are logged with the status
code. Never throws — a caller in the watcher loop must not die because a
phone was wiped.

### `watcher.ts` — the runner

`startNotifyWatcher()` is idempotent (module-level guard). It:

1. Reads config; if data mode is `live` and MQTT isn't configured, logs and
   returns (same condition that makes `/api/stream` 503).
2. `getLiveSource().ensureStarted()` and subscribes; each snapshot goes through
   `observeSnapshot`.
3. Every 60s runs the freshness check (a shared function extracted from
   `/api/freshness` so the route and the watcher can't drift) through
   `observeFreshness`.
4. For each emitted event, `sendToAll(payloadFor(event))`.

Started from `src/instrumentation.ts` `register()` guarded to the Node.js
runtime (`process.env.NEXT_RUNTIME === "nodejs"`). It must not start during
`next build`.

## Routes

All under the existing auth proxy (nothing is added to `PUBLIC_PATHS`).

| Route                       | Body / response                                            |
| --------------------------- | ---------------------------------------------------------- |
| `GET  /api/push/config`     | `{ publicKey: string \| null }`                            |
| `POST /api/push/subscribe`  | `{ endpoint, p256dh, auth }` → `{ ok: true }`; 400 on bad shape |
| `DELETE /api/push/subscribe`| `{ endpoint }` → `{ ok: true }`                            |
| `POST /api/push/test`       | sends the test payload to every subscription; `{ ok, sent }` — `sent: 0` is reported as a failure the UI can explain |

Validation: `endpoint` must be an `https:` URL; `p256dh`/`auth` non-empty
strings. The server will later make requests to `endpoint`, so it is not
accepted blindly.

## Browser side

- **`src/app/manifest.ts`** — `id: "/"`, `name: "Powerflow"`, `start_url: "/"`,
  `display: "standalone"`, `background_color`/`theme_color: "#050608"` (the
  existing `viewport.themeColor`), icons 192/512 (PNG, derived from the
  existing icon) plus a maskable 512. The proxy matcher already excludes
  `manifest.webmanifest`.
- **`layout.tsx`** — `metadata.appleWebApp = { capable: true, title: "Powerflow", statusBarStyle: "black-translucent" }`
  so iOS treats the home-screen save as a web app; iOS only delivers push to
  installed web apps.
- **`public/sw.js`** — `install`→`skipWaiting`, `activate`→`clients.claim`,
  `push`→`showNotification` (always shows *something*, even on malformed
  data, because a push with no notification costs the permission), and
  `notificationclick`→focus an existing window on the path, else navigate an
  open one, else `openWindow`. **No `fetch` handler.** The proxy matcher must
  exclude `sw.js` so the worker script itself is fetchable without a session
  (the worker fetches it outside the page's context on update checks).
- **`src/lib/client/push.ts`** — port of TGE's `push-client.ts`:
  `canOfferPush()`, `alreadyAnswered()`, `decodeKey()`, `enablePush(publicKey, save)`.
- **`src/components/NotificationsPrompt.tsx`** — rendered in `AppShell` below
  `DataFreshnessBanner`. Visible when *all* of: `canOfferPush()`, the server
  returned a public key, `Notification.permission === "default"`, and
  `localStorage["powerflow-push-dismissed"]` is unset. Appears after a short
  delay so it doesn't land in the same frame as the page.
  - **Maybe later:** sets the dismissed flag, hides.
  - **Turn on:** `enablePush` → `POST /api/push/subscribe`. On success the card
    stays for this session as "Notifications are on · Send a test", where the
    test button calls `POST /api/push/test` and reports the result inline.
    On denied/dismissed-by-browser: hide (nothing more can be asked). On
    failure: show one sentence ("Couldn't turn on notifications here") and
    keep the card so it can be retried.
  - **Ask again each login:** the login form removes the dismissed flag on a
    successful sign-in. The flag itself is in `localStorage` (not
    `sessionStorage`), because a home-screen app being backgrounded and
    reopened is not a new login.
  - **Self-healing subscription:** on mount, if permission is already
    `granted` and push is configured, silently re-run subscribe + save. This
    is idempotent server-side and repairs a wiped data volume without anyone
    noticing.
- Push requires a secure context. On plain `http://nas:3007` nothing is
  offered (`canOfferPush()` is false) — the README explains the HTTPS
  requirement (Tailscale `serve` or a real certificate) and the Chrome vs
  Safari behaviour on self-signed certificates.

## Error handling summary

| Failure                                  | Behaviour                                                  |
| ---------------------------------------- | ---------------------------------------------------------- |
| VAPID keys missing                       | Feature off; no banner; watcher sends nothing; no errors   |
| Subscriptions file unreadable            | Logged; treated as empty                                   |
| Push service 404/410                     | Subscription deleted                                       |
| Push service other error (e.g. 403 bad key) | Logged with status; other subscriptions still sent      |
| MQTT unconfigured in live mode           | Watcher logs and does not start; routes still work         |
| QuestDB unreachable                      | Counts as stale (same as the banner)                       |
| Browser permission denied                | Card hides; never asked again by this app                  |
| Insecure context                         | Card never shown                                           |

## Testing

- **Unit (vitest):** `events` wording/tags; `watch` state machine (priming,
  each transition, hysteresis, stale timing, disabled threshold); `store`
  (upsert, delete, missing/corrupt file, atomic write) against a temp dir;
  `push` sender with `web-push` mocked (fan-out, 410 pruning, no-throw);
  `config` parsing for the new keys; `NotificationsPrompt` with a stubbed
  `Notification`/`PushManager` (shows/hides on each condition, dismiss,
  turn-on flow, test button).
- **E2E (Playwright, mock mode):** with a fake public key in the env, the
  banner appears after login, "Maybe later" hides it, a reload keeps it
  hidden, logging out and back in shows it again. `sw.js` and
  `manifest.webmanifest` are fetchable without a session.
- **Manual:** real iPhone via Tailscale HTTPS; "send a test" arrives on the
  lock screen; pull the collector container → "collector down" within
  `stale_after`; restart → "data resumed".

## Files

New: `src/instrumentation.ts`, `src/lib/notify/{events,watch,store,push,watcher}.ts` (+ tests),
`src/lib/freshness.ts` (extracted from the route), `src/app/api/push/{config,subscribe,test}/route.ts`,
`src/app/manifest.ts`, `public/sw.js`, `public/icon-{192,512,maskable-512}.png`,
`src/lib/client/push.ts`, `src/components/NotificationsPrompt.tsx` (+ test),
`scripts/push-keygen.mjs`, `e2e/notifications.spec.ts`.

Modified: `src/lib/config.ts` (+ `notify` block), `src/app/api/freshness/route.ts`,
`src/proxy.ts` (matcher excludes `sw.js`), `src/app/layout.tsx`, `src/components/AppShell.tsx`,
`src/app/login/page.tsx`, `package.json` (`web-push`, `@types/web-push`, `push:keygen`),
`compose.yml`, `config/config.example.yml`, `.env.example`, `README.md`.

## Open questions

None blocking. The exact `grid_state` strings SPAN publishes should be
confirmed against a real panel during manual testing; the matcher is written
so an unfamiliar on-grid spelling can be added in one place.
