from debrief_transcriber.speakers import Turn, Word, merge_adjacent, split_by_speaker


def test_a_segment_splits_where_the_speaker_changes():
    seg = {"start": 0.0, "end": 4.0, "text": "Can you send it? Sure, today."}
    words = [Word(0.0, 0.5, " Can"), Word(0.5, 0.8, " you"), Word(0.8, 1.2, " send"), Word(1.2, 1.6, " it?"),
             Word(2.0, 2.5, " Sure,"), Word(2.5, 3.0, " today.")]
    turns = [Turn(0.0, 1.8, "SPEAKER_00"), Turn(1.9, 4.0, "SPEAKER_01")]
    out = split_by_speaker([seg], [words], turns)
    assert [(s["speaker"], s["text"]) for s in out] == [("SPEAKER_00", "Can you send it?"), ("SPEAKER_01", "Sure, today.")]


def test_segments_without_words_take_the_most_overlapping_speaker():
    out = split_by_speaker([{"start": 5.0, "end": 9.0, "text": "Hello"}], [[]], [Turn(0, 6, "A"), Turn(6, 10, "B")])
    assert out[0]["speaker"] == "B"


def test_back_to_back_turns_from_one_speaker_merge():
    segs = [{"speaker": "A", "start": 0, "end": 2, "text": "One."}, {"speaker": "A", "start": 2.5, "end": 4, "text": "Two."},
            {"speaker": "B", "start": 4.2, "end": 5, "text": "Three."}]
    assert [s["text"] for s in merge_adjacent(segs)] == ["One. Two.", "Three."]
