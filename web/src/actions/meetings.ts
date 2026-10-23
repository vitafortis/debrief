"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { extractWithClaude, linkTranscript, recordings, requestPublish, slackConfigured, transcripts } from "@debrief/core";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";

const uuid = z.uuid();
type Result = { ok: true; message?: string } | { ok: false; error: string };

async function run(fn: () => Promise<string | void>, ...paths: string[]): Promise<Result> {
  try {
    await requireViewer();
    const message = (await fn()) ?? undefined;
    for (const p of paths) revalidatePath(p);
    return { ok: true, message };
  } catch (err) {
    return { ok: false, error: err instanceof z.ZodError ? "That doesn't look right." : (err as Error).message };
  }
}

export async function renameMeeting(transcriptId: string, title: string) {
  return run(async () => {
    const t = z.string().trim().max(200).parse(title);
    await db().update(transcripts).set({ title: t || null }).where(eq(transcripts.id, uuid.parse(transcriptId)));
  }, `/meetings/${transcriptId}`);
}

export async function renameSpeakers(transcriptId: string, names: Record<string, string>) {
  return run(async () => {
    const clean = Object.fromEntries(
      Object.entries(z.record(z.string().max(40), z.string().max(80)).parse(names))
        .map(([k, v]) => [k, v.trim()])
        .filter(([, v]) => v)
    );
    await db().update(transcripts).set({ speakerNames: clean }).where(eq(transcripts.id, uuid.parse(transcriptId)));
  }, `/meetings/${transcriptId}`);
}

export async function saveSummary(transcriptId: string, summary: string) {
  return run(async () => {
    const s = z.string().trim().max(4000).parse(summary);
    await db().update(transcripts).set({ summary: s || null }).where(eq(transcripts.id, uuid.parse(transcriptId)));
    // Rewrites the notes file, and tells Slack if it hasn't heard about this meeting yet.
    if (s) await requestPublish(db(), transcriptId);
  }, `/meetings/${transcriptId}`);
}

/** Posts the meeting's summary and action items to Slack again, and rewrites its notes file. */
export async function sendToSlack(transcriptId: string) {
  return run(async () => {
    if (!slackConfigured()) throw new Error("Set SLACK_WEBHOOK_URL (or SLACK_WEBHOOKS per context) first.");
    await requestPublish(db(), uuid.parse(transcriptId), true);
    return "Sending to Slack.";
  }, `/meetings/${transcriptId}`);
}

/** Links a meeting to a calendar event by hand, or (null) goes back to matching by time. */
export async function setMeetingEvent(transcriptId: string, eventId: string | null) {
  return run(async () => {
    await linkTranscript(db(), uuid.parse(transcriptId), eventId ? uuid.parse(eventId) : null);
  }, `/meetings/${transcriptId}`, "/meetings", "/calendar");
}

export async function retranscribe(recordingId: string) {
  return run(async () => {
    await db()
      .update(recordings)
      .set({ status: "pending", progress: null, error: null })
      .where(eq(recordings.id, uuid.parse(recordingId)));
    return "Queued. The transcriber picks it up on its next pass.";
  }, "/");
}

export async function extractTasks(transcriptId: string) {
  return run(async () => {
    const out = await extractWithClaude(db(), uuid.parse(transcriptId));
    return out.tasks.length ? `Found ${out.tasks.length} action items.` : "No action items in this one.";
  }, `/meetings/${transcriptId}`, "/tasks", "/");
}

/** Asks calendar-sync to sync now (it listens on this channel). */
export async function syncCalendarsNow() {
  return run(async () => {
    await db().execute(sql`select pg_notify('debrief_sync_now', '')`);
    return "Syncing calendars…";
  }, "/settings");
}
