"""Putting diarized speaker turns onto transcribed words."""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Turn:
    start: float
    end: float
    speaker: str


class SpeakerIndex:
    """Who was speaking at a moment, from a list of diarized turns."""

    def __init__(self, turns: list[Turn]):
        self.turns = sorted(turns, key=lambda t: t.start)
        self.starts = [t.start for t in self.turns]

    def at(self, start: float, end: float) -> str | None:
        """The speaker with the most overlap with [start, end], or the nearest turn when none overlaps."""
        if not self.turns:
            return None
        best, best_overlap = None, 0.0
        i = max(0, bisect_right(self.starts, start) - 1)
        while i < len(self.turns) and self.turns[i].start <= end:
            t = self.turns[i]
            overlap = min(end, t.end) - max(start, t.start)
            if overlap > best_overlap:
                best, best_overlap = t.speaker, overlap
            i += 1
        if best is not None:
            return best
        mid = (start + end) / 2
        return min(self.turns, key=lambda t: min(abs(t.start - mid), abs(t.end - mid))).speaker


def split_by_speaker(segments: list[dict], words_per_segment: list[list[Word]], turns: list[Turn]) -> list[dict]:
    """Whisper's segments, split wherever the speaker changes mid-segment.

    Each word gets the speaker talking over most of it; runs of words with the
    same speaker become one segment. Segments without word timings keep their
    own bounds and get the speaker who overlaps them most.
    """
    index = SpeakerIndex(turns)
    out: list[dict] = []
    for seg, words in zip(segments, words_per_segment):
        if not words:
            out.append({**seg, "speaker": index.at(seg["start"], seg["end"])})
            continue
        run: list[Word] = []
        run_speaker: str | None = None
        for w in words:
            sp = index.at(w.start, w.end)
            if run and sp != run_speaker:
                out.append(_segment(run, run_speaker))
                run = []
            run.append(w)
            run_speaker = sp
        if run:
            out.append(_segment(run, run_speaker))
    return merge_adjacent(out)


def _segment(words: list[Word], speaker: str | None) -> dict:
    return {
        "speaker": speaker,
        "start": round(words[0].start, 2),
        "end": round(words[-1].end, 2),
        "text": "".join(w.text for w in words).strip(),
    }


def merge_adjacent(segments: list[dict], max_gap: float = 1.5, max_len: float = 60.0) -> list[dict]:
    """Joins back-to-back segments from the same speaker into readable turns."""
    out: list[dict] = []
    for s in segments:
        if not s["text"]:
            continue
        prev = out[-1] if out else None
        if (
            prev
            and prev["speaker"] == s["speaker"]
            and s["start"] - prev["end"] <= max_gap
            and s["end"] - prev["start"] <= max_len
        ):
            prev["end"] = s["end"]
            prev["text"] = f"{prev['text']} {s['text']}".strip()
        else:
            out.append(dict(s))
    return out
