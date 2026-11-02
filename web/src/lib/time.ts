/** Shared by server and client components. */

export function clock(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Debrief Recorder recordings: your microphone's side, and the call's side when nobody on it is told apart.
const SIDES: Record<string, string> = { YOU: "You", OTHERS: "Others" };

export function speakerLabel(names: Record<string, string>, speaker: string | null) {
  if (!speaker) return null;
  return names[speaker] || SIDES[speaker] || speaker.replace(/^SPEAKER_0*(\d+)$/, (_, n) => `Speaker ${Number(n) + 1}`);
}
