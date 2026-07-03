# Findings: per-circuit energy spike (lifetime-cumulative emitted as one delta)

Investigated 2026-07-01 from the web app side. Root cause is in this collector
(`data/energy.go`). Writing it up here so a future session can fix it and clean
the polluted data. **No web-app guard was added** — the fix belongs here.

## Symptom

The web app showed impossible per-circuit energy for "today": Fridge **423 kWh**,
EV Charger 3917 kWh, Heat Pump 5568 kWh, etc. Home/solar/battery/grid totals were
fine (those come from `power_flows`, not `power_usage`).

Every circuit had exactly **one** giant bucket, all in the **same ~1-minute window
(~19:28 local)** on 2026-07-01. The rest of each circuit's samples were normal
(a fridge sample is ~0.1 Wh).

## Evidence

Raw `power_usage` for the Fridge shows one poisoned sample among normal ones:

```
ts                          exported_wh   imported_wh
2026-07-01T19:28:54.34Z     0.10          0.0     <- normal
2026-07-01T19:28:45.32Z     421439.2      130.6   <- SPIKE
2026-07-01T19:28:30.21Z     0.10          0.0     <- normal
```

The spike **equals the circuit's lifetime cumulative register** (`circuits.exported_energy`
/ `imported_energy`), confirmed for several circuits:

| Circuit    | lifetime exported_energy | spike exported_wh | lifetime imported | spike imported_wh |
|------------|--------------------------|-------------------|-------------------|-------------------|
| Fridge     | 421,439.3 Wh             | 421,439.2 Wh      | 130.6 Wh          | 130.6 Wh          |
| EV Charger | 3,897,551 Wh             | ~3,899,400 Wh     | 655.1 Wh          | —                 |
| Heat Pump  | 5,568,056 Wh             | 5,568,100 Wh      | 435.9 Wh          | —                 |

So a single emitted delta = the entire lifetime counter, for every circuit at once.

## Root cause — `data/energy.go`, `EnergyTracker.Process`

The collector turns the panel's **cumulative** `imported-energy` / `exported-energy`
registers into per-interval deltas: `delta = current - prev` (lines 113–114). The
only sanity check is for **negative** deltas (counter reset); **positive deltas are
never bounded**.

The failure sequence (a panel reboot / MQTT reconnect makes every node's energy
register momentarily read low/zero at ~19:28 — e.g. a retained/republished `0`):

1. **Transient low reading arrives.** At lines 97–101 the cache is overwritten with
   the *current* reading **unconditionally**, before any validation. So the baseline
   for the node is now rebased to the bogus ~0 value.
2. `impDelta/expDelta` are negative → the reset branch (lines 116–126) logs
   `"energy counter reset detected; baseline rebased, skipping this delta"` and
   `continue`s. No row written — but the poisoned baseline is already cached.
3. **Next real reading arrives** = the true cumulative (~421,439 for the Fridge).
   `expDelta = 421439 - ~0` = the whole lifetime total. It is **positive**, so it
   passes the reset check, is non-zero, and is emitted as a normal delta
   (lines 137–147). `AvgExportW` is computed (line 145) but never checked against any
   ceiling, so nothing stops it.
4. Because the triggering event is panel-wide, this happens for **every** node in the
   same window → one full-lifetime spike row per circuit.

### The exact lines

- `energy.go:97–101` — cache overwritten with the current reading **before** validating
  it; a single transient sample poisons the baseline.
- `energy.go:116–126` — reset handling only covers **negative** deltas.
- `energy.go:137–147` — positive delta emitted with **no upper bound / power ceiling**
  (`AvgExportW`/`AvgImportW` at 144–145 are computed but unused for validation).

## Fix directions (for the next session)

Any one of these prevents the spike; combining 1+2 is most robust:

1. **Bound positive deltas.** Reject/skip a delta whose implied average power
   (`AvgImportW`/`AvgExportW`) exceeds a plausible ceiling — ideally derived from the
   circuit's breaker rating (`breaker-rating` × mains voltage), or a conservative global
   cap (e.g. 50 kW). On exceed, rebase (like the reset branch) and warn, don't emit.
2. **Don't trust a single anomalous reading as the new baseline.** On a suspected reset
   (or any large jump), defer the baseline update until a *subsequent consistent* reading
   confirms it, so one transient `0` can't poison `prev`. I.e. move/guard the cache write
   at lines 97–101 so it isn't unconditional.
3. **Distinguish a true reset from a transient dip.** A genuine counter reset is rare and
   sticks; a momentary drop-to-~0 that immediately recovers is a glitch. Only accept a
   reset if the low value persists across N readings.

## Data cleanup (separate from the code fix)

The spurious rows are already in QuestDB and will pollute per-circuit charts for
today → this week/month/year permanently. After fixing the code, delete the bad
`power_usage` rows (all circuits, 2026-07-01 ~19:28). A single-sample delta equal to a
lifetime cumulative is easy to target, e.g. rows where `exported_wh` is orders of
magnitude above the node's typical sample, or simply the known ~19:28 window on
2026-07-01. Verify against `circuits.exported_energy` to identify them.

## Fingerprint to look for in collector logs

Around 19:28 on 2026-07-01 there should be a burst of
`"energy counter reset detected; baseline rebased, skipping this delta"` warnings —
one per node — immediately preceding the spike rows. That burst is the signature of
this bug (transient low reading → rebase → full-cumulative recovery delta).
