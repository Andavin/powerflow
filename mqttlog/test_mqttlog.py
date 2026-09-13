"""Tests for the rolling MQTT raw-data logger.

Each test names the defect it pins down. The behaviour under test is what the
logger must do, not how it does it.
"""

import json
import os
import time

import pytest

import mqttlog

# ---------------------------------------------------------------------------
# Retention (_prune)
# ---------------------------------------------------------------------------

def hour_file(tmp_path, hour, content="x\n"):
    p = tmp_path / f"{hour}.ndjson"
    p.write_text(content)
    return p


def test_prune_keeps_the_newest_keep_hours_files(tmp_path):
    for h in range(1, 6):
        hour_file(tmp_path, f"2026-09-11T0{h}")
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=3)
    log.write("2026-09-11T06:00:00.000000Z", "ebus/5/a", "1")
    log.close()
    names = sorted(p.name for p in tmp_path.glob("*.ndjson"))
    assert names == ["2026-09-11T04.ndjson", "2026-09-11T05.ndjson", "2026-09-11T06.ndjson"]


def test_keep_hours_zero_is_rejected_instead_of_deleting_the_open_file(tmp_path):
    """#4: KEEP_HOURS=0 used to unlink the hour file it had just opened."""
    with pytest.raises(ValueError, match="keep_hours must be >= 1"):
        mqttlog.RollingLog(str(tmp_path), keep_hours=0)


def test_keep_hours_zero_is_rejected_by_config(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_FILE", str(tmp_path / "missing.yml"))
    monkeypatch.setenv("KEEP_HOURS", "0")
    with pytest.raises(mqttlog.ConfigError, match="KEEP_HOURS must be >= 1"):
        mqttlog.load_config()


def test_current_hour_file_is_never_pruned(tmp_path):
    """#4: writes must never land in an unlinked inode."""
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=1)
    log.write("2026-09-11T05:00:00.000000Z", "ebus/5/a", "1")
    log.prune()
    log.write("2026-09-11T05:00:01.000000Z", "ebus/5/a", "2")
    log.close()
    body = (tmp_path / "2026-09-11T05.ndjson").read_text()
    assert body.count("\n") == 2


def test_prune_ignores_files_it_did_not_create(tmp_path):
    """#8: a log salvaged from an incident must survive pruning forever."""
    rescued = tmp_path / "2026-09-10T22-rescued.ndjson"
    rescued.write_text('{"ts":"2026-09-10T22:00:00.0Z"}\n')
    other = tmp_path / "notes.txt"
    other.write_text("keep me")
    for h in range(1, 4):
        hour_file(tmp_path, f"2026-09-11T0{h}")

    log = mqttlog.RollingLog(str(tmp_path), keep_hours=1)
    log.write("2026-09-11T05:00:00.000000Z", "ebus/5/a", "1")
    log.close()

    assert rescued.exists(), "rescued log was pruned"
    assert other.exists()
    assert not (tmp_path / "2026-09-11T01.ndjson").exists(), "own old file should be pruned"


def test_prune_enforces_a_total_byte_cap(tmp_path):
    """#11: count-based retention alone lets 25 files span far more than 25h."""
    for h in range(1, 6):
        hour_file(tmp_path, f"2026-09-11T0{h}", content="y" * 1000)
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=25, max_total_bytes=2500)
    log.write("2026-09-11T06:00:00.000000Z", "ebus/5/a", "1")
    log.close()
    assert log.total_bytes() <= 2500
    assert (tmp_path / "2026-09-11T06.ndjson").exists()


def test_byte_cap_never_removes_the_current_file(tmp_path):
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=25, max_total_bytes=1)
    log.write("2026-09-11T06:00:00.000000Z", "ebus/5/a", "1")
    log.prune()
    log.close()
    assert (tmp_path / "2026-09-11T06.ndjson").exists()


def test_prune_can_run_on_a_timer_without_a_write(tmp_path):
    """#11: pruning used to happen only on rotation."""
    for h in range(1, 6):
        hour_file(tmp_path, f"2026-09-11T0{h}")
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    removed = log.prune()
    assert len(removed) == 3


