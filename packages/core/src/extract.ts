import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { getMeeting, type Meeting } from "./meetings";
import { transcripts } from "./schema";
import { saveExtractedTasks, taskInput } from "./tasks";
import { z } from "zod";

export function clock(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function speakerName(names: Record<string, string>, speaker: string | null) {
  if (!speaker) return "Unknown";
  return names[speaker] || speaker.replace(/^SPEAKER_0*(\d+)$/, (_, n) => `Speaker ${Number(n) + 1}`);
}

/** The transcript as plain text, one speaker turn per line with its time, for Claude or an export. */
export function transcriptText(m: Pick<Meeting, "transcript">) {
  const segs = m.transcript.speakerSegments;
  if (!segs?.length) return m.transcript.content;
  return segs.map((s) => `[${clock(s.start)}] ${speakerName(m.transcript.speakerNames, s.speaker)}: ${s.text.trim()}`).join("\n");
}

/** Everything Claude needs to read a meeting: when, who, which calendar, and what was said. */
export function meetingBrief(m: Meeting) {
  const lines = [
    `Meeting: ${m.displayTitle}`,
    `Date: ${m.recording.recordedAt.toLocaleString("en-US", { timeZone: process.env.TZ || undefined, dateStyle: "full", timeStyle: "short" })}${m.recording.durationSecs ? ` (${Math.round(m.recording.durationSecs / 60)} min)` : ""}`,
    m.context ? `Calendar context: ${m.context}` : null,
    m.event?.organizerEmail ? `Organizer: ${m.event.organizerEmail}` : null,
    m.attendees.length ? `Attendees: ${m.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ")}` : null,
    "",
    transcriptText(m),
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

export const extractionAvailable = () => !!process.env.ANTHROPIC_API_KEY;

/**
 * Has Claude (through the API) summarize a meeting and pull out its action
 * items, then saves both. Needs ANTHROPIC_API_KEY; without it, use the MCP
 * tools from a Claude client instead.
 */
export async function extractWithClaude(db: Db, transcriptId: string) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY to extract tasks here, or ask Claude through the MCP server.");
  const m = await getMeeting(db, transcriptId);
  if (!m) throw new Error("No such transcript.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 8000,
      system: `You review meeting transcripts and record what needs to happen next.\n\n${EXTRACTION_GUIDE}\n\nAlso write a summary: 2–5 sentences on what the meeting covered and decided.`,
      tools: [
        {
          name: "save_meeting_notes",
          description: "Save the meeting summary and its action items.",
          input_schema: z.toJSONSchema(extraction),
        },
      ],
      tool_choice: { type: "tool", name: "save_meeting_notes" },
      messages: [{ role: "user", content: meetingBrief(m) }],
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    content?: { type: string; name?: string; input?: unknown }[];
    error?: { message?: string };
  } | null;
  if (!res.ok) throw new Error(`Claude: ${body?.error?.message ?? `HTTP ${res.status}`}`);
  const call = body?.content?.find((c) => c.type === "tool_use" && c.name === "save_meeting_notes");
  const out = extraction.parse(call?.input);
  await db.update(transcripts).set({ summary: out.summary }).where(eq(transcripts.id, transcriptId));
  const saved = await saveExtractedTasks(db, transcriptId, out.tasks);
  return { summary: out.summary, tasks: saved };
}
