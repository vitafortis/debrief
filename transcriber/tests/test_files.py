import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from debrief_transcriber.files import (
    Found,
    device_for,
    meeting_name,
    read_sidecar,
    recorded_at,
    walk_audio,
)

CHI = ZoneInfo("America/Chicago")


def test_device_is_the_first_non_date_folder():
    assert device_for("mac-work/Standup_2026-10-22_14-03/audio.mp4") == "mac-work"
    assert device_for("2026-10-22/win-desktop/call.wav") == "win-desktop"
    assert device_for("2026-10-22/call.wav") is None
    assert device_for("Standup_2026-10-22_14-03/audio.mp4") is None


def test_meeting_name_from_meetily_folder():
    assert meeting_name("mac-work/Q4_planning_2026-10-22_14-03/audio.mp4") == "Q4 planning"
    assert meeting_name("call.wav") is None


def test_walk_skips_checkpoints_and_partials(tmp_path):
    (tmp_path / "m" / ".checkpoints").mkdir(parents=True)
    (tmp_path / "m" / ".checkpoints" / "chunk_0001.mp4").write_bytes(b"x")
    (tmp_path / "m" / "audio.mp4").write_bytes(b"x")
    (tmp_path / "m" / "notes.txt").write_text("x")
    (tmp_path / "m" / "big.wav.part").write_bytes(b"x")
    assert [f.rel for f in walk_audio(tmp_path, {".mp4", ".wav"})] == ["m/audio.mp4"]


def test_sidecar_says_when_meetily_is_done(tmp_path):
    folder = tmp_path / "Standup_2026-10-22_14-03"
    folder.mkdir()
    (folder / "audio.mp4").write_bytes(b"x")
    meta = {"created_at": "2026-10-22T19:03:11Z", "status": "recording", "meeting_name": "Standup"}
    (folder / "metadata.json").write_text(json.dumps(meta))
    assert read_sidecar(folder / "audio.mp4").finished is False
    meta.update(status="completed", duration_seconds=905.2)
    (folder / "metadata.json").write_text(json.dumps(meta))
    m = read_sidecar(folder / "audio.mp4")
    assert m.finished and m.duration == 905.2 and m.name == "Standup"
    assert m.started_at == datetime(2026, 10, 22, 19, 3, 11, tzinfo=timezone.utc)


def found(rel, mtime=0.0):
    return Found(path=None, rel=rel, size=1, mtime=mtime)  # type: ignore[arg-type]


def test_start_time_from_names_and_mtime():
    # Meetily's own file names are UTC.
    assert recorded_at(found("recording_20261022_190311.mp4"), None, None, CHI) == datetime(2026, 10, 22, 19, 3, 11, tzinfo=timezone.utc)
    # Other names are local time.
    assert recorded_at(found("dev/2026-10-22 14.03 Standup.m4a"), None, None, CHI) == datetime(2026, 10, 22, 14, 3, tzinfo=CHI)
    # No name: the file finished writing at mtime, so it started one length earlier.
    end = datetime(2026, 10, 22, 20, 0, tzinfo=timezone.utc).timestamp()
    assert recorded_at(found("call.wav", end), None, 1800, CHI) == datetime(2026, 10, 22, 19, 30, tzinfo=timezone.utc)


def test_a_recorder_folder_names_its_device(tmp_path):
    # What the upload API writes: <device>/<start>_<id>/audio.opus
    assert device_for("nathans-macbook-pro/2026-10-22_14-00-00_3b8f1c2a/audio.opus") == "nathans-macbook-pro"
    assert meeting_name("nathans-macbook-pro/2026-10-22_14-00-00_3b8f1c2a/audio.opus") is None
