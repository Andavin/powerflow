"""Tests for the NDJSON replay tool.

The replay path is the reason the logger exists, so its failure modes — silent
drops, mis-parsed windows, publishing at the panel — are pinned down here.
"""

import base64
import json
from datetime import datetime, timezone

import pytest

import replay

# ---------------------------------------------------------------------------
# Timestamp parsing (#10)
# ---------------------------------------------------------------------------

def test_parse_ts_reads_z_form_as_utc(monkeypatch):
    """#10: the Z form used to be interpreted as local time."""
    monkeypatch.setenv("TZ", "MST7MDT,M3.2.0,M11.1.0")
    import time
    time.tzset()
    try:
        got = replay.parse_ts("2026-09-11T05:00:00.000000Z")
        assert got == datetime(2026, 9, 11, 5, 0, 0, tzinfo=timezone.utc)
    finally:
        monkeypatch.setenv("TZ", "UTC")
        time.tzset()


def test_parse_ts_accepts_an_explicit_offset():
    """#10: rstrip('Z') left '+00:00' unparseable."""
    assert replay.parse_ts("2026-09-11T05:00:00+00:00") == \
        datetime(2026, 9, 11, 5, 0, 0, tzinfo=timezone.utc)


def test_parse_ts_normalises_a_non_utc_offset():
    assert replay.parse_ts("2026-09-11T00:00:00-05:00") == \
        datetime(2026, 9, 11, 5, 0, 0, tzinfo=timezone.utc)


def test_parse_ts_accepts_seconds_precision():
    assert replay.parse_ts("2026-09-11T05:00:00Z") == \
        datetime(2026, 9, 11, 5, 0, 0, tzinfo=timezone.utc)


def test_parse_ts_rejects_an_empty_timestamp():
    """#10: a missing ts used to raise ValueError('')."""
    with pytest.raises(ValueError, match="empty timestamp"):
        replay.parse_ts("")


def test_parse_ts_rejects_nonsense():
    with pytest.raises(ValueError, match="unparseable"):
        replay.parse_ts("yesterday")


# ---------------------------------------------------------------------------
# Bound validation (#3)
# ---------------------------------------------------------------------------

def test_space_separated_bound_filters_instead_of_being_ignored(tmp_path):
    """#3: '--from 2026-09-11 05:00' used to silently replay the whole log.

    Python's fromisoformat accepts a space separator, so rather than rejecting
    the value we now honour it — the important part is that it filters instead
    of being compared as a raw string (' ' < 'T', which disabled the window).
    """
    write_log(tmp_path, "2026-09-11T04", [rec("2026-09-11T04:00:00.0Z")])
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:30:00.0Z")])
    got = list(replay.iter_messages(str(tmp_path), "2026-09-11 05:00", None))
    assert [m[0] for m in got] == ["2026-09-11T05:30:00.0Z"]


def test_a_malformed_bound_is_rejected_rather_than_ignored():
    """#3: fail closed instead of silently replaying everything."""
    for bad in ("11/09/2026", "yesterday", "2026-13-45T99:00:00Z", ""):
        with pytest.raises(replay.ReplayError):
            replay.parse_bound(bad, "--from")


def test_bound_error_explains_the_expected_format():
    with pytest.raises(replay.ReplayError, match="ISO-8601"):
        replay.parse_bound("11/09/2026", "--to")


def test_absent_bound_is_allowed():
    assert replay.parse_bound(None, "--from") is None


def test_valid_bound_is_parsed():
    assert replay.parse_bound("2026-09-11T05:00:00Z", "--from") == \
        datetime(2026, 9, 11, 5, 0, 0, tzinfo=timezone.utc)


def test_reversed_window_is_rejected(tmp_path):
    args = replay.build_parser().parse_args(
        ["--log-dir", str(tmp_path), "--from", "2026-09-11T06:00:00Z",
         "--to", "2026-09-11T05:00:00Z"])
    with pytest.raises(replay.ReplayError, match="must be after"):
        replay.run(args)


# ---------------------------------------------------------------------------
# Reading and filtering
# ---------------------------------------------------------------------------

def write_log(tmp_path, hour, records):
    path = tmp_path / f"{hour}.ndjson"
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    return path


def rec(ts, topic="ebus/5/a", payload="1", **extra):
    return {"ts": ts, "topic": topic, "payload": payload, **extra}


