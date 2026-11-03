"""Shared screens: frames the Debrief Recorder kept of the meeting app's window,
saved beside the audio as screens/<ms>.jpg. Each is read with Tesseract; the
ones with enough text, and not a repeat of the one before, are stored for the
meeting page, the notes and the summary. The rest are deleted.
"""

from __future__ import annotations

import csv
import logging
import shutil
import subprocess
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable

log = logging.getLogger("debrief.screens")

DIR = "screens"
# Fewer words than this is a video grid, names under faces, or an app's own buttons.
MIN_WORDS = 12
MIN_CONFIDENCE = 60
# This similar to the screen kept before it is the same slide, scrolled or with a cursor moved.
SAME = 0.85


def read_text(path: Path) -> str:
    """The words Tesseract is fairly sure of, line by line."""
    out = subprocess.run(["tesseract", str(path), "stdout", "--psm", "3", "tsv"], capture_output=True, text=True, timeout=120, check=True).stdout
    lines: dict[tuple[str, str, str, str], list[str]] = {}
    for row in csv.DictReader(out.splitlines(), delimiter="\t", quoting=csv.QUOTE_NONE):
        word = (row.get("text") or "").strip()
        try:
            conf = float(row.get("conf") or -1)
        except ValueError:
            continue
        if row.get("level") != "5" or conf < MIN_CONFIDENCE or not any(c.isalnum() for c in word):
            continue
        lines.setdefault((row["page_num"], row["block_num"], row["par_num"], row["line_num"]), []).append(word)
    return "\n".join(" ".join(words) for words in lines.values())


def keep(frames: list[tuple[float, Path]], read: Callable[[Path], str] = read_text) -> tuple[list[tuple[float, Path, str]], list[Path]]:
    """The frames worth keeping with their text, and the ones to delete."""
    kept: list[tuple[float, Path, str]] = []
    dropped: list[Path] = []
    last = ""
    for at, path in frames:
        try:
            text = read(path)
        except (OSError, subprocess.SubprocessError) as err:
            log.warning("Couldn't read %s: %s", path.name, err)
            continue
        if len(text.split()) < MIN_WORDS or (last and SequenceMatcher(None, last, text, autojunk=False).ratio() >= SAME):
            dropped.append(path)
            continue
        kept.append((at, path, text))
        last = text
    return kept, dropped


def frames_in(folder: Path) -> list[tuple[float, Path]]:
    return sorted((int(p.stem) / 1000, p) for p in folder.glob("*.jpg") if p.stem.isdigit())


def store(conn, rec_id, rel: str, recordings_dir: Path) -> int:
    """Reads a recording's shared screens and stores the ones with text. Returns how many."""
    folder = recordings_dir / Path(rel).parent / DIR
    if not folder.is_dir():
        return 0
    if shutil.which("tesseract") is None:
        log.warning("Tesseract isn't installed, so the shared screens of %s aren't read", rel)
        return 0
    kept, dropped = keep(frames_in(folder))
    with conn.transaction():
        conn.execute("delete from screens where recording_id = %s", (rec_id,))
        for at, path, text in kept:
            conn.execute(
                "insert into screens (recording_id, at_secs, file_path, text) values (%s, %s, %s, %s)",
                (rec_id, round(at, 2), path.relative_to(recordings_dir).as_posix(), text),
            )
    for path in dropped:
        path.unlink(missing_ok=True)
    log.info("Shared screens of %s: kept %d of %d", rel, len(kept), len(kept) + len(dropped))
    return len(kept)