def test_hour_files_are_returned_in_chronological_order(tmp_path):
    for name in ["2026-09-11T23", "2026-09-12T00", "2026-09-11T09"]:
        hour_file(tmp_path, name)
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=25)
    assert [p.stem for p in log.hour_files()] == [
        "2026-09-11T09", "2026-09-11T23", "2026-09-12T00"]


# ---------------------------------------------------------------------------
# Writing and durability
# ---------------------------------------------------------------------------

def test_write_produces_one_json_object_per_line(tmp_path):
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    log.write("2026-09-11T05:00:00.000000Z", "ebus/5/x", "42")
    log.write("2026-09-11T05:00:01.000000Z", "ebus/5/y", "43")
    log.close()
    lines = (tmp_path / "2026-09-11T05.ndjson").read_text().splitlines()
    assert [json.loads(x)["topic"] for x in lines] == ["ebus/5/x", "ebus/5/y"]


def test_write_rotates_on_the_hour(tmp_path):
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=25)
    log.write("2026-09-11T05:59:59.000000Z", "t", "a")
    log.write("2026-09-11T06:00:00.000000Z", "t", "b")
    log.close()
    assert (tmp_path / "2026-09-11T05.ndjson").exists()
    assert (tmp_path / "2026-09-11T06.ndjson").exists()


def test_every_record_is_flushed_immediately(tmp_path):
    """A SIGKILL must not lose buffered records."""
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    log.write("2026-09-11T05:00:00.000000Z", "t", "a")
    assert (tmp_path / "2026-09-11T05.ndjson").stat().st_size > 0
    log.close()


def test_fsync_is_batched_not_per_message(tmp_path, monkeypatch):
    """#5: fdatasync at most once per interval, ~0.1% cost instead of per write."""
    calls = []
    monkeypatch.setattr(mqttlog.os, "fdatasync", lambda fd: calls.append(fd))
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2, fsync_interval=10.0)
    for i in range(50):
        log.write(f"2026-09-11T05:00:{i:02d}.000000Z", "t", "a")
        log.sync_if_due()
    assert len(calls) == 1, "should sync once, not per message"
    log.close()


def test_fsync_happens_again_after_the_interval(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(mqttlog.os, "fdatasync", lambda fd: calls.append(fd))
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2, fsync_interval=0.0)
    log.write("2026-09-11T05:00:00.000000Z", "t", "a")
    log.sync_if_due()
    log.write("2026-09-11T05:00:01.000000Z", "t", "b")
    log.sync_if_due()
    assert len(calls) == 2
    log.close()


def test_close_syncs_before_closing(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(mqttlog.os, "fdatasync", lambda fd: calls.append(fd))
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2, fsync_interval=999)
    log.write("2026-09-11T05:00:00.000000Z", "t", "a")
    log.close()
    assert calls, "shutdown must fdatasync"


# ---------------------------------------------------------------------------
# Payload encoding (#12)
# ---------------------------------------------------------------------------

def test_utf8_payload_is_stored_verbatim():
    text, enc = mqttlog.encode_payload("temp=21.5°C".encode())
    assert (text, enc) == ("temp=21.5°C", None)


def test_binary_payload_is_base64_not_replacement_characters():
    """#12: errors='replace' destroyed the bytes irrecoverably."""
    raw = b"\x00\x01\xff\xfe"
    text, enc = mqttlog.encode_payload(raw)
    assert enc == "base64"
    assert "�" not in text
    import base64
    assert base64.b64decode(text) == raw


def test_binary_payload_round_trips_through_the_log(tmp_path):
    import base64
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    rec = mqttlog.Recorder(log)
    rec.record("ebus/5/bin", b"\xff\xfe\x00", ts="2026-09-11T05:00:00.000000Z")
    log.close()
    line = json.loads((tmp_path / "2026-09-11T05.ndjson").read_text())
    assert line["enc"] == "base64"
    assert base64.b64decode(line["payload"]) == b"\xff\xfe\x00"


def test_qos_and_retain_are_recorded_when_non_default(tmp_path):
    """#12: qos/retain were not recorded at all."""
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    log.write("2026-09-11T05:00:00.000000Z", "t", "a", qos=1, retain=True)
    log.close()
    rec = json.loads((tmp_path / "2026-09-11T05.ndjson").read_text())
    assert rec["qos"] == 1 and rec["retain"] is True


