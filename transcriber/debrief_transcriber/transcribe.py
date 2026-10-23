"""faster-whisper transcription and optional pyannote diarization."""

from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

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

    def run(self, path: Path, progress: Callable[[float], None] | None = None) -> Result:
        from faster_whisper.audio import decode_audio

        audio = decode_audio(str(path), sampling_rate=SAMPLE_RATE)
        duration = len(audio) / SAMPLE_RATE
        want_speakers = self.pipeline() is not None

        segments_iter, info = self.model().transcribe(
            audio,
            language=self.cfg.language,
            beam_size=self.cfg.beam_size,
            vad_filter=True,
            word_timestamps=want_speakers,
        )
        segments: list[dict] = []
        words: list[list[Word]] = []
        last_report = 0.0
        # Transcription is most of the work; diarization is the rest.
        share = 0.75 if want_speakers else 1.0
        for s in segments_iter:
            segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
            words.append([Word(w.start, w.end, w.word) for w in (s.words or [])])
            if progress and duration:
                p = min(1.0, s.end / duration) * share
                if p - last_report >= 0.02:
                    progress(p)
                    last_report = p

        if want_speakers:
            turns = self.diarize(audio)
            final = split_by_speaker(segments, words, turns) if turns else [{**s, "speaker": None} for s in segments]
        else:
            final = merge_adjacent([{**s, "speaker": None} for s in segments])
        if progress:
            progress(1.0)

        text = "\n".join(s["text"] for s in final if s["text"])
        return Result(
            text=text,
            segments=final,
            language=info.language,
            duration=duration,
            model=self.cfg.model,
            peaks=peaks(audio),
        )
