"""The transcription worker: scan the recordings folder, transcribe what's new, store it.

The folder is scanned on a timer rather than watched: inotify sees nothing
written to an NFS export by another machine (the NAS), so events would miss
every recording synced from a laptop.
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import threading
import time
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from .config import Config
from .files import Found, device_for, local_tz, meeting_name, read_sidecar, recorded_at, walk_audio
from .transcribe import Transcriber

log = logging.getLogger("debrief")
stop = threading.Event()


def probe_duration(path: Path) -> float | None:
    try:
        import av

        with av.open(str(path)) as c:
            if c.duration:
                return c.duration / 1_000_000
            stream = next((s for s in c.streams if s.type == "audio"), None)
            if stream and stream.duration and stream.time_base:
                return float(stream.duration * stream.time_base)
    except Exception as err:  # noqa: BLE001
        log.debug("Couldn't read the length of %s: %s", path, err)
    return None


def connect(cfg: Config) -> psycopg.Connection:
    for attempt in range(1, 61):
        try:
            conn = psycopg.connect(cfg.database_url, autocommit=True)
            conn.execute("select 1 from recordings limit 1")
            return conn
        except psycopg.Error as err:
            if attempt == 1:
                log.info("Waiting for the database and its schema (the web container migrates it)… %s", str(err).strip())
            if stop.wait(2):
                raise SystemExit(0)
    raise SystemExit("The database never became ready.")


class Scanner:
    """Registers finished audio files as pending recordings."""

    def __init__(self, cfg: Config, conn: psycopg.Connection):
        self.cfg = cfg
        self.conn = conn
        self.tz = local_tz()
        self.seen_sizes: dict[str, int] = {}

    def ready(self, f: Found) -> tuple[bool, object]:
        meta = read_sidecar(f.path)
        if meta is not None:
            # A recorder that died mid-meeting never says "completed": transcribe what arrived.
            abandoned = not meta.finished and time.time() - f.mtime >= self.cfg.abandon_hours * 3600
            if abandoned:
                log.warning("%s still says it's recording but hasn't changed in %g h; transcribing what's there", f.rel, self.cfg.abandon_hours)
            return meta.finished or abandoned, meta
        # No sidecar: wait until the file has stopped growing.
        stable = self.seen_sizes.get(f.rel) == f.size and time.time() - f.mtime >= self.cfg.stable_seconds
        self.seen_sizes[f.rel] = f.size
        return stable, None

    def scan(self) -> int:
        if not self.cfg.audio_dir.is_dir():
            log.warning("The recordings folder %s isn't there (is the NAS mounted?)", self.cfg.audio_dir)
            return 0
        known = {r[0] for r in self.conn.execute("select file_path from recordings")}
        added = 0
        for f in walk_audio(self.cfg.audio_dir, self.cfg.extensions):
            if f.rel in known or stop.is_set():
                continue
            ok, meta = self.ready(f)
            if not ok:
                continue
            duration = getattr(meta, "duration", None) or probe_duration(f.path)
            started = recorded_at(f, meta, duration, self.tz)  # type: ignore[arg-type]
            title = getattr(meta, "name", None) or meeting_name(f.rel)
            self.conn.execute(
                """insert into recordings (file_path, file_size, duration_secs, recorded_at, device, title_hint, status)
                   values (%s, %s, %s, %s, %s, %s, 'pending') on conflict (file_path) do nothing""",
                (f.rel, f.size, round(duration) if duration else None, started, device_for(f.rel), title),
            )
            self.seen_sizes.pop(f.rel, None)
            log.info("New recording: %s (%s)", f.rel, started.isoformat())
            added += 1
        return added


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "recording"


class Worker:
    def __init__(self, cfg: Config, conn: psycopg.Connection):
        self.cfg = cfg
        self.conn = conn
        self.engine = Transcriber(cfg)

    def claim(self):
        return self.conn.execute(
            """update recordings set status = 'processing', progress = 0, error = null
               where id = (select id from recordings where status = 'pending'
                           order by recorded_at desc limit 1 for update skip locked)
               returning id, file_path, recorded_at, title_hint"""
        ).fetchone()

    def export(self, rec_id, rel: str, started: datetime, title: str | None, result) -> None:
        if not self.cfg.export_dir:
            return
        day = started.astimezone(local_tz()).strftime("%Y-%m-%d")
        folder = self.cfg.export_dir / day
        folder.mkdir(parents=True, exist_ok=True)
        base = folder / f"{slug(title or Path(rel).parent.name or Path(rel).stem)}-{str(rec_id)[:8]}"
        base.with_suffix(".txt").write_text(result.text + "\n", "utf-8")
        base.with_suffix(".json").write_text(
            json.dumps(
                {
                    "recording": rel,
                    "recorded_at": started.isoformat(),
                    "language": result.language,
                    "model": result.model,
                    "duration": result.duration,
                    "segments": result.segments,
                },
                indent=2,
            ),
            "utf-8",
        )

    def process(self, row) -> None:
        rec_id, rel, started, title = row
        path = self.cfg.audio_dir / rel
        log.info("Transcribing %s…", rel)
        t0 = time.monotonic()

        def progress(p: float):
            self.conn.execute("update recordings set progress = %s where id = %s", (round(p, 3), rec_id))

        try:
            if not path.is_file():
                raise FileNotFoundError(f"{rel} is no longer in the recordings folder")
            result = self.engine.run(path, progress)
            with self.conn.transaction():
                tid = self.conn.execute(
                    """insert into transcripts (recording_id, content, speaker_segments, language, model_version, processed_at)
                       values (%s, %s, %s, %s, %s, now())
                       on conflict (recording_id) do update set content = excluded.content,
                         speaker_segments = excluded.speaker_segments, language = excluded.language,
                         model_version = excluded.model_version, processed_at = now()
                       returning id""",
                    (rec_id, result.text, Jsonb(result.segments), result.language, result.model),
                ).fetchone()[0]
                self.conn.execute(
                    """update recordings set status = 'done', progress = 1, duration_secs = %s, waveform = %s, error = null
                       where id = %s""",
                    (round(result.duration), Jsonb(result.peaks), rec_id),
                )
            # calendar-sync listens and links the transcript to its meeting straight away.
            self.conn.execute("select pg_notify('debrief_transcribed', %s)", (str(tid),))
            try:
                self.export(rec_id, rel, started, title, result)
            except OSError as err:
                log.warning("Couldn't write the export for %s: %s", rel, err)
            log.info("Done: %s, %d segments in %.0fs", rel, len(result.segments), time.monotonic() - t0)
        except Exception as err:  # noqa: BLE001
            log.exception("Failed: %s", rel)
            self.conn.execute(
                "update recordings set status = 'error', progress = null, error = %s where id = %s",
                (str(err)[:1000], rec_id),
            )


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    cfg = Config.from_env()
    log.info(
        "Watching %s every %.0fs; model %s on %s; speaker labels %s",
        cfg.audio_dir, cfg.scan_interval, cfg.model, cfg.device, "on" if cfg.diarize else "off",
    )
    conn = connect(cfg)
    # One transcriber per database: anything left mid-way by a restart starts over.
    conn.execute("update recordings set status = 'pending', progress = null where status = 'processing'")
    scanner = Scanner(cfg, conn)
    worker = Worker(cfg, conn)
    once = os.environ.get("RUN_ONCE") == "1"

    while not stop.is_set():
        try:
            scanner.scan()
            while not stop.is_set() and (row := worker.claim()):
                worker.process(row)
                scanner.scan()
        except psycopg.OperationalError as err:
            log.error("Lost the database: %s; reconnecting", err)
            conn = connect(cfg)
            scanner.conn = worker.conn = conn
        if once:
            break
        stop.wait(cfg.scan_interval)
    log.info("Stopped.")


if __name__ == "__main__":
    main()
