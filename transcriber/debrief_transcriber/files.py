"""Finding recordings on disk and working out when and where they were made."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

DATE_SEGMENT = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Timestamps recorders put in names: Meetily folders ("Standup_2026-10-22_14-03"),
# Meetily files ("recording_20261022_140311"), and most others.
NAME_TIMESTAMPS = [
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})[-.:](\d{2})(?:[-.:](\d{2}))?"), True),
    (re.compile(r"(\d{4})(\d{2})(\d{2})[_T-]?(\d{2})(\d{2})(\d{2})?"), True),
]


@dataclass
class Found:
    path: Path
    rel: str
    size: int
    mtime: float


@dataclass
class Meta:
    """What a recorder's sidecar file (Meetily's metadata.json) says."""

    finished: bool
    started_at: datetime | None = None
    duration: float | None = None
    name: str | None = None


def walk_audio(root: Path, extensions: set[str]):
    """Audio files under root, skipping hidden folders (Meetily's .checkpoints) and partial files."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith(".") or name.endswith((".part", ".tmp", ".partial")):
                continue
            p = Path(dirpath, name)
            if p.suffix.lower() not in extensions:
                continue
            try:
                st = p.stat()
            except FileNotFoundError:
                continue
            yield Found(path=p, rel=p.relative_to(root).as_posix(), size=st.st_size, mtime=st.st_mtime)


def read_sidecar(path: Path) -> Meta | None:
    """Meetily writes metadata.json beside audio.mp4 and sets status to "completed" when done."""
    meta = path.parent / "metadata.json"
    if not meta.is_file():
        return None
    try:
        data = json.loads(meta.read_text("utf-8"))
    except (OSError, ValueError):
        return Meta(finished=False)
    started = None
    if data.get("created_at"):
        try:
            started = datetime.fromisoformat(str(data["created_at"]).replace("Z", "+00:00"))
        except ValueError:
            pass
    duration = data.get("duration_seconds")
    return Meta(
        finished=data.get("status", "completed") != "recording",
        started_at=started,
        duration=float(duration) if isinstance(duration, (int, float)) else None,
        name=(data.get("meeting_name") or None),
    )


def device_for(rel: str) -> str | None:
    """The device folder a recording synced into: the first folder that isn't a date.

    audio/mac-work/Standup_2026-10-22_14-03/audio.mp4 -> "mac-work"
    audio/2026-10-22/win-desktop/call.wav             -> "win-desktop"
    audio/2026-10-22/call.wav                         -> None
    """
    parts = rel.split("/")[:-1]
    for p in parts:
        if not DATE_SEGMENT.match(p):
            # A Meetily meeting folder is not a device.
            if any(rx.search(p) for rx, _ in NAME_TIMESTAMPS):
                return None
            return p
    return None


def timestamp_from_name(rel: str, tz: ZoneInfo | timezone) -> datetime | None:
    """A start time written in the file or folder name, read in the recorder's time zone."""
    for part in reversed(rel.split("/")):
        stem = part.rsplit(".", 1)[0] if "." in part else part
        for rx, _ in NAME_TIMESTAMPS:
            m = rx.search(stem)
            if not m:
                continue
            y, mo, d, h, mi, s = (int(g) if g else 0 for g in m.groups())
            try:
                return datetime(y, mo, d, h, mi, s, tzinfo=tz)
            except ValueError:
                continue
    return None


def meeting_name(rel: str) -> str | None:
    """"Q4 planning" from Meetily's "Q4_planning_2026-10-22_14-03" folder."""
    parts = rel.split("/")
    if len(parts) < 2:
        return None
    folder = parts[-2]
    m = NAME_TIMESTAMPS[0][0].search(folder)
    if not m:
        return None
    name = folder[: m.start()].strip("_- ").replace("_", " ").strip()
    return name or None


def recorded_at(found: Found, meta: Meta | None, duration: float | None, tz: ZoneInfo | timezone) -> datetime:
    """When the recording started: the sidecar, else the name, else the file's mtime minus its length.

    A file's mtime is when it finished being written, and rsync and Syncthing both keep it.
    Meetily's own file names are UTC; other names are taken in TZ.
    """
    if meta and meta.started_at:
        return meta.started_at
    name = Path(found.rel).name
    from_name = timestamp_from_name(found.rel, timezone.utc if name.startswith("recording_") else tz)
    if from_name:
        return from_name
    end = datetime.fromtimestamp(found.mtime, tz=timezone.utc)
    return end - timedelta(seconds=duration or 0)


def local_tz() -> ZoneInfo | timezone:
    name = os.environ.get("TZ")
    if name:
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return datetime.now().astimezone().tzinfo or timezone.utc  # type: ignore[return-value]
