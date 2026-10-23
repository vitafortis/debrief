"""Settings, all from the environment (see compose.yaml)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".opus", ".flac", ".webm", ".aac", ".aiff", ".aif"}


@dataclass(frozen=True)
class Config:
    database_url: str
    audio_dir: Path
    export_dir: Path | None
    model: str
    device: str
    compute_type: str
    cpu_threads: int
    language: str | None
    beam_size: int
    diarize: bool
    hf_token: str | None
    diarization_model: str
    scan_interval: float
    stable_seconds: float
    model_dir: str | None
    extensions: set[str] = field(default_factory=lambda: set(AUDIO_EXTENSIONS))

    @classmethod
    def from_env(cls) -> "Config":
        url = os.environ.get("POSTGRES_URL") or os.environ.get("DATABASE_URL")
        if not url:
            raise SystemExit("Set POSTGRES_URL (or DATABASE_URL) to the Debrief database.")
        device = os.environ.get("DEVICE", "cpu").lower()
        hf_token = os.environ.get("HF_TOKEN") or None
        export = os.environ.get("EXPORT_DIR", "/mnt/meetings/exports")
        return cls(
            database_url=url,
            audio_dir=Path(os.environ.get("AUDIO_DIR", "/mnt/meetings/audio")),
            export_dir=Path(export) if export else None,
            model=os.environ.get("WHISPER_MODEL", "large-v3"),
            device=device,
            # int8 keeps large-v3 quick on CPUs; float16 is right for a GPU like the T4.
            compute_type=os.environ.get("COMPUTE_TYPE") or ("float16" if device == "cuda" else "int8"),
            cpu_threads=int(os.environ.get("CPU_THREADS", "0")),
            language=os.environ.get("LANGUAGE") or None,
            beam_size=int(os.environ.get("BEAM_SIZE", "5")),
            diarize=_bool("DIARIZE", default=bool(hf_token)),
            hf_token=hf_token,
            diarization_model=os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1"),
            scan_interval=float(os.environ.get("SCAN_INTERVAL", "30")),
            stable_seconds=float(os.environ.get("STABLE_SECONDS", "60")),
            model_dir=os.environ.get("MODEL_DIR") or None,
        )
