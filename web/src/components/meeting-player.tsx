"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Rewind, FastForward, Search, X, LocateFixed } from "lucide-react";
import type WaveSurfer from "wavesurfer.js";
import type { SpeakerSegment } from "@debrief/core/schema";
import { clock, speakerLabel } from "@/lib/time";

const SPEAKER_COLORS = ["var(--series-2)", "var(--series-1)", "var(--series-4)", "var(--primary)", "var(--warning)", "var(--syntax-function)"];

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Marks every occurrence of the words in `query` (case-insensitive). */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}
    </>
  );
}

/**
 * The audio player and the transcript beside it: the line being spoken is
 * highlighted and kept in view, clicking a line seeks there, and the find box
 * marks and steps through matches.
 */
export function MeetingPlayer({
  recordingId,
  segments,
  speakerNames,
  durationSecs,
  waveform,
  initialTime,
  initialQuery,
}: {
  recordingId: string;
  segments: SpeakerSegment[];
  speakerNames: Record<string, string>;
  durationSecs: number | null;
  waveform: number[] | null;
  initialTime?: number;
  initialQuery?: string;
}) {
  const waveRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(initialTime ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [hit, setHit] = useState(0);
  const [audioError, setAudioError] = useState<string | null>(null);
  const duration = durationSecs ?? segments.at(-1)?.end ?? 0;

  const speakers = useMemo(() => [...new Set(segments.map((s) => s.speaker).filter(Boolean))] as string[], [segments]);
  const colorOf = (sp: string | null) => (sp ? SPEAKER_COLORS[speakers.indexOf(sp) % SPEAKER_COLORS.length] : "var(--muted-foreground)");

  // The waveform, drawn from the stored peaks so the audio streams instead of downloading first.
  useEffect(() => {
    const audio = audioRef.current;
    if (!waveRef.current || !audio) return;
    let ws: WaveSurfer | null = null;
    let cancelled = false;
    import("wavesurfer.js").then(({ default: WaveSurferCtor }) => {
      if (cancelled || !waveRef.current) return;
      ws = WaveSurferCtor.create({
        container: waveRef.current,
        media: audio,
        height: 56,
        waveColor: cssVar("--input") || "#555",
        progressColor: cssVar("--primary") || "#10b981",
        cursorColor: cssVar("--foreground") || "#fff",
        cursorWidth: 1,
        barWidth: 2,
        barGap: 1.5,
        barRadius: 2,
        normalize: true,
        dragToSeek: true,
        ...(waveform?.length ? { peaks: [waveform], duration } : {}),
      });
      wsRef.current = ws;
    });
    return () => {
      cancelled = true;
      ws?.destroy();
      wsRef.current = null;
    };
  }, [recordingId, waveform, duration]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setTime(audio.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setAudioError("The audio couldn't be loaded. Is the NAS mounted on the web container?");
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);
    if (initialTime) {
      const seekOnce = () => {
        audio.currentTime = initialTime;
        audio.removeEventListener("loadedmetadata", seekOnce);
      };
      audio.addEventListener("loadedmetadata", seekOnce);
    }
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
    };
  }, [initialTime]);

  const seek = useCallback((t: number, play = true) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, t);
    setTime(audio.currentTime);
    if (play) audio.play().catch(() => {});
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  // Space plays and pauses, J / L skip, unless typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "j") seek((audioRef.current?.currentTime ?? 0) - 10, false);
      else if (e.key === "l") seek((audioRef.current?.currentTime ?? 0) + 10, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seek]);

  const current = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= time + 0.05) idx = i;
      else break;
    }
    return idx;
  }, [segments, time]);

  useEffect(() => {
    if (!follow || !playing || current < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-seg="${current}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current, follow, playing]);

  const terms = useMemo(
    () =>
      query
        .toLowerCase()
        .replace(/["()]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && t !== "or" && !t.startsWith("-")),
    [query]
  );
  const hits = useMemo(
    () => (terms.length ? segments.map((s, i) => (terms.some((t) => s.text.toLowerCase().includes(t)) ? i : -1)).filter((i) => i >= 0) : []),
    [segments, terms]
  );
  const goHit = (n: number) => {
    if (!hits.length) return;
    const i = ((n % hits.length) + hits.length) % hits.length;
    setHit(i);
    setFollow(false);
    listRef.current?.querySelector<HTMLElement>(`[data-seg="${hits[i]}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  useEffect(() => {
    if (initialQuery && hits.length && !initialTime) goHit(0);
    // Only on first render with a query from search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="card flex min-h-0 flex-col overflow-hidden">
      <div className="border-b border-border bg-surface/60 p-4">
        <audio ref={audioRef} src={`/api/audio/${recordingId}`} preload="metadata" />
        <div ref={waveRef} className="w-full cursor-pointer" aria-label="Waveform" />
        {audioError && <p className="mt-2 text-xs text-danger">{audioError}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary btn-icon" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title="Play / pause (space)">
            {playing ? <Pause /> : <Play />}
          </button>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => seek(time - 15, false)} title="Back 15 s">
            <Rewind />
          </button>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => seek(time + 15, false)} title="Forward 15 s">
            <FastForward />
          </button>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {clock(time)} / {clock(duration)}
          </span>
          <select className="input h-7 w-auto pr-7 text-xs" value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Speed">
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
          <button
            className={`btn btn-sm ${follow ? "btn-secondary text-primary" : "btn-ghost"}`}
            onClick={() => setFollow(!follow)}
            title="Keep the line being spoken in view"
          >
            <LocateFixed />
            Follow
          </button>
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
            <input
              className="input h-7 pr-16 pl-7 text-xs"
              placeholder="Find in transcript"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHit(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") goHit(e.shiftKey ? hit - 1 : hit + 1);
              }}
            />
            {query && (
              <span className="absolute top-1 right-1.5 flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                <span className="font-mono tabular-nums">{hits.length ? `${hit + 1}/${hits.length}` : "0"}</span>
                <button onClick={() => setQuery("")} aria-label="Clear" className="p-0.5 hover:text-foreground">
                  <X className="size-3" />
                </button>
              </span>
            )}
          </div>
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2" onWheel={() => playing && setFollow(false)}>
        {segments.length === 0 && <p className="px-4 py-10 text-center text-sm text-muted-foreground">No speech was found in this recording.</p>}
        {segments.map((s, i) => {
          const prev = segments[i - 1];
          const newSpeaker = !prev || prev.speaker !== s.speaker;
          const label = speakerLabel(speakerNames, s.speaker);
          return (
            <div
              key={i}
              data-seg={i}
              onClick={() => seek(s.start)}
              className={`group grid cursor-pointer grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 px-4 py-1.5 transition-colors hover:bg-accent/50 ${i === current ? "seg-active" : ""} ${hits[hit] === i && query ? "ring-1 ring-warning/50 ring-inset" : ""}`}
            >
              <span className="pt-0.5 text-right font-mono text-[0.6875rem] text-muted-foreground tabular-nums group-hover:text-primary">{clock(s.start)}</span>
              <div>
                {newSpeaker && label && (
                  <p className="mb-0.5 text-xs font-semibold" style={{ color: colorOf(s.speaker) }}>
                    {label}
                  </p>
                )}
                <p className="text-[0.875rem] leading-relaxed">
                  <Marked text={s.text} terms={terms} />
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
