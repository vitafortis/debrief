/**
 * What happens once a meeting has its summary: a Markdown copy (summary,
 * action items, transcript) goes to the exports folder on the NAS, and a
 * message to Slack. calendar-sync does both, woken by debrief_summarized.
 */
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./db";
import { clock, speakerName } from "./extract";
import { getMeeting, type Meeting } from "./meetings";
import { transcripts } from "./schema";

const tz = () => process.env.TZ || "UTC";
const when = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: tz(), weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const isoDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const minutes = (s: number | null) => (s ? `${Math.max(1, Math.round(s / 60))} min` : null);
const DEST = { akiflow: "Akiflow", linear: "Linear" } as const;

export const meetingUrl = (id: string) => (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/meetings/${id}` : null);

/** The meeting as Markdown: when, who, summary, action items and the transcript. */
export function meetingMarkdown(m: Meeting) {
  const segs = m.transcript.speakerSegments ?? [];
  const facts = [when(m.recording.recordedAt), minutes(m.recording.durationSecs), m.context, m.recording.device].filter(Boolean).join(" · ");
  const open = m.tasks.filter((t) => t.status !== "dismissed");
  return [
    `# ${m.displayTitle}`,
    "",
    facts,
    ...(m.attendees.length ? ["", `Attendees: ${m.attendees.map((a) => a.name ?? a.email).join(", ")}`] : []),
    ...(meetingUrl(m.transcript.id) ? ["", meetingUrl(m.transcript.id)!] : []),
    "",
    ...(m.transcript.summary ? ["## Summary", "", m.transcript.summary, ""] : []),
    ...(open.length
      ? [
          "## Action items",
          "",
          ...open.flatMap((t) => [
            `- [${t.status === "pushed" ? "x" : " "}] ${t.description}${[t.assignee, t.dueDate && `due ${t.dueDate}`].filter(Boolean).length ? ` (${[t.assignee, t.dueDate && `due ${t.dueDate}`].filter(Boolean).join(", ")})` : ""}`,
            ...(t.details ? [`  ${t.details}`] : []),
          ]),
          "",
        ]
      : []),
    "## Transcript",
    "",
    ...(segs.length ? segs.map((s) => `**${speakerName(m.transcript.speakerNames, s.speaker)}** \`${clock(s.start)}\` ${s.text.trim()}\n`) : [m.transcript.content]),
  ].join("\n");
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "meeting";

/** Writes <EXPORT_DIR>/<day>/<title>-<id>.notes.md, beside the transcriber's .txt and .json. Returns the path, or null when exports are off. */
export async function writeMeetingNotes(m: Meeting) {
  const root = process.env.EXPORT_DIR ?? "/mnt/meetings/exports";
  if (!root) return null;
  const dir = path.join(root, isoDay(m.recording.recordedAt));
  const tag = m.recording.id.slice(0, 8);
  await fs.promises.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  // A renamed meeting gets a new file name: drop the old one.
  for (const f of await fs.promises.readdir(/*turbopackIgnore: true*/ dir)) {
    if (f.endsWith(`-${tag}.notes.md`)) await fs.promises.rm(path.join(dir, f), { force: true });
  }
  const file = path.join(dir, `${slug(m.displayTitle)}-${tag}.notes.md`);
  await fs.promises.writeFile(/*turbopackIgnore: true*/ file, meetingMarkdown(m) + "\n");
  return file;
}

/** The Slack incoming webhook for a context: SLACK_WEBHOOKS="acme:https://hooks…,lumen:https://hooks…", else SLACK_WEBHOOK_URL. */
export function slackWebhookFor(context: string | null) {
  const map = Object.fromEntries(
    (process.env.SLACK_WEBHOOKS ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf(":");
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      })
  );
  return (context && map[context]) || process.env.SLACK_WEBHOOK_URL || null;
}

export const slackConfigured = () => !!(process.env.SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOKS);

// Slack's mrkdwn: escape the three characters it treats as markup.
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A Block Kit message: title, when and who, the summary, then each action item with its details. */
export function slackMessage(m: Meeting) {
  const url = meetingUrl(m.transcript.id);
  const open = m.tasks.filter((t) => t.status !== "dismissed");
  const facts = [when(m.recording.recordedAt), minutes(m.recording.durationSecs), m.context, m.attendees.length ? `${m.attendees.length} attendees` : null]
    .filter(Boolean)
    .join("  ·  ");
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: cut(m.displayTitle, 150), emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: esc(facts) }] },
  ];
  if (m.transcript.summary) blocks.push({ type: "section", text: { type: "mrkdwn", text: cut(esc(m.transcript.summary), 2900) } });
  if (open.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Action items (${open.length})*` } });
    const shown = open.slice(0, 15);
    for (const t of shown) {
      const meta = [
        t.assignee && `👤 ${esc(t.assignee)}`,
        t.dueDate && `📅 ${t.dueDate}`,
        t.priority && t.priority !== "medium" && `${t.priority === "high" ? "🔺" : "▫️"} ${t.priority}`,
        t.destination && `→ ${DEST[t.destination]}`,
        t.status === "pushed" ? "✅ sent" : t.status === "approved" ? "approved" : null,
        url && t.sourceStart != null && `<${url}?t=${Math.floor(t.sourceStart)}|${clock(t.sourceStart)}>`,
      ].filter(Boolean);
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: cut(`*${esc(t.description)}*${t.details ? `\n${esc(t.details)}` : ""}${meta.length ? `\n${meta.join("   ")}` : ""}`, 2900) },
      });
    }
    if (open.length > shown.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `…and ${open.length - shown.length} more` }] });
  }
  if (url) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${url}|Open in Debrief>${open.some((t) => t.status === "pending") ? `  ·  <${url}#tasks|Review the action items>` : ""}` }],
    });
  }
  const text = `${m.displayTitle}: ${m.transcript.summary ? cut(m.transcript.summary, 200) : "notes ready"}`;
  return { text, blocks };
}

export async function postToSlack(m: Meeting) {
  const hook = slackWebhookFor(m.context);
  if (!hook) return false;
  const res = await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(slackMessage(m)),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Slack: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return true;
}

/**
 * Saves the notes file and tells Slack, once per meeting unless `again`
 * (the "Send to Slack" button). Each step's failure is reported, not thrown.
 */
export async function publishMeeting(db: Db, transcriptId: string, opts: { again?: boolean } = {}) {
  const m = await getMeeting(db, transcriptId);
  if (!m) throw new Error("No such transcript.");
  const out: { notes: string | null; slack: boolean; errors: string[] } = { notes: null, slack: false, errors: [] };
  try {
    out.notes = await writeMeetingNotes(m);
  } catch (err) {
    out.errors.push(`Notes: ${(err as Error).message}`);
  }
  if (opts.again || !m.transcript.notifiedAt) {
    try {
      out.slack = await postToSlack(m);
      if (out.slack) await db.update(transcripts).set({ notifiedAt: new Date() }).where(eq(transcripts.id, transcriptId));
    } catch (err) {
      out.errors.push((err as Error).message);
    }
  }
  return out;
}

/** Asks calendar-sync to publish a meeting (it holds the exports mount and the Slack hook). */
export async function requestPublish(db: Db, transcriptId: string, again = false) {
  await db.execute(sql`select pg_notify('debrief_summarized', ${JSON.stringify({ id: transcriptId, again })})`);
}
