#!/usr/bin/env python3
"""
Rolling MQTT raw-data logger.

Subscribes to the SPAN panel's MQTT tree and writes every message as an NDJSON
line to an hourly file:

  /log/YYYY-MM-DDTHH.ndjson

Files older than KEEP_HOURS (default 25) are pruned, keeping roughly one day of
replay data on disk so an ingestion outage can be replayed with replay.py
instead of being lost forever. Each line is:

  {"ts":"2026-09-11T23:05:01.123456Z","topic":"ebus/5/...","payload":"..."}

with two optional fields: "enc":"base64" when the payload is not valid UTF-8,
and "qos"/"retain" when they differ from the 0/false default (this keeps the
steady-state line size unchanged while preserving the information).

Durability: every message is flush()ed to the kernel immediately (so a SIGKILL
or `docker kill` loses nothing) and fdatasync()ed at most once a second (so a
power cut loses at most ~1s). See RollingLog.

Liveness: a heartbeat line is logged every HEARTBEAT_SECS with the message and
byte counts for the window, loudly WARNing when a window is empty, and a status
file (/log/.status.json) is kept up to date for the container healthcheck
(`mqttlog.py --healthcheck`). A refused subscription is treated as fatal: the
whole point of this service is that it cannot fail silently.

Config is read from /config/config.yml (the file the collector uses) with
individual values overridable via environment variables. As in the Go
collector's config.go, an environment variable that is *set but empty*
overrides the config file with an empty value.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import logging
import os
import re
import signal
import ssl
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt
import yaml

__version__ = "0.1.0"

# Only files this logger created are eligible for pruning. Anything else in
# /log (e.g. a log salvaged from an incident and copied in for safekeeping) is
# left alone forever.
HOUR_FILE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}\.ndjson$")

STATUS_FILENAME = ".status.json"

# The panel's broker ACL refuses "#", "+/#" and "$SYS/#" (SUBACK 0x80) but
# grants "ebus/#". "ebus/#" is therefore the broadest filter actually available
# and is a strict superset of "ebus/5/#", so it survives a firmware update that
# renumbers the bus. Do NOT change this to "#": it is silently refused and
# would log nothing at all.
DEFAULT_TOPICS = "ebus/#"

DEFAULT_KEEP_HOURS = 25
# ~25.5 MB/hour measured, so 25 hours is ~640 MB. 4 GiB is generous headroom
# that still bounds the worst case (a clock jump, a traffic spike, or a long
# outage that leaves hour files spanning far more than KEEP_HOURS of wall time).
DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
DEFAULT_HEARTBEAT_SECS = 60
DEFAULT_FSYNC_SECS = 1.0
DEFAULT_PRUNE_SECS = 300
DEFAULT_STALE_SECS = 300


class ConfigError(Exception):
    """Raised for a malformed configuration value."""


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def ev(key: str, fallback):
    """Environment override for a config value.

    Uses os.environ.get(key, fallback) rather than `os.environ.get(key) or
    fallback` so that an explicitly empty variable clears the value, matching
    envStr() in the Go collector's config.go. SPAN_MQTT_CA_CERT="" therefore
    disables TLS here exactly as it does for the collector.
    """
    value = os.environ.get(key, fallback)
    return "" if value is None else value


def ev_int(key: str, fallback) -> int:
    value = ev(key, fallback)
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        raise ConfigError(f"{key}: expected an integer, got {value!r}") from None


def ev_float(key: str, fallback) -> float:
    value = ev(key, fallback)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        raise ConfigError(f"{key}: expected a number, got {value!r}") from None


def load_config() -> dict:
    cfg_path = os.environ.get("CONFIG_FILE", "/config/config.yml")
    cfg: dict = {}
    try:
        with open(cfg_path) as f:
            cfg = yaml.safe_load(f) or {}
    except FileNotFoundError:
        pass
    except yaml.YAMLError as exc:
        raise ConfigError(f"{cfg_path}: {exc}") from None

    mqtt_cfg = cfg.get("mqtt") or {}
    span_cfg = cfg.get("span") or {}

    conf = {
        "host":         ev("SPAN_MQTT_SERVER",   mqtt_cfg.get("server", "")),
        "port":         ev_int("SPAN_MQTT_PORT", mqtt_cfg.get("port", 8883)),
        "username":     ev("SPAN_MQTT_USERNAME", mqtt_cfg.get("username", "")),
        "password":     ev("SPAN_MQTT_PASSWORD", mqtt_cfg.get("password", "")),
        "ca_cert":      ev("SPAN_MQTT_CA_CERT",  mqtt_cfg.get("ca_cert", "")),
        # What we subscribe to (comma-separated; overlapping filters would
        # duplicate messages, so keep it to one unless you know why).
        "topics":       [t.strip() for t in ev("MQTT_TOPICS", DEFAULT_TOPICS).split(",") if t.strip()],
        # What we *expect* to see. Used only as a canary: traffic flowing with
        # nothing under this prefix means the panel's layout moved and the
        # collector is probably already broken.
        "expect_prefix": ev("SPAN_TOPIC_PREFIX", span_cfg.get("topic_prefix", "ebus/5")),
        "log_dir":      ev("LOG_DIR", "/log"),
        "keep_hours":   ev_int("KEEP_HOURS", DEFAULT_KEEP_HOURS),
        "max_total_bytes": ev_int("MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES),
        "heartbeat_secs": ev_float("HEARTBEAT_SECS", DEFAULT_HEARTBEAT_SECS),
        "fsync_secs":   ev_float("FSYNC_SECS", DEFAULT_FSYNC_SECS),
        "prune_secs":   ev_float("PRUNE_SECS", DEFAULT_PRUNE_SECS),
        "stale_secs":   ev_float("STALE_SECS", DEFAULT_STALE_SECS),
        "client_id":    ev("MQTT_CLIENT_ID", "span-mqttlog-01"),
    }

    if conf["keep_hours"] < 1:
        raise ConfigError(
            f"KEEP_HOURS must be >= 1 (got {conf['keep_hours']}); "
            "there is no 'disable pruning' setting — raise KEEP_HOURS and/or "
            "MAX_TOTAL_BYTES instead"
        )
    if conf["max_total_bytes"] < 0:
        raise ConfigError(f"MAX_TOTAL_BYTES must be >= 0 (got {conf['max_total_bytes']}); "
                          "0 disables the byte cap")
    if not conf["topics"]:
        raise ConfigError("MQTT_TOPICS is empty — nothing would be subscribed to")
    return conf


# ---------------------------------------------------------------------------
# Rolling file writer
# ---------------------------------------------------------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def encode_payload(raw: bytes) -> tuple[str, str | None]:
    """Return (text, encoding) for an MQTT payload.

    Valid UTF-8 is stored as-is. Anything else is base64-encoded and flagged,
    because errors="replace" would substitute U+FFFD and destroy the bytes
    irrecoverably — the opposite of this service's purpose.
    """
    if isinstance(raw, str):
        return raw, None
    try:
        return bytes(raw).decode("utf-8"), None
    except UnicodeDecodeError:
        return base64.b64encode(bytes(raw)).decode("ascii"), "base64"


class RollingLog:
    """Hour-rotating NDJSON writer with count- and byte-bounded retention."""

    def __init__(self, log_dir: str, keep_hours: int,
                 max_total_bytes: int = 0, fsync_interval: float = DEFAULT_FSYNC_SECS) -> None:
        if keep_hours < 1:
            raise ValueError(
                f"keep_hours must be >= 1 (got {keep_hours}): 0 would prune the "
                "hour file that is currently open and every write would vanish"
            )
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.keep_hours = keep_hours
        self.max_total_bytes = max_total_bytes
        self.fsync_interval = fsync_interval
        self._lock = threading.RLock()
        self._fh = None
        self._cur_hour: str = ""
        self._cur_path: Path | None = None
        self._dirty = False
        self._last_sync = 0.0

    # -- writing ------------------------------------------------------------

    def write(self, ts: str, topic: str, payload: str, *,
              enc: str | None = None, qos: int = 0, retain: bool = False) -> int:
        """Append one record. Returns the number of bytes written.

        Raises OSError if the underlying file cannot be written (ENOSPC, EROFS,
        EACCES, ...). Callers must handle that as a write failure, never as a
        connection failure.
        """
        rec = {"ts": ts, "topic": topic, "payload": payload}
        if enc:
            rec["enc"] = enc
        if qos:
            rec["qos"] = int(qos)
        if retain:
            rec["retain"] = True
        line = json.dumps(rec, separators=(",", ":")) + "\n"
        with self._lock:
            hour = ts[:13]  # "YYYY-MM-DDTHH"
            if hour != self._cur_hour or self._fh is None:
                self._rotate(hour)
            self._fh.write(line)
            # Hand every record to the kernel immediately: cheap, and it means
            # a SIGKILL/`docker kill` loses nothing. Durability against power
            # loss is the separate, batched fdatasync below.
            self._fh.flush()
            self._dirty = True
        return len(line.encode("utf-8"))

    def _rotate(self, hour: str) -> None:
        with self._lock:
            if self._fh is not None:
                try:
                    self._sync_locked()
                finally:
                    self._fh.close()
                    self._fh = None
                    self._dirty = False
            path = self.log_dir / f"{hour}.ndjson"
            self._fh = open(path, "a", encoding="utf-8")  # noqa: SIM115 (long-lived)
            self._cur_hour = hour
            self._cur_path = path
            self.prune()

    # -- durability ---------------------------------------------------------

    def _sync_locked(self) -> None:
        if self._fh is None or not self._dirty:
            return
        self._fh.flush()
        os.fdatasync(self._fh.fileno())
        self._dirty = False
        self._last_sync = time.monotonic()

    def sync(self) -> None:
        with self._lock:
            self._sync_locked()

    def sync_if_due(self, now: float | None = None) -> bool:
        """fdatasync at most once per fsync_interval. Returns True if synced."""
        now = time.monotonic() if now is None else now
        with self._lock:
            if not self._dirty or (now - self._last_sync) < self.fsync_interval:
                return False
            self._sync_locked()
            return True

    # -- retention ----------------------------------------------------------

    def hour_files(self) -> list[Path]:
        """Hour files this logger owns, oldest first.

        The lexicographic sort is chronological for the YYYY-MM-DDTHH format.
        """
        try:
            names = os.listdir(self.log_dir)
        except FileNotFoundError:
            return []
        return sorted((self.log_dir / n) for n in names if HOUR_FILE_RE.match(n))

    def total_bytes(self) -> int:
        total = 0
        for p in self.hour_files():
            with contextlib.suppress(OSError):
                total += p.stat().st_size
        return total

    def prune(self) -> list[Path]:
        """Enforce the count and byte caps. Never touches the open hour file."""
        with self._lock:
            files = self.hour_files()
            current = self._cur_path
            # The file we are writing to is never a candidate: unlinking it
            # would leave writes going to an unlinked inode, silently lost.
            candidates = [p for p in files if current is None or p != current]
            removed: list[Path] = []

            def drop(victim: Path) -> None:
                try:
                    victim.unlink()
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    logging.warning("could not prune %s: %s", victim.name, exc)
                    return
                removed.append(victim)

            keep = max(1, self.keep_hours)
            while len(files) - len(removed) > keep and candidates:
                drop(candidates.pop(0))

            if self.max_total_bytes > 0:
                sizes = {}
                for p in files:
                    if p in removed:
                        continue
                    try:
                        sizes[p] = p.stat().st_size
                    except OSError:
                        sizes[p] = 0
                total = sum(sizes.values())
                while total > self.max_total_bytes and candidates:
                    victim = candidates.pop(0)
                    before = len(removed)
                    drop(victim)
                    if len(removed) > before:
                        total -= sizes.get(victim, 0)

            if removed:
                logging.info("pruned %d hour file(s): %s",
                             len(removed), ", ".join(p.name for p in removed))
            return removed

    # -- shutdown -----------------------------------------------------------

    def close(self) -> None:
        with self._lock:
            if self._fh is not None:
                try:
                    self._sync_locked()
                finally:
                    self._fh.close()
                    self._fh = None


# ---------------------------------------------------------------------------
# Recorder: stats + write-error policy
# ---------------------------------------------------------------------------

class Recorder:
    """Turns MQTT messages into log records and owns the write-failure policy.

    Write failures (ENOSPC, read-only volume, EACCES) are *not* connection
    failures. They are retried a few times and then made fatal so the process
    exits non-zero, the container restarts, and the healthcheck goes red —
    rather than being reported forever as "connection error" while nothing at
    all is recorded.
    """

    def __init__(self, log: RollingLog, expect_prefix: str = "",
                 on_fatal=None, write_retries: int = 3, retry_delay: float = 0.5) -> None:
        self.log = log
        self.expect_prefix = expect_prefix
        self._on_fatal = on_fatal
        self.write_retries = max(1, write_retries)
        self.retry_delay = retry_delay
        self._lock = threading.Lock()
        self.messages_total = 0
        self.bytes_total = 0
        self.window_messages = 0
        self.window_bytes = 0
        self.window_expected = 0
        self.write_errors = 0
        self.last_message_epoch = 0.0
        self.last_message_ts = ""
        self.fatal: str | None = None
        self._logged_first = False

    def set_on_fatal(self, callback) -> None:
        self._on_fatal = callback

    def set_fatal(self, reason: str) -> None:
        self.fatal = reason
        logging.error("FATAL: %s", reason)
        if self._on_fatal:
            self._on_fatal(reason)

    def record(self, topic: str, payload, qos: int = 0, retain: bool = False,
               ts: str | None = None) -> bool:
        if ts is None:
            ts = utc_now_iso()
        text, enc = encode_payload(payload)
        for attempt in range(1, self.write_retries + 1):
            try:
                nbytes = self.log.write(ts, topic, text, enc=enc, qos=qos, retain=retain)
            except OSError as exc:
                with self._lock:
                    self.write_errors += 1
                logging.error("write failed (attempt %d/%d): %s", attempt, self.write_retries, exc)
                if attempt >= self.write_retries:
                    self.set_fatal(f"cannot write to {self.log.log_dir}: {exc}")
                    return False
                time.sleep(self.retry_delay)
            except Exception as exc:  # a bug in the write path, not a disk problem
                with self._lock:
                    self.write_errors += 1
                self.set_fatal(f"unhandled error writing record: {exc!r}")
                return False
            else:
                with self._lock:
                    self.messages_total += 1
                    self.bytes_total += nbytes
                    self.window_messages += 1
                    self.window_bytes += nbytes
                    if self.expect_prefix and topic.startswith(self.expect_prefix):
                        self.window_expected += 1
                    self.last_message_epoch = time.time()
                    self.last_message_ts = ts
                    first = not self._logged_first
                    self._logged_first = True
                if first:
                    logging.info("first message recorded: topic=%s (%d bytes)", topic, nbytes)
                return True
        return False

    def take_window(self) -> dict:
        with self._lock:
            w = {
                "messages": self.window_messages,
                "bytes": self.window_bytes,
                "expected": self.window_expected,
            }
            self.window_messages = 0
            self.window_bytes = 0
            self.window_expected = 0
            return w

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "messages_total": self.messages_total,
                "bytes_total": self.bytes_total,
                "write_errors": self.write_errors,
                "last_message_epoch": self.last_message_epoch,
                "last_message_ts": self.last_message_ts,
                "fatal": self.fatal,
            }


# ---------------------------------------------------------------------------
# Status file + healthcheck
# ---------------------------------------------------------------------------

def status_path(log_dir: str) -> Path:
    return Path(log_dir) / STATUS_FILENAME


def write_status(path: Path, status: dict) -> None:
    """Write the status file atomically so a healthcheck never sees a partial."""
    tmp = path.with_name(path.name + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(status, f, separators=(",", ":"))
            f.flush()
        os.replace(tmp, path)
    except OSError as exc:
        logging.warning("could not update %s: %s", path, exc)


def read_status(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def evaluate_health(status: dict | None, now: float) -> tuple[bool, str]:
    """Decide whether the logger is healthy from its status file.

    Deliberately keyed on data actually being written, not just on the process
    being alive: a container that is Up but recording nothing is the exact
    failure this service exists to catch.
    """
    if not status:
        return False, "no status file — logger has not started"
    if status.get("fatal"):
        return False, f"fatal: {status['fatal']}"
    if not status.get("subscribed"):
        return False, "no active subscription"

    heartbeat = float(status.get("heartbeat_secs") or DEFAULT_HEARTBEAT_SECS)
    age = now - float(status.get("updated_epoch") or 0)
    max_age = max(3.0 * heartbeat, 180.0)
    if age > max_age:
        return False, f"status file is {age:.0f}s old (> {max_age:.0f}s) — logger stalled"

    stale = float(status.get("stale_secs") or DEFAULT_STALE_SECS)
    last = float(status.get("last_message_epoch") or 0)
    if last <= 0:
        return False, "no messages have ever been recorded"
    silent = now - last
    if silent > stale:
        return False, f"no messages for {silent:.0f}s (> {stale:.0f}s)"
    return True, f"ok — last message {silent:.0f}s ago, {status.get('messages_total', 0)} total"


def healthcheck(log_dir: str) -> int:
    ok, reason = evaluate_health(read_status(status_path(log_dir)), time.time())
    print(reason)
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# MQTT client
# ---------------------------------------------------------------------------

def rc_is_failure(rc) -> bool:
    """True for a failed SUBACK code, for both ReasonCode objects and ints."""
    failure = getattr(rc, "is_failure", None)
    if isinstance(failure, bool):
        return failure
    try:
        return int(getattr(rc, "value", rc)) >= 0x80
    except (TypeError, ValueError):
        return True


class Logger:
    """Wires the MQTT client to the Recorder and supervises liveness."""

    def __init__(self, cfg: dict, recorder: Recorder, log: RollingLog) -> None:
        self.cfg = cfg
        self.recorder = recorder
        self.log = log
        self.stop = threading.Event()
        self.exit_code = 0
        self.connected = False
        self.subscribed: set[str] = set()
        self.refused: set[str] = set()
        self._pending_sub: dict[int, str] = {}
        self._status_path = status_path(cfg["log_dir"])
        self.client = self._build_client()

    # -- lifecycle ----------------------------------------------------------

    def fail(self, reason: str, code: int = 1) -> None:
        self.exit_code = code
        self.stop.set()

    def _build_client(self) -> mqtt.Client:
        cfg = self.cfg
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=cfg["client_id"],
            clean_session=True,
        )
        if cfg["username"]:
            client.username_pw_set(cfg["username"], cfg["password"])
        if cfg["ca_cert"]:
            client.tls_set(ca_certs=cfg["ca_cert"], tls_version=ssl.PROTOCOL_TLS_CLIENT)
        # Bounded exponential backoff for every reconnect, including the first
        # connection attempt (loop_forever(retry_first_connection=True) inside
        # loop_start()). No jitter: there is exactly one client and one broker,
        # so there is no herd to spread out.
        client.reconnect_delay_set(min_delay=1, max_delay=60)
        client.on_connect = self._on_connect
        client.on_connect_fail = self._on_connect_fail
        client.on_disconnect = self._on_disconnect
        client.on_subscribe = self._on_subscribe
        client.on_message = self._on_message
        return client

    # -- callbacks ----------------------------------------------------------

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code != 0:
            self.connected = False
            logging.error("MQTT connect refused: %s", reason_code)
            return
        self.connected = True
        self.subscribed.clear()
        self.refused.clear()
        self._pending_sub.clear()
        for topic in self.cfg["topics"]:
            result, mid = client.subscribe(topic, qos=0)
            if result != mqtt.MQTT_ERR_SUCCESS:
                logging.error("subscribe(%s) failed to send: %s", topic, result)
                continue
            self._pending_sub[mid] = topic
        logging.info("MQTT connected — subscribing to %s", ", ".join(self.cfg["topics"]))

    def _on_connect_fail(self, client, userdata):
        self.connected = False
        logging.warning("MQTT connection attempt failed — retrying with backoff")

    def _on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        self.connected = False
        self.subscribed.clear()
        if reason_code != 0:
            logging.warning("MQTT disconnected (%s), will reconnect", reason_code)

    def _on_subscribe(self, client, userdata, mid, reason_code_list, properties):
        topic = self._pending_sub.pop(mid, "?")
        failures = [str(rc) for rc in reason_code_list if rc_is_failure(rc)]
        if failures:
            self.refused.add(topic)
            logging.error("subscription to %r was REFUSED by the broker (%s) — "
                          "no messages will arrive for this filter",
                          topic, ", ".join(failures))
        else:
            self.subscribed.add(topic)
            logging.info("subscribed to %r (%s)", topic,
                         ", ".join(str(rc) for rc in reason_code_list))
        if not self._pending_sub and not self.subscribed:
            # Every filter was refused: this is a permanent ACL/config error and
            # the container must not sit there looking healthy.
            self.recorder.set_fatal(
                f"broker refused every subscription {sorted(self.refused)} — "
                "check MQTT_TOPICS against the broker's ACL"
            )
            self.fail("no usable subscription")

    def _on_message(self, client, userdata, msg):
        # Must never raise: an exception here would unwind through paho and
        # kill the network thread.
        try:
            self.recorder.record(msg.topic, msg.payload, qos=msg.qos, retain=msg.retain)
        except Exception as exc:  # pragma: no cover - defensive
            logging.exception("unexpected error handling message: %s", exc)
            self.recorder.set_fatal(f"unhandled error in message handler: {exc!r}")
        if self.recorder.fatal:
            self.fail(self.recorder.fatal)

    # -- background ticker --------------------------------------------------

    def status(self, window: dict | None = None) -> dict:
        snap = self.recorder.snapshot()
        return {
            "version": __version__,
            "pid": os.getpid(),
            "updated": utc_now_iso(),
            "updated_epoch": time.time(),
            "connected": self.connected,
            "subscribed": sorted(self.subscribed),
            "refused": sorted(self.refused),
            "topics": self.cfg["topics"],
            "expect_prefix": self.cfg["expect_prefix"],
            "heartbeat_secs": self.cfg["heartbeat_secs"],
            "stale_secs": self.cfg["stale_secs"],
            "keep_hours": self.cfg["keep_hours"],
            "files": len(self.log.hour_files()),
            "disk_bytes": self.log.total_bytes(),
            "window": window or {},
            **snap,
        }

    def _publish_status(self, window: dict | None = None) -> None:
        write_status(self._status_path, self.status(window))

    def _heartbeat(self, elapsed: float) -> None:
        window = self.recorder.take_window()
        snap = self.recorder.snapshot()
        rate = window["messages"] / elapsed if elapsed > 0 else 0.0
        logging.info(
            "heartbeat msgs=%d bytes=%d rate=%.1f/s window=%.0fs total_msgs=%d "
            "total_bytes=%d files=%d disk_bytes=%d connected=%s",
            window["messages"], window["bytes"], rate, elapsed,
            snap["messages_total"], snap["bytes_total"],
            len(self.log.hour_files()), self.log.total_bytes(), self.connected,
        )
        if window["messages"] == 0:
            logging.warning(
                "NO MESSAGES recorded in the last %.0fs — nothing is being logged. "
                "Subscribed=%s refused=%s connected=%s. If the panel's topic tree "
                "moved, set MQTT_TOPICS to the new filter.",
                elapsed, sorted(self.subscribed) or "none",
                sorted(self.refused) or "none", self.connected,
            )
        elif self.cfg["expect_prefix"] and window["expected"] == 0:
            logging.warning(
                "traffic is flowing (%d msgs) but NONE matched the expected prefix %r "
                "in the last %.0fs — the panel's topic layout may have changed and "
                "the collector is probably not ingesting",
                window["messages"], self.cfg["expect_prefix"], elapsed,
            )
        self._publish_status(window)

    def _ticker(self) -> None:
        tick = min(self.cfg["fsync_secs"], 1.0)
        last_hb = time.monotonic()
        last_prune = time.monotonic()
        while not self.stop.wait(tick):
            now = time.monotonic()
            try:
                self.log.sync_if_due(now)
            except OSError as exc:
                logging.error("fdatasync failed: %s", exc)
                self.recorder.set_fatal(f"fdatasync failed: {exc}")
                self.fail("fdatasync failed")
                return
            if now - last_hb >= self.cfg["heartbeat_secs"]:
                self._heartbeat(now - last_hb)
                last_hb = now
            # Retention must not depend on messages arriving: prune on a timer
            # as well as on rotation.
            if now - last_prune >= self.cfg["prune_secs"]:
                try:
                    self.log.prune()
                except OSError as exc:
                    logging.warning("prune failed: %s", exc)
                last_prune = now

    # -- run ----------------------------------------------------------------

    def run(self) -> int:
        cfg = self.cfg
        self._publish_status()
        ticker = threading.Thread(target=self._ticker, name="ticker", daemon=True)
        ticker.start()

        # connect_async + loop_start: paho owns the network thread, retries the
        # first connection and every reconnect with backoff, and the main
        # thread stays free to handle signals without touching MQTT internals.
        self.client.connect_async(cfg["host"], cfg["port"], keepalive=60)
        self.client.loop_start()

        self.stop.wait()

        logging.info("shutting down")
        try:
            self.client.disconnect()
        except Exception as exc:  # pragma: no cover - best effort
            logging.debug("disconnect: %s", exc)
        self.client.loop_stop()
        ticker.join(timeout=5)
        try:
            self.log.close()
        except OSError as exc:
            logging.error("error closing log: %s", exc)
            self.exit_code = self.exit_code or 1
        snap = self.recorder.snapshot()
        logging.info("stopped after %d messages / %d bytes",
                     snap["messages_total"], snap["bytes_total"])
        self._publish_status()
        return self.exit_code


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Rolling MQTT raw-data logger")
    parser.add_argument("--healthcheck", action="store_true",
                        help="evaluate the status file and exit 0 (healthy) or 1")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)

    if args.healthcheck:
        return healthcheck(os.environ.get("LOG_DIR", "/log"))

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)sZ %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    logging.Formatter.converter = time.gmtime

    try:
        cfg = load_config()
    except ConfigError as exc:
        logging.error("configuration error: %s", exc)
        return 2

    if not cfg["host"]:
        logging.error("MQTT host not configured (set mqtt.server in config.yml "
                      "or SPAN_MQTT_SERVER env)")
        return 2

    logging.info(
        "starting mqttlog %s host=%s port=%d topics=%s expect_prefix=%s "
        "log_dir=%s keep_hours=%d max_bytes=%d",
        __version__, cfg["host"], cfg["port"], ",".join(cfg["topics"]),
        cfg["expect_prefix"], cfg["log_dir"], cfg["keep_hours"], cfg["max_total_bytes"],
    )

    try:
        log = RollingLog(cfg["log_dir"], cfg["keep_hours"],
                         max_total_bytes=cfg["max_total_bytes"],
                         fsync_interval=cfg["fsync_secs"])
    except (OSError, ValueError) as exc:
        logging.error("cannot open log directory %s: %s", cfg["log_dir"], exc)
        return 2

    recorder = Recorder(log, expect_prefix=cfg["expect_prefix"])
    logger = Logger(cfg, recorder, log)
    # A fatal write error must stop the process, not be retried forever.
    recorder.set_on_fatal(logger.fail)

    def shutdown(signum, frame):
        # Signal handlers run on the main thread: only set a flag here. Taking
        # the log lock or touching the MQTT socket from a handler could
        # deadlock or corrupt an in-flight packet.
        logging.info("received signal %d", signum)
        logger.stop.set()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    return logger.run()


if __name__ == "__main__":
    sys.exit(main())
