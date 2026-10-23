from pathlib import Path

from debrief_transcriber.config import Config
from debrief_transcriber.main import audio_path


def build(monkeypatch, saved=None, **env):
    for k in ("WHISPER_MODEL", "DEVICE", "WHISPER_DEVICE", "HF_TOKEN", "DIARIZE", "WATCH_FOLDER", "AUDIO_DIR", "RECORDINGS_DIR", "TZ"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("POSTGRES_URL", "postgresql://x")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return Config.build(saved)


def test_saved_settings_apply_and_the_environment_wins(monkeypatch):
    cfg = build(monkeypatch, {"WHISPER_MODEL": "medium", "BEAM_SIZE": "2"})
    assert (cfg.model, cfg.beam_size, cfg.device, cfg.compute_type) == ("medium", 2, "cpu", "int8")
    cfg = build(monkeypatch, {"WHISPER_MODEL": "medium"}, WHISPER_MODEL="small", DEVICE="cuda")
    assert (cfg.model, cfg.device, cfg.compute_type) == ("small", "cuda", "float16")


def test_speaker_labels_follow_the_token_unless_set(monkeypatch):
    assert build(monkeypatch).diarize is False
    assert build(monkeypatch, {"HF_TOKEN": "hf_x"}).diarize is True
    assert build(monkeypatch, {"HF_TOKEN": "hf_x", "DIARIZE": "false"}).diarize is False


def test_watching_needs_a_mounted_folder(monkeypatch):
    assert build(monkeypatch, {"WATCH_FOLDER": "true"}).watch is False
    assert build(monkeypatch, {"WATCH_FOLDER": "true"}, AUDIO_DIR="/mnt/meetings/audio").watch is True


def test_audio_comes_from_the_server_first_then_the_nas(monkeypatch, tmp_path: Path):
    local, nas = tmp_path / "local", tmp_path / "nas"
    (nas / "pc").mkdir(parents=True)
    (nas / "pc" / "a.opus").write_bytes(b"x")
    cfg = build(monkeypatch, RECORDINGS_DIR=str(local), AUDIO_DIR=str(nas))
    assert audio_path(cfg, "pc/a.opus", "folder") == nas / "pc" / "a.opus"
    assert audio_path(cfg, "pc/a.opus", "s3") is None
    (local / "pc").mkdir(parents=True)
    (local / "pc" / "a.opus").write_bytes(b"x")
    assert audio_path(cfg, "pc/a.opus", "s3") == local / "pc" / "a.opus"
