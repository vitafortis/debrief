"""faster-whisper transcription and optional pyannote diarization."""

from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .channels import THEM, from_recorder, my_side
from .config import Config
from .speakers import Turn, Word, merge_adjacent, split_by_speaker

log = logging.getLogger("debrief.transcribe")

# pyannote warns that its own decoder (torchcodec) can't load; it's never used, the audio is passed in decoded.
warnings.filterwarnings("ignore", message=r"(?s).*torchcodec is not installed correctly")

SAMPLE_RATE = 16000


@dataclass
class Result:
    text: str
    segments: list[dict]
    language: str
    duration: float
    model: str
    peaks: list[float]


def peaks(audio, points: int = 3000) -> list[float]:
    """Peak level per slice of the recording, scaled to the loudest, for drawing the waveform."""
    import numpy as np

    if len(audio) == 0:
        return []
    n = min(points, len(audio))
    usable = len(audio) - len(audio) % n
    p = np.abs(audio[:usable]).reshape(n, -1).max(axis=1)
    top = float(p.max()) or 1.0
    return [round(float(x) / top, 3) for x in p]


class Transcriber:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._model = None
        self._pipeline = None
        self._diarize_failed = False

    def model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            log.info("Loading whisper model %s on %s (%s)…", self.cfg.model, self.cfg.device, self.cfg.compute_type)
            self._model = WhisperModel(
                self.cfg.model,
                device=self.cfg.device,
                compute_type=self.cfg.compute_type,
                cpu_threads=self.cfg.cpu_threads,
                download_root=self.cfg.model_dir,
            )
        return self._model

    def pipeline(self):
        """The diarization pipeline, or None when it's off or can't load (transcripts then have no speakers)."""
        if not self.cfg.diarize or self._diarize_failed:
            return None
        if self._pipeline is None:
            try:
                import torch
                from pyannote.audio import Pipeline

                log.info("Loading diarization model %s…", self.cfg.diarization_model)
                pipe = Pipeline.from_pretrained(self.cfg.diarization_model, token=self.cfg.hf_token)
                if pipe is None:
                    raise RuntimeError("the model didn't load; check HF_TOKEN and that its terms are accepted on huggingface.co")
                if self.cfg.device == "cuda":
                    pipe.to(torch.device("cuda"))
                self._pipeline = pipe
            except Exception as err:  # noqa: BLE001 — a missing extra or a bad token shouldn't stop transcription
                log.warning("Speaker labels are off: %s", err)
                self._diarize_failed = True
                return None
        return self._pipeline

    def diarize(self, audio) -> list[Turn]:
        pipe = self.pipeline()
        if pipe is None:
            return []
        import torch

        out = pipe({"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": SAMPLE_RATE})
        # pyannote 4 returns an object holding the annotation; 3.x returns it directly.
        annotation = getattr(out, "exclusive_speaker_diarization", None) or getattr(out, "speaker_diarization", None) or out
        return [Turn(float(seg.start), float(seg.end), str(label)) for seg, _, label in annotation.itertracks(yield_label=True)]

    def transcribe(self, audio, words: bool, progress: Callable[[float], None] | None, lo: float, hi: float):
        """Whisper's segments and their words, reporting progress between lo and hi."""
        segments_iter, info = self.model().transcribe(
            audio,
            language=self.cfg.language,
            beam_size=self.cfg.beam_size,
            vad_filter=True,
            word_timestamps=words,
        )
        duration = len(audio) / SAMPLE_RATE
        segments: list[dict] = []
        word_lists: list[list[Word]] = []
        last_report = lo
        for s in segments_iter:
            segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
            word_lists.append([Word(w.start, w.end, w.word) for w in (s.words or [])])
            if progress and duration:
                p = lo + min(1.0, s.end / duration) * (hi - lo)
                if p - last_report >= 0.02:
                    progress(p)
                    last_report = p
        return segments, word_lists, info

    def run(self, path: Path, progress: Callable[[float], None] | None = None) -> Result:
        from faster_whisper.audio import decode_audio

        if from_recorder(path):
            mic, call = decode_audio(str(path), sampling_rate=SAMPLE_RATE, split_stereo=True)
            return self.run_two_sides(mic, call, progress)

        audio = decode_audio(str(path), sampling_rate=SAMPLE_RATE)
        want_speakers = self.pipeline() is not None
        # Transcription is most of the work; diarization is the rest.
        segments, words, info = self.transcribe(audio, want_speakers, progress, 0.0, 0.75 if want_speakers else 1.0)

        if want_speakers:
            turns = self.diarize(audio)
            final = split_by_speaker(segments, words, turns) if turns else [{**s, "speaker": None} for s in segments]
        else:
            final = merge_adjacent([{**s, "speaker": None} for s in segments])
        if progress:
            progress(1.0)
        return self.result(final, info.language, audio)

    def run_two_sides(self, mic, call, progress: Callable[[float], None] | None) -> Result:
        """A Debrief Recorder file: your side is you; pyannote, if it's on, tells the call's people apart."""
        want_speakers = self.pipeline() is not None
        theirs, their_words, info = self.transcribe(call, want_speakers, progress, 0.0, 0.4)
        mine, my_words, my_info = self.transcribe(mic, True, progress, 0.4, 0.8 if want_speakers else 1.0)

        if want_speakers and theirs and (turns := self.diarize(call)):
            them = split_by_speaker(theirs, their_words, turns, merge=False)
        else:
            them = [{**s, "speaker": THEM} for s in theirs]
        final = merge_adjacent(my_side(mine, my_words, theirs, mic, call) + them)
        if progress:
            progress(1.0)
        return self.result(final, info.language if theirs else my_info.language, (mic + call) / 2)

    def result(self, segments: list[dict], language: str, audio) -> Result:
        return Result(
            text="\n".join(s["text"] for s in segments if s["text"]),
            segments=segments,
            language=language,
            duration=len(audio) / SAMPLE_RATE,
            model=self.cfg.model,
            peaks=peaks(audio),
        )
