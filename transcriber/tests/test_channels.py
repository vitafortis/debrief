import numpy as np

from debrief_transcriber.channels import ME, SAMPLE_RATE, envelope, follows_call, from_recorder, my_side, repeated_words
from debrief_transcriber.speakers import Word, merge_adjacent


def words(text: str, start: float = 0.0, step: float = 0.4) -> list[Word]:
    return [Word(start + i * step, start + (i + 1) * step, f" {w}") for i, w in enumerate(text.split())]


def bursts(seconds: float, on: list[tuple[float, float]], seed: int) -> np.ndarray:
    """Noise switched on over each (start, end), like speech; silence elsewhere."""
    rng = np.random.default_rng(seed)
    a = np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)
    for s, e in on:
        i, j = int(s * SAMPLE_RATE), int(e * SAMPLE_RATE)
        a[i:j] = rng.normal(0, 0.1, j - i)
    return a


def test_the_call_repeated_through_your_microphone_is_found():
    call = [{"start": 0.0, "end": 3.0, "text": "The API timeline may slip by two weeks."}]
    w = words("the API timeline may slip by two weeks")
    assert repeated_words(w, call) == set(range(8))


def test_your_own_words_are_kept_even_when_they_echo_a_few_of_theirs():
    call = [{"start": 0.0, "end": 3.0, "text": "The API timeline may slip by two weeks."}]
    assert repeated_words(words("so the API slips?"), call) == set()
    assert repeated_words(words("yeah"), call) == set()


def test_what_the_call_said_long_before_doesnt_count():
    call = [{"start": 100.0, "end": 103.0, "text": "The API timeline may slip by two weeks."}]
    assert repeated_words(words("the API timeline may slip by two weeks"), call) == set()


def test_loudness_that_follows_the_call_is_echo():
    turns = [(1.0, 1.6), (2.0, 2.3), (2.8, 3.9), (4.5, 5.0)]
    call = bursts(6, turns, seed=1)
    echo = np.roll(call, int(0.12 * SAMPLE_RATE)) * 0.2  # quieter and a little later
    assert follows_call(1.0, 5.2, envelope(echo), envelope(call))


def test_talking_in_turn_isnt_echo():
    call = bursts(6, [(0.2, 1.4), (3.0, 4.0)], seed=1)
    mic = bursts(6, [(1.6, 2.8), (4.2, 5.5)], seed=2)
    assert not follows_call(1.6, 5.5, envelope(mic), envelope(call))


def test_your_side_keeps_what_you_said_around_what_leaked_in():
    call = [{"start": 0.0, "end": 3.0, "text": "The API timeline may slip by two weeks."}]
    w = words("okay the API timeline may slip by two weeks I'll tell Sam")
    seg = {"start": w[0].start, "end": w[-1].end, "text": " ".join(x.text.strip() for x in w)}
    silent = np.zeros(6 * SAMPLE_RATE, dtype=np.float32)
    out = my_side([seg], [w], call, silent, silent)
    assert [(s["speaker"], s["text"]) for s in out] == [(ME, "okay"), (ME, "I'll tell Sam")]


def test_a_short_reply_doesnt_end_the_other_persons_turn():
    segs = [
        {"speaker": "OTHERS", "start": 0.0, "end": 4.0, "text": "So the plan is to ship on Friday,"},
        {"speaker": "YOU", "start": 3.5, "end": 4.0, "text": "Yeah."},
        {"speaker": "OTHERS", "start": 4.3, "end": 7.0, "text": "unless QA finds something."},
    ]
    assert [(s["speaker"], s["text"]) for s in merge_adjacent(segs)] == [
        ("OTHERS", "So the plan is to ship on Friday, unless QA finds something."),
        ("YOU", "Yeah."),
    ]


def test_a_real_reply_does_end_it():
    segs = [
        {"speaker": "OTHERS", "start": 0.0, "end": 4.0, "text": "Can you ship on Friday?"},
        {"speaker": "YOU", "start": 4.2, "end": 6.5, "text": "Friday works if QA signs off."},
        {"speaker": "OTHERS", "start": 6.8, "end": 8.0, "text": "Great."},
    ]
    assert [s["speaker"] for s in merge_adjacent(segs)] == ["OTHERS", "YOU", "OTHERS"]


def test_a_long_turn_breaks_at_a_sentence_end():
    segs = [{"speaker": "A", "start": i * 10.0, "end": i * 10.0 + 9.5, "text": t} for i, t in
            enumerate(["First point.", "Second point,", "still second.", "Third point.", "Fourth."])]
    out = merge_adjacent(segs)
    # 0–30 s carries on; the first sentence end past 30 s closes the line.
    assert [s["text"] for s in out] == ["First point. Second point, still second. Third point.", "Fourth."]


def test_only_the_recorders_two_channel_files_are_split(tmp_path):
    import av

    def write(name: str, layout: str):
        path = tmp_path / layout / name
        path.parent.mkdir(exist_ok=True)
        channels = 2 if layout == "stereo" else 1
        with av.open(str(path), "w", format="ogg") as out:
            stream = out.add_stream("libopus", rate=48000, layout=layout)
            frame = av.AudioFrame.from_ndarray(np.zeros((1, 960 * channels), dtype=np.int16), format="s16", layout=layout)
            frame.sample_rate = 48000
            for packet in [*stream.encode(frame), *stream.encode(None)]:
                out.mux(packet)
        return path

    assert from_recorder(write("audio.opus", "stereo"))
    assert not from_recorder(write("audio.opus", "mono"))
    assert not from_recorder(write("call.opus", "stereo"))
