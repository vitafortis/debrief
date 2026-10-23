"""Settings: made in the web app (the settings table), with an environment variable of the same name winning."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".opus", ".flac", ".webm", ".aac", ".aiff", ".aif"}

# The web app's defaults (packages/core/src/settings.ts), for what this service reads.
DEFAULTS = {
    "WHISPER_MODEL": "large-v3",
    "WHISPER_DEVICE": "cpu",
    "COMPUTE_TYPE": "",
    "CPU_THREADS": "0",
    "LANGUAGE": "",
    "BEAM_SIZE": "5",
    "HF_TOKEN": "",
    "DIARIZE": "",
    "WATCH_FOLDER": "false",
    "SCAN_INTERVAL": "30",
    "STABLE_SECONDS": "60",
    "ABANDON_HOURS": "12",
    "TZ": "UTC",
}
# Older environment names that still count.
ALIASES = {"WHISPER_DEVICE": ["DEVICE"]}


def _truthy(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _num(raw: str, default: str) -> float:
    try:
        return float(raw)
    except ValueError:
        return float(default)


def database_url() -> str:
    url = os.environ.get("POSTGRES_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("Set POSTGRES_URL (or DATABASE_URL) to the Debrief database.")
    return url


def _dir(name: str) -> Path | None:
    raw = os.environ.get(name)
    return Path(raw) if raw else None


@dataclass(frozen=True)
class Config:
    database_url: str
    recordings_dir: Path
    audio_dir: Path | None
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
    watch: bool
    scan_interval: float
    stable_seconds: float
    abandon_hours: float
    tz: str
    model_dir: str | None
    extensions: set[str] = field(default_factory=lambda: set(AUDIO_EXTENSIONS))

    @classmethod
    def build(cls, saved: dict[str, str] | None = None) -> "Config":
        """From the saved settings (key -> value), with the environment winning, then the defaults."""
        saved = saved or {}

        def get(key: str) -> str:
            for name in (key, *ALIASES.get(key, [])):
                v = os.environ.get(name)
                if v:
                    return v
            return saved.get(key) or DEFAULTS.get(key, "")

        device = get("WHISPER_DEVICE").lower()
        hf_token = get("HF_TOKEN") or None
        diarize = get("DIARIZE")
        audio_dir = _dir("AUDIO_DIR")
        return cls(
            database_url=database_url(),
            recordings_dir=Path(os.environ.get("RECORDINGS_DIR") or "/data/recordings"),
            audio_dir=audio_dir,
            export_dir=_dir("EXPORT_DIR"),
            model=get("WHISPER_MODEL"),
            device=device,
            # int8 keeps large-v3 quick on CPUs; float16 is right for a GPU.
            compute_type=get("COMPUTE_TYPE") or ("float16" if device == "cuda" else "int8"),
            cpu_threads=int(_num(get("CPU_THREADS"), "0")),
            language=get("LANGUAGE") or None,
            beam_size=int(_num(get("BEAM_SIZE"), "5")),
            diarize=_truthy(diarize) if diarize else bool(hf_token),
            hf_token=hf_token,
            diarization_model=os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1"),
            watch=_truthy(get("WATCH_FOLDER")) and audio_dir is not None,
            scan_interval=max(5.0, _num(get("SCAN_INTERVAL"), "30")),
            stable_seconds=_num(get("STABLE_SECONDS"), "60"),
            # A recording whose sidecar still says "recording" but hasn't grown in this long is taken as it is.
            abandon_hours=_num(get("ABANDON_HOURS"), "12"),
            tz=get("TZ"),
            model_dir=os.environ.get("MODEL_DIR") or None,
        )

    def engine_key(self) -> tuple:
        """What the loaded models depend on: when it changes, they're loaded again."""
        return (self.model, self.device, self.compute_type, self.cpu_threads, self.diarize, self.hf_token)