def test_reads_every_record_when_unfiltered(tmp_path):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z"),
                                          rec("2026-09-11T05:30:00.0Z")])
    write_log(tmp_path, "2026-09-11T06", [rec("2026-09-11T06:00:00.0Z")])
    assert len(list(replay.iter_messages(str(tmp_path)))) == 3


def test_records_are_yielded_in_chronological_order(tmp_path):
    write_log(tmp_path, "2026-09-11T23", [rec("2026-09-11T23:00:00.0Z")])
    write_log(tmp_path, "2026-09-12T00", [rec("2026-09-12T00:00:00.0Z")])
    write_log(tmp_path, "2026-09-11T09", [rec("2026-09-11T09:00:00.0Z")])
    got = [m[0] for m in replay.iter_messages(str(tmp_path))]
    assert got == sorted(got)


def test_from_bound_is_inclusive(tmp_path):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.000000Z"),
                                          rec("2026-09-11T05:00:01.000000Z")])
    got = list(replay.iter_messages(str(tmp_path), "2026-09-11T05:00:00.000000Z", None))
    assert len(got) == 2


def test_to_bound_is_exclusive(tmp_path):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.000000Z"),
                                          rec("2026-09-11T05:00:01.000000Z")])
    got = list(replay.iter_messages(str(tmp_path), None, "2026-09-11T05:00:01.000000Z"))
    assert [m[0] for m in got] == ["2026-09-11T05:00:00.000000Z"]


def test_window_selects_only_the_requested_range(tmp_path):
    write_log(tmp_path, "2026-09-11T04", [rec("2026-09-11T04:59:59.0Z")])
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z"),
                                          rec("2026-09-11T05:59:59.0Z")])
    write_log(tmp_path, "2026-09-11T06", [rec("2026-09-11T06:00:00.0Z")])
    got = list(replay.iter_messages(str(tmp_path), "2026-09-11T05:00:00Z",
                                    "2026-09-11T06:00:00Z"))
    assert len(got) == 2


def test_hour_prefilter_does_not_drop_edge_records(tmp_path):
    """A bound inside an hour must still read that whole hour's file."""
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z"),
                                          rec("2026-09-11T05:59:59.0Z")])
    got = list(replay.iter_messages(str(tmp_path), "2026-09-11T05:30:00Z", None))
    assert [m[0] for m in got] == ["2026-09-11T05:59:59.0Z"]


def test_offset_form_bound_filters_correctly(tmp_path):
    """String comparison mis-handled '+00:00'; datetime comparison does not."""
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.000000Z"),
                                          rec("2026-09-11T05:00:02.000000Z")])
    got = list(replay.iter_messages(str(tmp_path), "2026-09-11T05:00:01+00:00", None))
    assert [m[0] for m in got] == ["2026-09-11T05:00:02.000000Z"]


def test_malformed_lines_are_skipped_and_counted(tmp_path):
    path = tmp_path / "2026-09-11T05.ndjson"
    path.write_text(json.dumps(rec("2026-09-11T05:00:00.0Z")) + "\n"
                    + "{not json\n"
                    + json.dumps(rec("2026-09-11T05:00:01.0Z")) + "\n")
    stats = replay.ReadStats()
    got = list(replay.iter_messages(str(tmp_path), stats=stats))
    assert len(got) == 2
    assert stats.malformed == 1


def test_a_truncated_final_line_does_not_lose_the_rest(tmp_path):
    """A crash mid-write leaves a partial line; the file is still replayable."""
    path = tmp_path / "2026-09-11T05.ndjson"
    path.write_text(json.dumps(rec("2026-09-11T05:00:00.0Z")) + "\n"
                    + '{"ts":"2026-09-11T05:00:01.0Z","top')
    stats = replay.ReadStats()
    assert len(list(replay.iter_messages(str(tmp_path), stats=stats))) == 1
    assert stats.malformed == 1


def test_records_with_an_unusable_ts_are_reported_when_filtering(tmp_path):
    write_log(tmp_path, "2026-09-11T05", [rec(""), rec("2026-09-11T05:00:00.0Z")])
    stats = replay.ReadStats()
    got = list(replay.iter_messages(str(tmp_path), "2026-09-11T05:00:00Z", None, stats))
    assert len(got) == 1
    assert stats.unparsable_ts == 1