def test_default_qos_and_retain_are_omitted_to_keep_lines_small(tmp_path):
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    log.write("2026-09-11T05:00:00.000000Z", "t", "a")
    log.close()
    rec = json.loads((tmp_path / "2026-09-11T05.ndjson").read_text())
    assert "qos" not in rec and "retain" not in rec


# ---------------------------------------------------------------------------
# Write-error policy (#6)
# ---------------------------------------------------------------------------

class ExplodingLog:
    """A RollingLog stand-in whose writes always fail with ENOSPC."""

    log_dir = "/log"

    def __init__(self, exc=None):
        self.exc = exc or OSError(28, "No space left on device")
        self.attempts = 0

    def write(self, *a, **kw):
        self.attempts += 1
        raise self.exc


def test_disk_full_is_fatal_not_an_endless_retry():
    """#6: ENOSPC used to be reported forever as 'connection error'."""
    fatals = []
    rec = mqttlog.Recorder(ExplodingLog(), on_fatal=fatals.append,
                           write_retries=3, retry_delay=0)
    assert rec.record("t", b"x") is False
    assert rec.fatal is not None
    assert "No space left on device" in rec.fatal
    assert fatals, "a fatal write error must stop the process"


def test_write_errors_are_retried_a_bounded_number_of_times():
    log = ExplodingLog()
    rec = mqttlog.Recorder(log, write_retries=3, retry_delay=0)
    rec.record("t", b"x")
    assert log.attempts == 3


def test_a_transient_write_error_does_not_become_fatal(tmp_path):
    class FlakyLog(mqttlog.RollingLog):
        fail_once = True

        def write(self, *a, **kw):
            if self.fail_once:
                self.fail_once = False
                raise OSError(5, "I/O error")
            return super().write(*a, **kw)

    log = FlakyLog(str(tmp_path), keep_hours=2)
    rec = mqttlog.Recorder(log, write_retries=3, retry_delay=0)
    assert rec.record("t", b"x") is True
    assert rec.fatal is None
    assert rec.write_errors == 1
    log.close()


def test_a_programming_error_in_the_write_path_is_fatal_immediately():
    log = ExplodingLog(TypeError("bad record"))
    rec = mqttlog.Recorder(log, write_retries=3, retry_delay=0)
    assert rec.record("t", b"x") is False
    assert log.attempts == 1
    assert "TypeError" in rec.fatal


# ---------------------------------------------------------------------------
# Config / environment precedence (#7)
# ---------------------------------------------------------------------------

def write_config(tmp_path, body):
    p = tmp_path / "config.yml"
    p.write_text(body)
    return p


BASE_CONFIG = """
mqtt:
  server: "panel.local"
  port: 8883
  username: "u"
  password: "p"
  ca_cert: "/config/ca.pem"
span:
  topic_prefix: "ebus/5"
"""


