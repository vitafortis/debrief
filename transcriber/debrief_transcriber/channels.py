"""Debrief Recorder recordings: your microphone on the left channel, the call on the right.

Transcribing the two sides separately says exactly when you spoke, overlaps
included, without diarization. On speakers instead of headphones the call also
leaks into your microphone, so your side drops whatever repeats the call.
"""

from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher
from pathlib import Path

from .speakers import Word, from_words

log = logging.getLogger("debrief.channels")

SAMPLE_RATE = 16000
# What the upload API names every recording (<device>/<start>_<id>/audio.opus).
RECORDER_FILE = "audio.opus"
ME = "YOU"
THEM = "OTHERS"

FRAME = SAMPLE_RATE // 100  # loudness is compared in 10 ms frames
# A stretch of your side whose loudness follows the call's this closely, a little later, is the call leaking in.
ECHO_CORRELATION = 0.7
ECHO_MAX_LAG = 0.5  # seconds from the call playing to the microphone hearing it
# This many words in a row that the call said at the same moment are the call leaking in, not you repeating it.
ECHO_RUN = 4


def from_recorder(path: Path) -> bool:
    """True for a two-channel file the Debrief Recorder made; anything else is transcribed as one mix."""
    if path.name != RECORDER_FILE:
        return False
    try:
        import av

        with av.open(str(path)) as c:
            stream = next((s for s in c.streams if s.type == "audio"), None)
            return stream is not None and len(stream.layout.channels) == 2
    except Exception as err:  # noqa: BLE001
        log.debug("Couldn't read the channels of %s: %s", path, err)
        return False


def envelope(audio):
    """Loudness per 10 ms frame."""
    import numpy as np

    n = len(audio) // FRAME
    return np.sqrt((audio[: n * FRAME].reshape(n, FRAME) ** 2).mean(axis=1))


def follows_call(start: float, end: float, mine, theirs) -> bool:
    """Whether your side's loudness over [start, end] tracks the call's, up to ECHO_MAX_LAG later."""
    import numpy as np

    i, j = int(start * 100), int(end * 100)
    m = mine[i:j]
    if len(m) < 20 or m.std() == 0:
        return False
    best = 0.0
    # A few frames the other way too: the two sides aren't aligned to the millisecond.
    for lag in range(-5, int(ECHO_MAX_LAG * 100) + 1, 2):
        if i - lag < 0 or j - lag > len(theirs):
            continue
        c = theirs[i - lag : j - lag]
        if c.std() == 0:
            continue
        best = max(best, float(np.corrcoef(m, c)[0, 1]))
    return best >= ECHO_CORRELATION


def _token(text: str) -> str:
    return re.sub(r"[^\w']+", "", text.lower())


def repeated_words(words: list[Word], call_segments: list[dict], pad: float = 1.5) -> set[int]:
    """Indexes of your words that come in runs of ECHO_RUN or more the call said at the same moment."""
    if len(words) < ECHO_RUN:
        return set()
    start, end = words[0].start - pad, words[-1].end + pad
    theirs = [t for s in call_segments if s["end"] >= start and s["start"] <= end for t in map(_token, s["text"].split()) if t]
    mine = [(i, t) for i, w in enumerate(words) if (t := _token(w.text))]
    if len(theirs) < ECHO_RUN or len(mine) < ECHO_RUN:
        return set()
    blocks = SequenceMatcher(None, [t for _, t in mine], theirs, autojunk=False).get_matching_blocks()
    return {mine[k][0] for b in blocks if b.size >= ECHO_RUN for k in range(b.a, b.a + b.size)}


def my_side(segments: list[dict], words_per_segment: list[list[Word]], call_segments: list[dict], mic, call) -> list[dict]:
    """Your side's segments, labelled as you, without the call leaking into your microphone."""
    mine, theirs = envelope(mic), envelope(call)
    out: list[dict] = []
    dropped = 0
    for seg, words in zip(segments, words_per_segment):
        if follows_call(seg["start"], seg["end"], mine, theirs):
            dropped += 1
            continue
        if not words:
            out.append({**seg, "speaker": ME})
            continue
        echo = repeated_words(words, call_segments)
        dropped += bool(echo)
        run: list[Word] = []
        for i, w in enumerate(words):
            if i in echo:
                if run:
                    out.append(from_words(run, ME))
                run = []
            else:
                run.append(w)
        if run:
            out.append(from_words(run, ME))
    if dropped:
        log.info("Left out %d stretch(es) of your side that were the call coming through your microphone", dropped)
    return [s for s in out if s["text"]]