def test_records_with_an_unusable_ts_are_still_replayed_when_unfiltered(tmp_path):
    """Without a window there is no reason to drop data."""
    write_log(tmp_path, "2026-09-11T05", [rec(""), rec("2026-09-11T05:00:00.0Z")])
    assert len(list(replay.iter_messages(str(tmp_path)))) == 2


def test_records_without_a_topic_are_skipped(tmp_path):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z", topic="")])
    stats = replay.ReadStats()
    assert list(replay.iter_messages(str(tmp_path), stats=stats)) == []
    assert stats.no_topic == 1


def test_base64_payloads_are_decoded_back_to_bytes(tmp_path):
    """#12: a base64 payload must be republished as the original bytes."""
    raw = b"\xff\xfe\x00"
    write_log(tmp_path, "2026-09-11T05", [
        rec("2026-09-11T05:00:00.0Z", payload=base64.b64encode(raw).decode(), enc="base64")])
    (_ts, _topic, payload, _qos, _retain) = next(iter(replay.iter_messages(str(tmp_path))))
    assert payload == raw


def test_plain_payloads_are_utf8_encoded(tmp_path):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z", payload="21.5°C")])
    (_ts, _topic, payload, _qos, _retain) = next(iter(replay.iter_messages(str(tmp_path))))
    assert payload == "21.5°C".encode()


def test_qos_and_retain_are_read_back(tmp_path):
    write_log(tmp_path, "2026-09-11T05",
              [rec("2026-09-11T05:00:00.0Z", qos=1, retain=True)])
    (_ts, _topic, _payload, qos, retain) = next(iter(replay.iter_messages(str(tmp_path))))
    assert qos == 1 and retain is True


def test_non_log_files_are_ignored(tmp_path):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z")])
    (tmp_path / ".status.json").write_text('{"messages_total": 1}')
    (tmp_path / "notes.txt").write_text("hello")
    assert len(list(replay.iter_messages(str(tmp_path)))) == 1


def test_a_rescued_log_is_replayable(tmp_path):
    """Salvaged files are kept by the logger, so replay must read them too."""
    write_log(tmp_path, "2026-09-10T22-rescued", [rec("2026-09-10T22:00:00.0Z")])
    assert len(list(replay.iter_messages(str(tmp_path)))) == 1


# ---------------------------------------------------------------------------
# Dry-run summary (#16)
# ---------------------------------------------------------------------------

def test_summary_reports_the_first_record_even_with_an_empty_ts(tmp_path):
    """#16: `first = first or ts` skipped a leading record with an empty ts."""
    write_log(tmp_path, "2026-09-11T05", [rec(""), rec("2026-09-11T05:00:01.0Z")])
    summary = replay.summarize(replay.iter_messages(str(tmp_path)))
    assert summary["messages"] == 2
    assert summary["first"] == ""


def test_summary_counts_messages_and_topics(tmp_path):
    write_log(tmp_path, "2026-09-11T05", [
        rec("2026-09-11T05:00:00.0Z", topic="a"),
        rec("2026-09-11T05:00:01.0Z", topic="b"),
        rec("2026-09-11T05:00:02.0Z", topic="a")])
    summary = replay.summarize(replay.iter_messages(str(tmp_path)))
    assert summary["messages"] == 3 and summary["topics"] == 2
    assert summary["last"] == "2026-09-11T05:00:02.0Z"


def test_dry_run_is_the_default_and_publishes_nothing(tmp_path, capsys):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z")])
    assert replay.main(["--log-dir", str(tmp_path)]) == 0
    assert "DRY RUN" in capsys.readouterr().out


