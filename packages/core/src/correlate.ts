import { and, eq, gt, lt, notExists, sql } from "drizzle-orm";
import type { Db } from "./db";
import { calendarEvents, recordings, transcriptEvents, transcripts } from "./schema";

/** Share of the overlap needed to link a recording to an event. */
export const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 0.7);

type Interval = { start: Date; end: Date };

/**
 * How well a recording lines up with an event, 0–1: the overlap as a share of
 * the shorter of the two. Joining 10 minutes late, or leaving early, still
 * scores 1 as long as the recording sits inside the meeting; a recording that
 * runs on past a short meeting scores against the meeting's length.
 */
export function overlapScore(rec: Interval, event: Interval): number {
  const overlap = Math.min(rec.end.getTime(), event.end.getTime()) - Math.max(rec.start.getTime(), event.start.getTime());
  if (overlap <= 0) return 0;
  const shorter = Math.min(rec.end.getTime() - rec.start.getTime(), event.end.getTime() - event.start.getTime());
  return shorter > 0 ? Math.min(1, overlap / shorter) : 0;
}

export type Candidate = Interval & { id: string; hasConference: boolean };

/**
 * The events a recording belongs to: every candidate at or above the
 * threshold, best first. Back-to-back meetings caught in one recording both
 * match; on equal scores, events with a call link come first.
 */
export function rankMatches(rec: Interval, candidates: Candidate[], threshold = MATCH_THRESHOLD) {
  return candidates
    .map((c) => ({ id: c.id, score: overlapScore(rec, c), hasConference: c.hasConference }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score || Number(b.hasConference) - Number(a.hasConference));
}

/**
 * Re-links one transcript to calendar events by time. Links made by hand are
 * left alone (and stop automatic matching for that transcript).
 */
export async function correlateTranscript(db: Db, transcriptId: string) {
  const [row] = await db
    .select({ recordedAt: recordings.recordedAt, durationSecs: recordings.durationSecs })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .where(eq(transcripts.id, transcriptId));
  if (!row) return [];
  const manual = await db
    .select({ id: transcriptEvents.id })
    .from(transcriptEvents)
    .where(and(eq(transcriptEvents.transcriptId, transcriptId), eq(transcriptEvents.manual, true)));
  if (manual.length) return [];

  const start = row.recordedAt;
  const end = new Date(start.getTime() + Math.max(60, row.durationSecs ?? 0) * 1000);
  const events = await db
    .select({ id: calendarEvents.id, start: calendarEvents.startAt, end: calendarEvents.endAt, url: calendarEvents.conferenceUrl })
    .from(calendarEvents)
    .where(
      and(
        lt(calendarEvents.startAt, end),
        gt(calendarEvents.endAt, start),
        eq(calendarEvents.allDay, false),
        eq(calendarEvents.cancelled, false)
      )
    );
  const matches = rankMatches(
    { start, end },
    events.map((e) => ({ id: e.id, start: e.start, end: e.end, hasConference: !!e.url }))
  );

  await db.transaction(async (tx) => {
    await tx.delete(transcriptEvents).where(eq(transcriptEvents.transcriptId, transcriptId));
    if (matches.length) {
      await tx
        .insert(transcriptEvents)
        .values(matches.map((m) => ({ transcriptId, eventId: m.id, confidence: Number(m.score.toFixed(3)) })));
    }
  });
  return matches;
}

/**
 * Matches transcripts that have no event yet, newest first. Run after each
 * calendar sync, since a recording is often transcribed before the event
 * that explains it has been synced (or when the meeting was moved).
 */
export async function correlateUnmatched(db: Db, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400_000);
  const rows = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .where(
      and(
        gt(recordings.recordedAt, since),
        notExists(db.select({ one: sql`1` }).from(transcriptEvents).where(eq(transcriptEvents.transcriptId, transcripts.id)))
      )
    );
  let linked = 0;
  for (const r of rows) if ((await correlateTranscript(db, r.id)).length) linked++;
  return { checked: rows.length, linked };
}

/** Links a transcript to an event by hand, replacing any automatic matches; null goes back to automatic matching. */
export async function linkTranscript(db: Db, transcriptId: string, eventId: string | null) {
  await db.transaction(async (tx) => {
    await tx.delete(transcriptEvents).where(eq(transcriptEvents.transcriptId, transcriptId));
    if (eventId) await tx.insert(transcriptEvents).values({ transcriptId, eventId, confidence: 1, manual: true });
  });
  if (!eventId) await correlateTranscript(db, transcriptId);
}
