#!/usr/bin/env python3
"""
Replay raw MQTT NDJSON logs back to a broker.

Reads the hourly files written by mqttlog.py and republishes each message so
the collector can re-ingest a window it missed. Messages carry their original
topics, so the collector treats them exactly like live data.

Usage:
  # what would be replayed (this is the DEFAULT — nothing is sent)
  replay.py --log-dir /log --from 2026-09-11T01:00:00Z --to 2026-09-11T23:00:00Z

  # actually send it
  replay.py --log-dir /log --host mosquitto --port 1883 --publish \
            --from 2026-09-11T01:00:00Z --to 2026-09-11T23:00:00Z

Safety
------
* --publish is required to send anything; without it this is a dry run.
* --from/--to must be valid ISO-8601. A malformed value is rejected rather than
  silently disabling the filter and replaying the whole log.
* Replaying into the SPAN panel's own broker would inject stale values into the
  live topic tree feeding a real electrical panel, so a target that resolves to
  the panel is refused unless --i-really-mean-the-panel is given.

Delivery
--------
Published at QoS 1 and accounted for individually. Every message is confirmed
delivered (PUBACK) before the process exits, and the exit status is non-zero if
even one message did not make it. QoS 0 cannot be used here: paho discards a
QoS 0 publish outright whenever the socket happens to be down, which silently
loses most of a replay.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import socket
import ssl
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt

# Bound how much of the log is resident in paho's outbound queue at once. A
# day's traffic is ~1.4M messages; queueing them all would need >400 MB.
DEFAULT_MAX_QUEUED = 2000
DEFAULT_DRAIN_TIMEOUT = 120.0


class ReplayError(Exception):
    """A user-facing error (bad input, refused target)."""


# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------

def parse_ts(s: str) -> datetime:
    """Parse an ISO-8601 timestamp into an aware UTC datetime.

    Accepts the "...Z" form written by mqttlog.py as well as explicit offsets.
    A value with no offset is treated as UTC (that is what the logger writes);
    it is never interpreted as local time.
    """
    if not isinstance(s, str) or not s.strip():
        raise ValueError("empty timestamp")
    text = s.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f"unparseable timestamp: {s!r}") from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_bound(s: str | None, flag: str) -> datetime | None:
    """Validate a --from/--to bound, failing closed on anything malformed."""
    if s is None:
        return None
    try:
        return parse_ts(s)
    except ValueError as exc:
        raise ReplayError(
            f"{flag}: {exc}. Use an ISO-8601 timestamp such as "
            f"2026-09-11T05:00:00Z. Refusing to continue rather than ignoring "
            f"the bound and replaying everything."
        ) from None


# ---------------------------------------------------------------------------
# Reading the log
# ---------------------------------------------------------------------------

def decode_record(rec: dict):
    """Return (ts, topic, payload_bytes, qos, retain) from a log record."""
    payload = rec.get("payload", "")
    data = (base64.b64decode(payload) if rec.get("enc") == "base64"
            else str(payload).encode("utf-8"))
    return (rec.get("ts", ""), rec.get("topic", ""), data,
            int(rec.get("qos", 0) or 0), bool(rec.get("retain", False)))


class ReadStats:
    def __init__(self) -> None:
        self.lines = 0
        self.malformed = 0
        self.unparsable_ts = 0
        self.no_topic = 0
        self.filtered = 0

    def as_dict(self) -> dict:
        return {"lines": self.lines, "malformed": self.malformed,
                "unparsable_ts": self.unparsable_ts, "no_topic": self.no_topic,
                "filtered": self.filtered}


def iter_messages(log_dir: str, ts_from=None, ts_to=None, stats: ReadStats | None = None):
    """Yield (ts, topic, payload_bytes, qos, retain) in chronological order.

    ts_from/ts_to are aware datetimes (or ISO strings, which are validated).
    The window is [ts_from, ts_to): inclusive of the lower bound, exclusive of
    the upper. Comparison is on parsed datetimes, never on raw strings — string
    comparison silently mis-filters any timestamp whose textual form differs
    from the records'.
    """
    if isinstance(ts_from, str):
        ts_from = parse_bound(ts_from, "--from")
    if isinstance(ts_to, str):
        ts_to = parse_bound(ts_to, "--to")
    stats = stats if stats is not None else ReadStats()

    from_hour = ts_from.strftime("%Y-%m-%dT%H") if ts_from else None
    to_hour = ts_to.strftime("%Y-%m-%dT%H") if ts_to else None

    for path in sorted(Path(log_dir).glob("*.ndjson")):
        # Hour-level prefilter so whole files outside the window are skipped.
        hour = path.stem  # "YYYY-MM-DDTHH"
        if from_hour and hour < from_hour:
            continue
        if to_hour and hour > to_hour:
            continue

        # Read as bytes and decode strictly per line: errors="replace" would
        # silently corrupt a payload rather than telling us the file is damaged.
        with open(path, "rb") as f:
            for lineno, raw_line in enumerate(f, 1):
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                stats.lines += 1
                try:
                    line = raw_line.decode("utf-8")
                    rec = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    stats.malformed += 1
                    print(f"skipping malformed line {path}:{lineno}", file=sys.stderr)
                    continue
                try:
                    ts, topic, payload, qos, retain = decode_record(rec)
                except (ValueError, TypeError) as exc:
                    stats.malformed += 1
                    print(f"skipping undecodable line {path}:{lineno}: {exc}", file=sys.stderr)
                    continue

                if ts_from or ts_to:
                    try:
                        when = parse_ts(ts)
                    except ValueError:
                        # Can't place it in time; excluding it is the only
                        # honest option, but never do so silently.
                        stats.unparsable_ts += 1
                        print(f"skipping line with unusable ts {path}:{lineno}: {ts!r}",
                              file=sys.stderr)
                        continue
                    if ts_from and when < ts_from:
                        stats.filtered += 1
                        continue
                    if ts_to and when >= ts_to:
                        stats.filtered += 1
                        continue

                if not topic:
                    stats.no_topic += 1
                    print(f"skipping line with no topic {path}:{lineno}", file=sys.stderr)
                    continue
                yield ts, topic, payload, qos, retain


def summarize(messages) -> dict:
    """Count messages and find the true first/last timestamp."""
    n = 0
    first = last = None
    topics = set()
    nbytes = 0
    for ts, topic, payload, _qos, _retain in messages:
        n += 1
        nbytes += len(payload)
        topics.add(topic)
        # `first = first or ts` would skip a leading record with an empty ts.
        if first is None:
            first = ts
        last = ts
    return {"messages": n, "first": first, "last": last,
            "topics": len(topics), "payload_bytes": nbytes}


# ---------------------------------------------------------------------------
# Panel guard
# ---------------------------------------------------------------------------

def resolve_all(host: str) -> set[str]:
    try:
        return {info[4][0] for info in socket.getaddrinfo(host, None)}
    except (socket.gaierror, OSError, UnicodeError):
        return set()


def read_env_file(path: str) -> dict:
    """Minimal KEY=VALUE reader for the compose .env beside config/."""
    values: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def panel_identity(config_file: str | None = None, env_file: str | None = None) -> tuple[set[str], set[str]]:
    """Return (panel hostnames, panel IPs) from the environment/.env/config.yml."""
    names: set[str] = set()
    ips: set[str] = set()

    env = dict(os.environ)
    for candidate in filter(None, [env_file, os.environ.get("ENV_FILE"),
                                   "/opt/span-stats/.env", ".env", "../.env"]):
        if os.path.exists(candidate):
            for k, v in read_env_file(candidate).items():
                env.setdefault(k, v)
            break

    if env.get("PANEL_HOST"):
        names.add(env["PANEL_HOST"].lower())
    if env.get("PANEL_IP"):
        ips.add(env["PANEL_IP"])

    cfg_path = config_file or os.environ.get("CONFIG_FILE", "/config/config.yml")
    try:
        import yaml
        with open(cfg_path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        server = ((cfg.get("mqtt") or {}).get("server") or "").strip()
        if server:
            names.add(server.lower())
    except Exception:
        pass

    for name in list(names):
        ips |= resolve_all(name)
    return names, ips


def is_panel_target(host: str, panel_names: set[str], panel_ips: set[str]) -> bool:
    """True if `host` is (or resolves to) the SPAN panel itself."""
    if not host:
        return False
    if host.strip().lower() in panel_names:
        return True
    return bool(resolve_all(host) & panel_ips)


# ---------------------------------------------------------------------------
# Publishing
# ---------------------------------------------------------------------------

class Publisher:
    """Publishes with per-message accounting and a real drain.

    paho's publish() only *queues* a message. For QoS 1 an rc of NO_CONN still
    means queued (it is resent on the next CONNACK) — only QUEUE_SIZE is a
    genuine refusal, and that one is retried rather than dropped. Nothing is
    counted as replayed until its PUBACK has arrived.
    """

    def __init__(self, client, qos: int = 1, max_queued: int = DEFAULT_MAX_QUEUED,
                 progress_every: int = 10000) -> None:
        self.client = client
        self.qos = qos
        self.max_queued = max_queued
        self.progress_every = progress_every
        self.attempted = 0
        self.queued = 0
        self.delivered = 0
        self.refused = 0
        self.errors: list[str] = []
        # A PUBACK can land on the network thread before publish() has returned
        # the mid to us, so acks that arrive early are parked here and matched
        # up when the publish call completes. Without this the message looks
        # permanently unconfirmed and the drain reports a phantom shortfall.
        self._pending: set[int] = set()
        self._early: set[int] = set()
        self._lock = threading.Lock()
        client.on_publish = self._on_publish

    def _on_publish(self, client, userdata, mid, reason_code=None, properties=None):
        with self._lock:
            if mid in self._pending:
                self._pending.discard(mid)
                self.delivered += 1
            else:
                self._early.add(mid)

    @property
    def in_flight(self) -> int:
        with self._lock:
            return len(self._pending)

    def publish(self, topic: str, payload: bytes, retain: bool = False) -> bool:
        self.attempted += 1
        # Back-pressure: never let the outbound queue outrun the socket.
        deadline = time.monotonic() + 300
        while self.in_flight >= self.max_queued:
            if time.monotonic() > deadline:
                self.errors.append(f"outbound queue stuck full for 300s at {topic}")
                return False
            time.sleep(0.01)

        while True:
            try:
                info = self.client.publish(topic, payload, qos=self.qos, retain=retain)
            except ValueError as exc:  # invalid topic (wildcard, empty, ...)
                self.refused += 1
                self.errors.append(f"{topic!r}: {exc}")
                return False
            rc = getattr(info, "rc", 0)
            if rc == mqtt.MQTT_ERR_QUEUE_SIZE:
                # A real refusal: the message was NOT queued. Wait and retry —
                # dropping it here is exactly the silent loss we are fixing.
                time.sleep(0.01)
                continue
            if rc == mqtt.MQTT_ERR_NO_CONN and self.qos == 0:
                # At QoS 0 paho discards the message outright when the socket
                # is down. Nothing to wait for; count it as lost.
                self.refused += 1
                self.errors.append(f"{topic!r}: dropped while disconnected (qos 0)")
                return False
            if rc not in (mqtt.MQTT_ERR_SUCCESS, mqtt.MQTT_ERR_NO_CONN):
                self.refused += 1
                self.errors.append(f"{topic!r}: publish rc={rc}")
                return False
            # SUCCESS or NO_CONN: for QoS 1 both mean "in paho's outbound
            # store", and NO_CONN entries are resent on the next CONNACK.
            with self._lock:
                self.queued += 1
                if info.mid in self._early:
                    self._early.discard(info.mid)
                    self.delivered += 1
                else:
                    self._pending.add(info.mid)
            return True

    def drain(self, timeout: float = DEFAULT_DRAIN_TIMEOUT, log=print) -> bool:
        """Block until every queued message is confirmed, or the timeout hits."""
        deadline = time.monotonic() + timeout
        last_report = 0.0
        while True:
            remaining = self.in_flight
            if remaining == 0:
                return True
            now = time.monotonic()
            if now > deadline:
                log(f"drain timed out with {remaining} message(s) unconfirmed",
                    file=sys.stderr)
                return False
            if now - last_report >= 5:
                log(f"  draining: {remaining} message(s) awaiting PUBACK",
                    file=sys.stderr)
                last_report = now
            time.sleep(0.05)


def build_client(args) -> mqtt.Client:
    client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                         client_id=args.client_id, clean_session=True)
    if args.username:
        client.username_pw_set(args.username, args.password)
    if args.ca_cert:
        client.tls_set(ca_certs=args.ca_cert, tls_version=ssl.PROTOCOL_TLS_CLIENT)
    client.max_queued_messages_set(args.max_queued * 2)
    client.max_inflight_messages_set(100)
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    return client


def wait_for_connect(client, connected: threading.Event, timeout: float = 30.0) -> None:
    """Block until CONNACK.

    connect() returns before the handshake completes, so publishing straight
    after it races the socket and (at QoS 0) would discard the first burst.
    """
    if not connected.wait(timeout):
        raise ReplayError(f"no CONNACK within {timeout:.0f}s — check host/port/credentials")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--log-dir", default=os.environ.get("LOG_DIR", "/log"))
    p.add_argument("--host", default="", help="target broker host (required with --publish)")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--username", default=os.environ.get("REPLAY_MQTT_USERNAME", ""))
    p.add_argument("--password", default=os.environ.get("REPLAY_MQTT_PASSWORD", ""),
                   help="prefer REPLAY_MQTT_PASSWORD: an argv password is visible in ps")
    p.add_argument("--ca-cert", default="", help="enable TLS with this CA bundle")
    p.add_argument("--client-id", default="span-replay-01")
    p.add_argument("--from", dest="ts_from", default=None,
                   help="only replay messages at/after this ISO timestamp (inclusive)")
    p.add_argument("--to", dest="ts_to", default=None,
                   help="only replay messages before this ISO timestamp (exclusive)")
    p.add_argument("--realtime", action="store_true",
                   help="reproduce the original inter-message delays")
    p.add_argument("--publish", action="store_true",
                   help="actually publish (without this it is a dry run)")
    p.add_argument("--dry-run", action="store_true",
                   help="explicitly request a dry run (the default)")
    p.add_argument("--qos", type=int, default=1, choices=(0, 1, 2),
                   help="publish QoS (default 1; 0 cannot be accounted for)")
    p.add_argument("--preserve-retain", action="store_true",
                   help="republish retained messages with the retain flag set")
    p.add_argument("--max-queued", type=int, default=DEFAULT_MAX_QUEUED,
                   help="maximum messages awaiting PUBACK at once")
    p.add_argument("--drain-timeout", type=float, default=DEFAULT_DRAIN_TIMEOUT,
                   help="seconds to wait for the final PUBACKs")
    p.add_argument("--i-really-mean-the-panel", dest="allow_panel", action="store_true",
                   help="permit publishing to the SPAN panel's own broker (dangerous)")
    p.add_argument("--config-file", default=None,
                   help="config.yml used to identify the panel (default $CONFIG_FILE)")
    return p


def run(args) -> int:
    ts_from = parse_bound(args.ts_from, "--from")
    ts_to = parse_bound(args.ts_to, "--to")
    if ts_from and ts_to and ts_to <= ts_from:
        raise ReplayError(f"--to ({ts_to.isoformat()}) must be after --from ({ts_from.isoformat()})")

    if not args.publish:
        stats = ReadStats()
        summary = summarize(iter_messages(args.log_dir, ts_from, ts_to, stats))
        print(f"DRY RUN (no --publish): {summary['messages']} messages, "
              f"{summary['topics']} distinct topics, {summary['payload_bytes']} payload bytes")
        print(f"  window: {summary['first']} .. {summary['last']}")
        skipped = stats.malformed + stats.unparsable_ts + stats.no_topic
        if skipped:
            print(f"  skipped: {stats.malformed} malformed, "
                  f"{stats.unparsable_ts} unusable ts, {stats.no_topic} no topic")
        if summary["messages"]:
            print("  re-run with --publish --host <broker> to send")
        return 0

    if not args.host:
        raise ReplayError("--publish requires --host")

    if not args.allow_panel:
        names, ips = panel_identity(args.config_file)
        if is_panel_target(args.host, names, ips):
            raise ReplayError(
                f"refusing to publish to {args.host!r}: it is the SPAN panel's own "
                f"broker (panel hosts: {sorted(names) or 'unknown'}). Replaying into "
                "the panel would inject stale values into the live topic tree of a "
                "real electrical panel. Point --host at the collector's broker, or "
                "pass --i-really-mean-the-panel if that is genuinely what you want."
            )

    connected = threading.Event()
    connect_error: list[str] = []

    client = build_client(args)

    def on_connect(c, userdata, flags, reason_code, properties):
        if reason_code == 0:
            connected.set()
        else:
            connect_error.append(str(reason_code))
            connected.set()

    def on_disconnect(c, userdata, disconnect_flags, reason_code, properties):
        if reason_code != 0:
            print(f"  broker connection lost ({reason_code}); queued messages will "
                  "be resent on reconnect", file=sys.stderr)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect

    pub = Publisher(client, qos=args.qos, max_queued=args.max_queued)

    client.connect(args.host, args.port, keepalive=60)
    client.loop_start()
    try:
        wait_for_connect(client, connected)
        if connect_error:
            raise ReplayError(f"broker refused the connection: {connect_error[0]}")

        stats = ReadStats()
        prev = None
        started = time.monotonic()
        for ts, topic, payload, _qos, retain in iter_messages(args.log_dir, ts_from, ts_to, stats):
            if args.realtime and prev is not None:
                try:
                    delay = (parse_ts(ts) - prev).total_seconds()
                except ValueError:
                    delay = 0
                if 0 < delay < 60:
                    time.sleep(delay)
            pub.publish(topic, payload, retain=retain and args.preserve_retain)
            if args.realtime:
                with contextlib.suppress(ValueError):
                    prev = parse_ts(ts)
            if pub.attempted % pub.progress_every == 0:
                print(f"  {pub.attempted} read / {pub.delivered} confirmed ({ts})",
                      file=sys.stderr)

        ok = pub.drain(timeout=args.drain_timeout)
        elapsed = time.monotonic() - started
    finally:
        try:
            client.disconnect()
        finally:
            client.loop_stop()

    lost = pub.attempted - pub.delivered
    rate = f" ({pub.delivered / elapsed:.0f}/s)" if elapsed > 0 else ""
    print(f"replayed {pub.delivered}/{pub.attempted} messages in {elapsed:.1f}s{rate}")
    skipped = stats.malformed + stats.unparsable_ts + stats.no_topic
    if skipped:
        print(f"  skipped while reading: {stats.malformed} malformed, "
              f"{stats.unparsable_ts} unusable ts, {stats.no_topic} no topic", file=sys.stderr)
    for err in pub.errors[:10]:
        print(f"  error: {err}", file=sys.stderr)
    if len(pub.errors) > 10:
        print(f"  ... and {len(pub.errors) - 10} more errors", file=sys.stderr)

    if lost or not ok or pub.refused:
        print(f"FAILED: {lost} message(s) were not confirmed delivered", file=sys.stderr)
        return 1
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except ReplayError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
