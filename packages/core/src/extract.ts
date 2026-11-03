import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { getMeeting, type Meeting } from "./meetings";
import { transcripts } from "./schema";
import { saveExtractedTasks, taskInput } from "./tasks";
import { requestPublish } from "./notes";
import { z } from "zod";
import { setting, settingBool, timeZone } from "./settings";
import { aiConfigured, callTool } from "./ai";

export function clock(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function speakerName(names: Record<string, string>, speaker: string | null) {
  if (!speaker) return "Unknown";
  if (names[speaker]) return names[speaker];
  // Debrief Recorder recordings label your side YOU, and the call's OTHERS when nobody on it is told apart.
  if (speaker === "YOU") return setting("OWNER_NAME") || "You";
  if (speaker === "OTHERS") return "Others on the call";
  return speaker.replace(/^SPEAKER_0*(\d+)$/, (_, n) => `Speaker ${Number(n) + 1}`);
}

/** The transcript as plain text, one speaker turn per line with its time, for a model or an export. */
export function transcriptText(m: Pick<Meeting, "transcript">) {
  const segs = m.transcript.speakerSegments;
  if (!segs?.length) return m.transcript.content;
  return segs.map((s) => `[${clock(s.start)}] ${speakerName(m.transcript.speakerNames, s.speaker)}: ${s.text.trim()}`).join("\n");
}

/** The text read from what was shown on screen, by time, cut to about `max` characters. */
export function screensText(m: Pick<Meeting, "screens">, max = 12_000) {
  const out: string[] = [];
  let used = 0;
  for (const s of m.screens) {
    const line = `[${clock(s.atSecs)}]\n${s.text.trim()}`;
    if (used + line.length > max) break;
    out.push(line);
    used += line.length;
  }
  return out.join("\n\n");
}

/** Everything a model needs to read a meeting: when, who, which calendar, what was said, and what was shown. */
export function meetingBrief(m: Meeting) {
  const lines = [
    `Meeting: ${m.displayTitle}`,
    `Date: ${m.recording.recordedAt.toLocaleString("en-US", { timeZone: timeZone(), dateStyle: "full", timeStyle: "short" })}${m.recording.durationSecs ? ` (${Math.round(m.recording.durationSecs / 60)} min)` : ""}`,
    m.context ? `Calendar context: ${m.context}` : null,
    m.event?.organizerEmail ? `Organizer: ${m.event.organizerEmail}` : null,
    m.attendees.length ? `Attendees: ${m.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ")}` : null,
    "",
    transcriptText(m),
    ...(m.screens.length ? ["", "Text on screens shared during the meeting (read by OCR, so expect some errors):", "", screensText(m)] : []),
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export const EXTRACTION_GUIDE = `Pull out the action items: things someone committed to do, was asked to do, or that clearly need doing after this meeting.
- One item per distinct action, written as an imperative ("Send Sarah the API v2 timeline").
- assignee: who owns it, by name, when it's said or obvious; "me" when it's the recording's owner (the person whose calendar this is).
- dueDate (YYYY-MM-DD) only when a date or a relative day ("by Friday") was said, resolved against the meeting date.
- priority: high when urgent or blocking, low when "someday"; otherwise medium.
- destination: "linear" for software/dev work (bugs, features, code changes), otherwise "akiflow".
- sourceStart: the time in seconds where it was said.
- details: one or two sentences of context from the meeting.
Leave out small talk, decisions with no follow-up, and things already done in the meeting.`;

const extraction = z.object({ summary: z.string().max(4000), tasks: z.array(taskInput).max(50) });

/** Whether a model is set up to summarize here (Settings → AI summaries). */
export const extractionAvailable = aiConfigured;
/** Summarize every new transcript as soon as it's linked (AUTO_EXTRACT=false to only do it on request). */
export const autoExtract = () => extractionAvailable() && settingBool("AUTO_EXTRACT");

/**
 * Has the chosen model summarize a meeting and pull out its action items,
 * then saves both. Without a provider, use the MCP tools from an assistant.
 */
export async function extractWithAi(db: Db, transcriptId: string) {
  const m = await getMeeting(db, transcriptId);
  if (!m) throw new Error("No such transcript.");
  const input = await callTool({
    system: `You review meeting transcripts and record what needs to happen next.\n\n${EXTRACTION_GUIDE}\n\nAlso write a summary: 2–5 sentences on what the meeting covered and decided.`,
    user: meetingBrief(m),
    tool: { name: "save_meeting_notes", description: "Save the meeting summary and its action items.", schema: z.toJSONSchema(extraction) as Record<string, unknown> },
  });
  const out = extraction.parse(input);
  await db.update(transcripts).set({ summary: out.summary }).where(eq(transcripts.id, transcriptId));
  const saved = await saveExtractedTasks(db, transcriptId, out.tasks);
  await requestPublish(db, transcriptId);
  return { summary: out.summary, tasks: saved };
}