def test_publish_requires_a_host(tmp_path, capsys):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z")])
    assert replay.main(["--log-dir", str(tmp_path), "--publish"]) == 2
    assert "requires --host" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Panel guard (#3)
# ---------------------------------------------------------------------------

def test_target_matching_the_panel_hostname_is_refused():
    assert replay.is_panel_target("panel.local", {"panel.local"}, set()) is True


def test_hostname_match_is_case_insensitive():
    assert replay.is_panel_target("Panel.LOCAL", {"panel.local"}, set()) is True


def test_target_resolving_to_the_panel_ip_is_refused(monkeypatch):
    monkeypatch.setattr(replay, "resolve_all", lambda h: {"10.77.0.5"})
    assert replay.is_panel_target("some-alias", set(), {"10.77.0.5"}) is True


def test_unrelated_target_is_allowed(monkeypatch):
    monkeypatch.setattr(replay, "resolve_all", lambda h: {"10.0.0.5"})
    assert replay.is_panel_target("mosquitto", {"panel.local"}, {"10.77.0.5"}) is False


def test_empty_host_is_not_the_panel():
    assert replay.is_panel_target("", {"panel.local"}, set()) is False


def test_publishing_to_the_panel_is_refused(tmp_path, monkeypatch, capsys):
    write_log(tmp_path, "2026-09-11T05", [rec("2026-09-11T05:00:00.0Z")])
    monkeypatch.setattr(replay, "panel_identity", lambda *a, **kw: ({"panel.local"}, set()))
    code = replay.main(["--log-dir", str(tmp_path), "--publish", "--host", "panel.local"])
    assert code == 2
    err = capsys.readouterr().err
    assert "refusing to publish" in err and "electrical panel" in err


def test_the_panel_override_flag_exists():
    args = replay.build_parser().parse_args(["--i-really-mean-the-panel"])
    assert args.allow_panel is True


def test_panel_identity_reads_the_env_file(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# comment\nPANEL_HOST=span-x.local\nPANEL_IP=10.77.0.5\n")
    monkeypatch.setenv("ENV_FILE", str(env))
    monkeypatch.setenv("CONFIG_FILE", str(tmp_path / "nope.yml"))
    monkeypatch.delenv("PANEL_HOST", raising=False)
    monkeypatch.delenv("PANEL_IP", raising=False)
    monkeypatch.setattr(replay, "resolve_all", lambda h: set())
    names, ips = replay.panel_identity()
    assert "span-x.local" in names and "10.77.0.5" in ips


def test_panel_identity_reads_the_config_file(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yml"
    cfg.write_text('mqtt:\n  server: "span-y.local"\n')
    monkeypatch.setenv("ENV_FILE", str(tmp_path / "none.env"))
    monkeypatch.delenv("PANEL_HOST", raising=False)
    monkeypatch.setattr(replay, "resolve_all", lambda h: set())
    names, _ips = replay.panel_identity(str(cfg))
    assert "span-y.local" in names


# ---------------------------------------------------------------------------
# Publish accounting (#1)
# ---------------------------------------------------------------------------

class FakeInfo:
    def __init__(self, mid, rc=0):
        self.mid = mid
        self.rc = rc


class FakeClient:
    """A paho stand-in that mimics the behaviours that caused silent loss."""

    def __init__(self, rcs=None, auto_ack=True):
        self.published = []
        self.on_publish = None
        self._mid = 0
        self._rcs = list(rcs or [])
        self.auto_ack = auto_ack

    def publish(self, topic, payload, qos=0, retain=False):
        self._mid += 1
        rc = self._rcs.pop(0) if self._rcs else 0
        info = FakeInfo(self._mid, rc)
        if rc == 0 or rc == 4 and qos != 0:
            self.published.append((topic, payload, qos, retain))
            if self.auto_ack and self.on_publish:
                self.on_publish(self, None, self._mid, None, None)
        return info


def test_publisher_counts_only_confirmed_deliveries():
    """#1: the old code printed a success count that was a lie."""
    client = FakeClient()
    pub = replay.Publisher(client, qos=1)
    for i in range(5):
        pub.publish(f"t/{i}", b"x")
    assert pub.drain(timeout=2) is True
    assert pub.delivered == 5 and pub.attempted == 5


def test_unconfirmed_messages_are_not_counted_as_delivered():
    client = FakeClient(auto_ack=False)
    pub = replay.Publisher(client, qos=1)
    pub.publish("t", b"x")
    assert pub.drain(timeout=0.2) is False
    assert pub.delivered == 0


def test_queue_size_refusal_is_retried_not_dropped():
    """#1: a refused publish must never be silently discarded."""
    import paho.mqtt.client as mqtt
    client = FakeClient(rcs=[mqtt.MQTT_ERR_QUEUE_SIZE, mqtt.MQTT_ERR_QUEUE_SIZE, 0])
    pub = replay.Publisher(client, qos=1)
    assert pub.publish("t", b"x") is True
    assert pub.drain(timeout=2) is True
    assert pub.delivered == 1
    assert len(client.published) == 1


def test_no_conn_at_qos1_is_queued_not_lost():
    """paho keeps a QoS 1 message and resends it on the next CONNACK."""
    import paho.mqtt.client as mqtt
    client = FakeClient(rcs=[mqtt.MQTT_ERR_NO_CONN])
    pub = replay.Publisher(client, qos=1)
    assert pub.publish("t", b"x") is True
    assert pub.refused == 0


def test_no_conn_at_qos0_is_reported_as_lost():
    """#1: at QoS 0 paho discards the message outright."""
    import paho.mqtt.client as mqtt
    client = FakeClient(rcs=[mqtt.MQTT_ERR_NO_CONN])
    pub = replay.Publisher(client, qos=0)
    assert pub.publish("t", b"x") is False
    assert pub.refused == 1
    assert "dropped while disconnected" in pub.errors[0]


def test_an_invalid_topic_is_reported_not_fatal():
    class Rejecting(FakeClient):
        def publish(self, topic, payload, qos=0, retain=False):
            raise ValueError("Invalid topic.")

    pub = replay.Publisher(Rejecting(), qos=1)
    assert pub.publish("bad/#", b"x") is False
    assert pub.refused == 1


def test_publisher_bounds_the_number_of_in_flight_messages():
    """#1: an unbounded publish loop needed >400 MB for a day of messages."""
    client = FakeClient(auto_ack=False)
    pub = replay.Publisher(client, qos=1, max_queued=3)
    for _ in range(3):
        pub.publish("t", b"x")
    assert pub.in_flight == 3

    import threading
    done = threading.Event()
    threading.Thread(target=lambda: (pub.publish("t", b"x"), done.set()), daemon=True).start()
    assert not done.wait(0.3), "publish should block while the queue is full"
    # Draining one slot lets the blocked publish through.
    pub._on_publish(client, None, 1, None, None)
    assert done.wait(2), "publish should resume once a slot frees up"


def test_publisher_uses_qos1_by_default():
    client = FakeClient()
    pub = replay.Publisher(client)
    pub.publish("t", b"x")
    assert client.published[0][2] == 1


def test_retain_is_not_preserved_unless_asked():
    args = replay.build_parser().parse_args([])
    assert args.preserve_retain is False


def test_module_imports_no_unused_glob():
    """#15: the unused glob import is gone."""
    assert not hasattr(replay, "glob")


# ---------------------------------------------------------------------------
# End-to-end: what the logger writes, replay must reproduce byte for byte
# ---------------------------------------------------------------------------

PAYLOADS = [
    b"1234.5",
    b"",
    b'{"json":"value","n":1}',
    b"line1\nline2",                 # a newline must not break NDJSON framing
    b'quote" backslash\\ tab\t',
    "unicode °C ✓".encode(),
    b"\x00\x01\xff\xfe",             # not valid UTF-8
    bytes(range(256)),
]


@pytest.mark.parametrize("raw", PAYLOADS)
def test_payload_round_trips_from_logger_to_replay(tmp_path, raw):
    import mqttlog
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    recorder = mqttlog.Recorder(log)
    recorder.record("ebus/5/round/trip", raw, ts="2026-09-11T05:00:00.000000Z")
    log.close()

    messages = list(replay.iter_messages(str(tmp_path)))
    assert len(messages) == 1, "one record in, one record out"
    _ts, topic, payload, _qos, _retain = messages[0]
    assert topic == "ebus/5/round/trip"
    assert payload == raw


def test_many_messages_round_trip_in_order(tmp_path):
    import mqttlog
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=25)
    recorder = mqttlog.Recorder(log)
    for i in range(500):
        recorder.record(f"ebus/5/c/{i % 10}", str(i).encode(),
                        ts=f"2026-09-11T05:{i // 60:02d}:{i % 60:02d}.000000Z")
    log.close()
    got = [p.decode() for _ts, _t, p, _q, _r in replay.iter_messages(str(tmp_path))]
    assert got == [str(i) for i in range(500)]


def test_a_topic_containing_odd_characters_round_trips(tmp_path):
    import mqttlog
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    recorder = mqttlog.Recorder(log)
    topic = "ebus/5/dev ice/with-dash_and.dot/°"
    recorder.record(topic, b"v", ts="2026-09-11T05:00:00.000000Z")
    log.close()
    assert next(iter(replay.iter_messages(str(tmp_path))))[1] == topic
