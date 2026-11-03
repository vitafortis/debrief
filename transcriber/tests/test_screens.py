from pathlib import Path

from debrief_transcriber.screens import frames_in, keep

SLIDE = "Quarterly roadmap review: ship the importer, retire the legacy sync service, and hire two engineers"


def test_keeps_screens_with_text_and_drops_repeats(tmp_path: Path):
    for name in ["000003000.jpg", "000009000.jpg", "000015000.jpg", "000021000.jpg", "notes.txt"]:
        (tmp_path / name).write_bytes(b"\xff\xd8")
    texts = {
        "000003000": "Alex  Sam  Priya",  # a grid of faces
        "000009000": SLIDE,
        "000015000": SLIDE + " today",  # the same slide
        "000021000": "Budget 2027: infrastructure costs drop after the migration, support headcount stays flat, travel is cut by half",
    }
    frames = frames_in(tmp_path)
    assert [at for at, _ in frames] == [3.0, 9.0, 15.0, 21.0]
    kept, dropped = keep(frames, read=lambda p: texts[p.stem])
    assert [at for at, _, _ in kept] == [9.0, 21.0]
    assert sorted(p.stem for p in dropped) == ["000003000", "000015000"]
