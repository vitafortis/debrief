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


def split_by_speaker(segments: list[dict], words_per_segment: list[list[Word]], turns: list[Turn], merge: bool = True) -> list[dict]:
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
                out.append(from_words(run, run_speaker))
                run = []
            run.append(w)
            run_speaker = sp
        if run:
            out.append(from_words(run, run_speaker))
    return merge_adjacent(out) if merge else out


def from_words(words: list[Word], speaker: str | None) -> dict:
    return {
        "speaker": speaker,
        "start": round(words[0].start, 2),
        "end": round(words[-1].end, 2),
        "text": "".join(w.text for w in words).strip(),
    }


def is_backchannel(s: dict) -> bool:
    """A short reply like "yeah" or "right": it doesn't take the floor from whoever is talking."""
    return s["end"] - s["start"] <= 1.5 and len(s["text"].split()) <= 3


def ends_sentence(text: str) -> bool:
    return text.rstrip().endswith((".", "?", "!", "…", "。", "？", "！"))


def merge_adjacent(segments: list[dict], max_gap: float = 1.5, soft_len: float = 30.0, max_len: float = 90.0) -> list[dict]:
    """Joins segments from the same speaker into readable turns.

    A turn carries on over a pause of up to max_gap, and over someone else's
    short reply, which stays as its own line. Past soft_len it ends at the next
    sentence end, and at max_len regardless.
    """
    out: list[dict] = []
    for s in sorted((s for s in segments if s["text"]), key=lambda s: s["start"]):
        turn = None
        for prev in reversed(out):
            if prev["speaker"] == s["speaker"]:
                turn = prev
                break
            if not is_backchannel(prev):
                break
        if (
            turn
            and s["start"] - turn["end"] <= max_gap
            and s["end"] - turn["start"] <= max_len
            and not (turn["end"] - turn["start"] >= soft_len and ends_sentence(turn["text"]))
        ):
            turn["end"] = max(turn["end"], s["end"])
            turn["text"] = f"{turn['text']} {s['text']}".strip()
        else:
            out.append(dict(s))
    return out