def test_config_file_values_are_used(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_FILE", str(write_config(tmp_path, BASE_CONFIG)))
    cfg = mqttlog.load_config()
    assert cfg["host"] == "panel.local"
    assert cfg["port"] == 8883
    assert cfg["ca_cert"] == "/config/ca.pem"


def test_empty_env_var_clears_a_config_value(monkeypatch, tmp_path):
    """#7: SPAN_MQTT_CA_CERT="" must disable TLS, as it does for the collector."""
    monkeypatch.setenv("CONFIG_FILE", str(write_config(tmp_path, BASE_CONFIG)))
    monkeypatch.setenv("SPAN_MQTT_CA_CERT", "")
    assert mqttlog.load_config()["ca_cert"] == ""


def test_env_var_overrides_a_config_value(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_FILE", str(write_config(tmp_path, BASE_CONFIG)))
    monkeypatch.setenv("SPAN_MQTT_SERVER", "other.host")
    assert mqttlog.load_config()["host"] == "other.host"


def test_unset_env_var_leaves_the_config_value(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_FILE", str(write_config(tmp_path, BASE_CONFIG)))
    monkeypatch.delenv("SPAN_MQTT_SERVER", raising=False)
    assert mqttlog.load_config()["host"] == "panel.local"


def test_malformed_integer_gives_a_clear_message(monkeypatch, tmp_path):
    """#7: a bad KEEP_HOURS produced a bare traceback."""
    monkeypatch.setenv("CONFIG_FILE", str(write_config(tmp_path, BASE_CONFIG)))
    monkeypatch.setenv("KEEP_HOURS", "twelve")
    with pytest.raises(mqttlog.ConfigError, match="KEEP_HOURS: expected an integer"):
        mqttlog.load_config()


def test_default_topic_is_the_broadest_filter_the_broker_grants(monkeypatch, tmp_path):
    """The panel ACL refuses '#'; 'ebus/#' is granted and survives a bus renumber."""
    monkeypatch.setenv("CONFIG_FILE", str(write_config(tmp_path, BASE_CONFIG)))
    monkeypatch.delenv("MQTT_TOPICS", raising=False)
    cfg = mqttlog.load_config()
    assert cfg["topics"] == ["ebus/#"]
    assert cfg["expect_prefix"] == "ebus/5"


def test_topics_can_be_overridden_for_a_future_topology(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_FILE", str(write_config(tmp_path, BASE_CONFIG)))
    monkeypatch.setenv("MQTT_TOPICS", "ebus/#, span/#")
    assert mqttlog.load_config()["topics"] == ["ebus/#", "span/#"]


def test_empty_topics_is_rejected(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_FILE", str(write_config(tmp_path, BASE_CONFIG)))
    monkeypatch.setenv("MQTT_TOPICS", "  ")
    with pytest.raises(mqttlog.ConfigError, match="MQTT_TOPICS is empty"):
        mqttlog.load_config()


# ---------------------------------------------------------------------------
# Subscription refusal (found during this review, not in the original list)
# ---------------------------------------------------------------------------

def test_a_refused_suback_code_is_recognised():
    class RC:
        def __init__(self, v, failure):
            self.value = v
            self.is_failure = failure

    assert mqttlog.rc_is_failure(RC(0x80, True)) is True
    assert mqttlog.rc_is_failure(RC(0, False)) is False
    assert mqttlog.rc_is_failure(0x80) is True
    assert mqttlog.rc_is_failure(0) is False


# ---------------------------------------------------------------------------
# Liveness: heartbeat, status file and healthcheck (#2)
# ---------------------------------------------------------------------------

def test_recorder_tracks_a_window_and_resets_it(tmp_path):
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    rec = mqttlog.Recorder(log, expect_prefix="ebus/5")
    rec.record("ebus/5/a", b"1")
    rec.record("other/b", b"2")
    window = rec.take_window()
    assert window["messages"] == 2
    assert window["expected"] == 1
    assert rec.take_window()["messages"] == 0
    log.close()


def test_status_file_is_written_atomically_and_readable(tmp_path):
    path = mqttlog.status_path(str(tmp_path))
    mqttlog.write_status(path, {"messages_total": 7})
    assert mqttlog.read_status(path)["messages_total"] == 7
    assert not (tmp_path / ".status.json.tmp").exists()


def test_healthy_when_messages_are_flowing():
    now = time.time()
    ok, why = mqttlog.evaluate_health({
        "subscribed": ["ebus/#"], "updated_epoch": now - 5,
        "last_message_epoch": now - 2, "heartbeat_secs": 60, "stale_secs": 300,
    }, now)
    assert ok, why


def test_unhealthy_when_nothing_has_been_recorded():
    """#2: the container used to stay Up while logging zero bytes."""
    now = time.time()
    ok, why = mqttlog.evaluate_health({
        "subscribed": ["ebus/#"], "updated_epoch": now - 5,
        "last_message_epoch": 0, "heartbeat_secs": 60, "stale_secs": 300,
    }, now)
    assert not ok and "ever been recorded" in why


def test_unhealthy_when_the_stream_goes_quiet():
    now = time.time()
    ok, why = mqttlog.evaluate_health({
        "subscribed": ["ebus/#"], "updated_epoch": now - 5,
        "last_message_epoch": now - 400, "heartbeat_secs": 60, "stale_secs": 300,
    }, now)
    assert not ok and "no messages for" in why


def test_unhealthy_when_the_subscription_was_refused():
    now = time.time()
    ok, why = mqttlog.evaluate_health({
        "subscribed": [], "refused": ["#"], "updated_epoch": now - 5,
        "last_message_epoch": now - 1,
    }, now)
    assert not ok and "subscription" in why


def test_unhealthy_when_the_process_stalled():
    now = time.time()
    ok, why = mqttlog.evaluate_health({
        "subscribed": ["ebus/#"], "updated_epoch": now - 3600,
        "last_message_epoch": now - 1, "heartbeat_secs": 60,
    }, now)
    assert not ok and "stalled" in why


def test_unhealthy_with_no_status_file():
    ok, why = mqttlog.evaluate_health(None, time.time())
    assert not ok and "not started" in why


def test_unhealthy_after_a_fatal_write_error():
    now = time.time()
    ok, why = mqttlog.evaluate_health({
        "subscribed": ["ebus/#"], "updated_epoch": now, "last_message_epoch": now,
        "fatal": "cannot write to /log: [Errno 28] No space left on device",
    }, now)
    assert not ok and "Errno 28" in why


def test_healthcheck_entrypoint_returns_nonzero_when_unhealthy(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LOG_DIR", str(tmp_path))
    assert mqttlog.main(["--healthcheck"]) == 1
    assert "not started" in capsys.readouterr().out


def test_healthcheck_entrypoint_returns_zero_when_healthy(tmp_path, monkeypatch, capsys):
    now = time.time()
    mqttlog.write_status(mqttlog.status_path(str(tmp_path)), {
        "subscribed": ["ebus/#"], "updated_epoch": now,
        "last_message_epoch": now, "heartbeat_secs": 60, "stale_secs": 300,
        "messages_total": 123,
    })
    monkeypatch.setenv("LOG_DIR", str(tmp_path))
    assert mqttlog.main(["--healthcheck"]) == 0
    assert "ok" in capsys.readouterr().out


def test_status_file_is_not_mistaken_for_a_log_file(tmp_path):
    """The healthcheck's status file must never be pruned or replayed."""
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=1)
    mqttlog.write_status(mqttlog.status_path(str(tmp_path)), {"a": 1})
    log.write("2026-09-11T05:00:00.000000Z", "t", "a")
    log.prune()
    log.close()
    assert mqttlog.status_path(str(tmp_path)).exists()
    assert [p.name for p in log.hour_files()] == ["2026-09-11T05.ndjson"]


# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------

def test_timestamps_are_utc_with_a_z_suffix():
    ts = mqttlog.utc_now_iso()
    assert ts.endswith("Z")
    assert len(ts) == len("2026-09-11T05:00:00.000000Z")


def test_written_timestamp_determines_the_hour_file(tmp_path):
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=25)
    log.write("2026-12-31T23:59:59.999999Z", "t", "a")
    log.close()
    assert (tmp_path / "2026-12-31T23.ndjson").exists()


# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------

def test_log_directory_is_created_if_missing(tmp_path):
    target = tmp_path / "nested" / "log"
    log = mqttlog.RollingLog(str(target), keep_hours=2)
    log.write("2026-09-11T05:00:00.000000Z", "t", "a")
    log.close()
    assert (target / "2026-09-11T05.ndjson").exists()


def test_module_imports_no_unused_glob():
    """#15: the unused glob import is gone."""
    assert not hasattr(mqttlog, "glob")


def test_write_returns_the_byte_count(tmp_path):
    log = mqttlog.RollingLog(str(tmp_path), keep_hours=2)
    n = log.write("2026-09-11T05:00:00.000000Z", "t", "a")
    log.close()
    assert n == os.path.getsize(tmp_path / "2026-09-11T05.ndjson")


def test_status_file_is_refreshed_more_often_than_the_heartbeat():
    """A healthcheck read between heartbeats must see the real message age."""
    assert mqttlog.DEFAULT_STATUS_SECS < mqttlog.DEFAULT_HEARTBEAT_SECS
    # ...and comfortably inside the staleness threshold it feeds.
    assert mqttlog.DEFAULT_STATUS_SECS < mqttlog.DEFAULT_STALE_SECS
