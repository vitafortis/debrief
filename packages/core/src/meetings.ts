import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "./db";
import {
  calendarEvents,
  calendars,
  devices,
  eventAttendees,
  recordings,
  tasks,
  transcriptEvents,
  transcripts,
  DEVICE_COLORS,
  type DeviceColor,
  type RecordingStatus,
  type TaskDestination,
} from "./schema";
import { overlapScore, matchThreshold } from "./correlate";
import { HL_END, HL_START } from "./search";

/** What a meeting is called: a title set by hand, its calendar event's, the recorder's, or the date. */
export function meetingTitle(m: { title?: string | null; eventTitle?: string | null; titleHint?: string | null; recordedAt: Date }) {
  return (
    m.title?.trim() ||
    m.eventTitle ||
    m.titleHint?.trim() ||
    `Recording ${m.recordedAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
  );
}

// The best-scoring linked event per transcript.
const primaryEvent = (db: Db) =>
  db
    .selectDistinctOn([transcriptEvents.transcriptId], {
      transcriptId: transcriptEvents.transcriptId,
      eventId: transcriptEvents.eventId,
      confidence: transcriptEvents.confidence,
      manual: transcriptEvents.manual,
    })
    .from(transcriptEvents)
    .orderBy(transcriptEvents.transcriptId, desc(transcriptEvents.manual), desc(transcriptEvents.confidence))
    .as("pe");

/** A meeting's context: its calendar's, else its device's when one is set in Settings. */
export const meetingContext = sql<string | null>`coalesce(${calendars.context}, ${devices.context})`;

export type MeetingFilter = {
  /** A calendar context ("acme"), or "unmatched" for meetings with no event. */
  context?: string | null;
  from?: Date;
  to?: Date;
  /** Words in the title, summary or transcript (web-search syntax), or part of the title. */
  q?: string | null;
  /** The device it was recorded on. */
  device?: string | null;
  /** Part of an attendee's name or email. */
  attendee?: string | null;
  limit?: number;
  offset?: number;
};

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listMeetings(db: Db, f: MeetingFilter = {}) {
  const pe = primaryEvent(db);
  const where: SQL[] = [];
  if (f.from) where.push(gte(recordings.recordedAt, f.from));
  if (f.to) where.push(lt(recordings.recordedAt, f.to));
  if (f.context === "unmatched") where.push(sql`${pe.eventId} is null`);
  else if (f.context) where.push(sql`${meetingContext} = ${f.context}`);
  const q = f.q?.trim();
  const query = sql`websearch_to_tsquery('english', ${q ?? ""})`;
  if (q) {
    where.push(
      sql`(${transcripts.searchVector} @@ ${query} or coalesce(${transcripts.title}, ${calendarEvents.title}, ${recordings.titleHint}, '') ilike ${like(q)})`
    );
  }
  if (f.device) where.push(eq(recordings.device, f.device));
  const attendee = f.attendee?.trim();
  if (attendee) {
    where.push(sql`exists (
      select 1 from ${transcriptEvents} te join ${eventAttendees} a on a.event_id = te.event_id
      where te.transcript_id = ${transcripts.id} and (a.name ilike ${like(attendee)} or a.email ilike ${like(attendee)}))`);
  }

  const rows = await db
    .select({
      id: transcripts.id,
      title: transcripts.title,
      summary: transcripts.summary,
      recordedAt: recordings.recordedAt,
      durationSecs: recordings.durationSecs,
      device: recordings.device,
      titleHint: recordings.titleHint,
      eventId: calendarEvents.id,
      eventTitle: calendarEvents.title,
      eventStart: calendarEvents.startAt,
      confidence: pe.confidence,
      context: meetingContext,
      calendarName: calendars.name,
      openTasks: sql<number>`(select count(*)::int from ${tasks} where ${tasks.transcriptId} = ${transcripts.id} and ${tasks.status} in ('pending','approved'))`,
      attendeeCount: sql<number>`(select count(*)::int from ${eventAttendees} where ${eventAttendees.eventId} = ${calendarEvents.id})`,
      // Where the words were said, matched words between HL_START and HL_END.
      excerpt: q
        ? sql<string | null>`case when ${transcripts.searchVector} @@ ${query} then ts_headline('english', ${transcripts.content}, ${query},
            ${`StartSel=${HL_START}, StopSel=${HL_END}, MaxWords=30, MinWords=10, ShortWord=2, MaxFragments=1`}) end`
        : sql<string | null>`null`,
    })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .leftJoin(pe, eq(pe.transcriptId, transcripts.id))
    .leftJoin(calendarEvents, eq(calendarEvents.id, pe.eventId))
    .leftJoin(calendars, eq(calendars.id, calendarEvents.calendarId))
    .leftJoin(devices, eq(devices.name, recordings.device))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(recordings.recordedAt))
    .limit(f.limit ?? 50)
    .offset(f.offset ?? 0);
  return rows.map((r) => ({ ...r, displayTitle: meetingTitle(r), untitled: isUntitled(r) }));
}

/** No title set by hand, no calendar event and nothing from the recorder: the UI shows "Untitled" and the device instead of the date. */
export const isUntitled = (m: { title?: string | null; eventTitle?: string | null; titleHint?: string | null }) =>
  !m.title?.trim() && !m.eventTitle && !m.titleHint?.trim();

export type MeetingSummary = Awaited<ReturnType<typeof listMeetings>>[number];

/** One meeting: transcript, recording, every linked event with attendees, and its tasks. */
export async function getMeeting(db: Db, transcriptId: string) {
  const [row] = await db
    .select({ transcript: transcripts, recording: recordings })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .where(eq(transcripts.id, transcriptId));
  if (!row) return null;

  const events = await db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      organizerEmail: calendarEvents.organizerEmail,
      conferenceUrl: calendarEvents.conferenceUrl,
      confidence: transcriptEvents.confidence,
      manual: transcriptEvents.manual,
      context: calendars.context,
      calendarName: calendars.name,
      defaultDestination: calendars.defaultDestination,
    })
    .from(transcriptEvents)
    .innerJoin(calendarEvents, eq(calendarEvents.id, transcriptEvents.eventId))
    .innerJoin(calendars, eq(calendars.id, calendarEvents.calendarId))
    .where(eq(transcriptEvents.transcriptId, transcriptId))
    .orderBy(desc(transcriptEvents.manual), desc(transcriptEvents.confidence));

  const attendees = events.length
    ? await db
        .select()
        .from(eventAttendees)
        .where(inArray(eventAttendees.eventId, events.map((e) => e.id)))
        .orderBy(asc(eventAttendees.name), asc(eventAttendees.email))
    : [];

  const [device] = row.recording.device ? await db.select().from(devices).where(eq(devices.name, row.recording.device)) : [];
  const taskRows = await db.select().from(tasks).where(eq(tasks.transcriptId, transcriptId)).orderBy(asc(tasks.itemNumber));
  const event = events[0] ?? null;
  return {
    ...row,
    event,
    events,
    attendees: event ? attendees.filter((a) => a.eventId === event.id) : [],
    tasks: taskRows,
    context: event?.context ?? device?.context ?? null,
    /** Where this meeting's tasks go unless chosen per task. */
    defaultDestination: event?.defaultDestination ?? device?.defaultDestination ?? "akiflow",
    displayTitle: meetingTitle({
      title: row.transcript.title,
      eventTitle: event?.title,
      titleHint: row.recording.titleHint,
      recordedAt: row.recording.recordedAt,
    }),
  };
}

export type Meeting = NonNullable<Awaited<ReturnType<typeof getMeeting>>>;

/** Recordings not transcribed yet, or that failed, for the queue on the dashboard. */
export async function listQueue(db: Db) {
  return db
    .select()
    .from(recordings)
    .where(inArray(recordings.status, ["pending", "processing", "error"]))
    .orderBy(desc(recordings.recordedAt))
    .limit(50);
}

export type EventStatus = "none" | RecordingStatus;

/**
 * Calendar events in a range with where their recording is at: "done" with
 * the transcript id once linked, or the status of a recording that overlaps
 * it but hasn't been transcribed yet.
 */
export async function listEventsWithStatus(db: Db, from: Date, to: Date, context?: string | null) {
  const where = [gte(calendarEvents.endAt, from), lt(calendarEvents.startAt, to), eq(calendarEvents.cancelled, false), eq(calendars.enabled, true)];
  if (context) where.push(eq(calendars.context, context));
  const events = await db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      allDay: calendarEvents.allDay,
      conferenceUrl: calendarEvents.conferenceUrl,
      context: calendars.context,
      calendarName: calendars.name,
      transcriptId: sql<string | null>`(select ${transcriptEvents.transcriptId} from ${transcriptEvents} where ${transcriptEvents.eventId} = ${calendarEvents.id} order by ${transcriptEvents.confidence} desc limit 1)`,
    })
    .from(calendarEvents)
    .innerJoin(calendars, eq(calendars.id, calendarEvents.calendarId))
    .where(and(...where))
    .orderBy(asc(calendarEvents.startAt));

  const unfinished = await db
    .select({ recordedAt: recordings.recordedAt, durationSecs: recordings.durationSecs, status: recordings.status })
    .from(recordings)
    .where(and(inArray(recordings.status, ["pending", "processing", "error"]), gte(recordings.recordedAt, new Date(from.getTime() - 86400_000)), lt(recordings.recordedAt, to)));

  return events.map((e) => {
    let status: EventStatus = e.transcriptId ? "done" : "none";
    if (!e.transcriptId && !e.allDay) {
      const rec = unfinished.find((r) => {
        // Duration isn't known until it's read: assume it covers the meeting.
        const end = r.durationSecs ? new Date(r.recordedAt.getTime() + r.durationSecs * 1000) : e.endAt;
        return overlapScore({ start: r.recordedAt, end }, { start: e.startAt, end: e.endAt }) >= matchThreshold();
      });
      if (rec) status = rec.status;
    }
    return { ...e, status };
  });
}

export async function listContexts(db: Db) {
  const [cals, devs] = await Promise.all([
    db.selectDistinct({ context: calendars.context }).from(calendars).where(eq(calendars.enabled, true)),
    db.selectDistinct({ context: devices.context }).from(devices).where(isNotNull(devices.context)),
  ]);
  return [...new Set([...cals, ...devs].map((r) => r.context!))].sort();
}

/** Every device recordings came from, with its rule (none until set in Settings). */
export async function listDevices(db: Db) {
  const rows = await db.execute<{
    name: string;
    context: string | null;
    default_destination: TaskDestination | null;
    label: string | null;
    color: DeviceColor | null;
    recordings: number;
    last_recording: string | null;
    last_seen_at: string | null;
  }>(sql`
    with seen as (
      select device as name, count(*)::int as recordings, max(recorded_at) as last_recording
      from ${recordings} where device is not null group by device
    )
    select coalesce(d.name, s.name) as name, d.context, d.default_destination, d.label, d.color, coalesce(s.recordings, 0) as recordings,
           s.last_recording, d.last_seen_at
    from ${devices} d full outer join seen s on s.name = d.name
    order by greatest(s.last_recording, d.last_seen_at) desc nulls last, 1`);
  return rows.rows.map((r) => ({
    name: r.name,
    context: r.context,
    defaultDestination: r.default_destination,
    label: r.label,
    color: r.color,
    badge: deviceBadge(r.name, r.label, r.color),
    recordings: r.recordings,
    lastActive: [r.last_recording, r.last_seen_at].filter(Boolean).map((d) => new Date(d!)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
  }));
}

export async function setDeviceRule(
  db: Db,
  name: string,
  rule: { context?: string | null; defaultDestination?: TaskDestination | null; label?: string | null; color?: DeviceColor | null }
) {
  const set = {
    ...(rule.context !== undefined ? { context: rule.context?.trim() || null } : {}),
    ...(rule.defaultDestination !== undefined ? { defaultDestination: rule.defaultDestination } : {}),
    ...(rule.label !== undefined ? { label: rule.label?.trim() || null } : {}),
    ...(rule.color !== undefined ? { color: rule.color } : {}),
  };
  await db.insert(devices).values({ name, ...set }).onConflictDoUpdate({ target: devices.name, set });
}

export type DeviceBadge = { label: string; color: DeviceColor };

/** How a device's badge reads and looks: its label, else its name; its color, else one picked from its name so it stays the same. */
export function deviceBadge(name: string, label?: string | null, color?: DeviceColor | null): DeviceBadge {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { label: label?.trim() || name, color: color ?? DEVICE_COLORS[h % DEVICE_COLORS.length] };
}

/** Every device's badge by name, including devices that have recorded but were never configured. */
export async function deviceBadges(db: Db): Promise<Record<string, DeviceBadge>> {
  const [configured, seen] = await Promise.all([
    db.select({ name: devices.name, label: devices.label, color: devices.color }).from(devices),
    db.selectDistinct({ name: recordings.device }).from(recordings).where(isNotNull(recordings.device)),
  ]);
  const out: Record<string, DeviceBadge> = {};
  for (const { name } of seen) out[name!] = deviceBadge(name!);
  for (const d of configured) out[d.name] = deviceBadge(d.name, d.label, d.color);
  return out;
}

/** Notes that a meeting has been opened, the first time it is. */
export async function markViewed(db: Db, transcriptId: string) {
  await db.update(transcripts).set({ viewedAt: new Date() }).where(and(eq(transcripts.id, transcriptId), sql`${transcripts.viewedAt} is null`));
}

/** Transcripts that are ready but haven't been opened yet, newest first. */
export async function listUnviewed(db: Db, context?: string | null, limit = 4) {
  const rows = await listMeetingsWhere(db, [sql`${transcripts.viewedAt} is null`, ...(context ? [sql`${meetingContext} = ${context}`] : [])], 200);
  return { count: rows.length, items: rows.slice(0, limit) };
}

export type CleanupIssue = "empty" | "untitled" | "no-event" | "speakers" | "no-summary" | "tasks";

/** Recent transcripts that still need something: a name, an event, speaker names, a summary, tasks reviewed, or that are empty. */
export async function listCleanup(db: Db, context?: string | null, limit = 50) {
  const rows = await listMeetingsWhere(db, context ? [sql`${meetingContext} = ${context}`] : [], 300);
  return rows
    .map((m) => {
      const issues: CleanupIssue[] = [];
      if (m.empty) issues.push("empty");
      else {
        if (m.untitled) issues.push("untitled");
        if (!m.eventId) issues.push("no-event");
        if (m.unnamedSpeakers) issues.push("speakers");
        if (!m.summary) issues.push("no-summary");
        if (m.pendingTasks) issues.push("tasks");
      }
      return { ...m, issues };
    })
    .filter((m) => m.issues.length)
    .slice(0, limit);
}

/** Transcripts with their title, event and what the home page needs to know about them, newest first. */
async function listMeetingsWhere(db: Db, where: SQL[], limit: number) {
  const pe = primaryEvent(db);
  const rows = await db
    .select({
      id: transcripts.id,
      title: transcripts.title,
      summary: transcripts.summary,
      recordedAt: recordings.recordedAt,
      durationSecs: recordings.durationSecs,
      device: recordings.device,
      titleHint: recordings.titleHint,
      eventId: calendarEvents.id,
      eventTitle: calendarEvents.title,
      context: meetingContext,
      empty: sql<boolean>`(${recordings.durationSecs} = 0 or length(trim(${transcripts.content})) = 0)`,
      // Diarized labels with no name given. "YOU" and "OTHERS" (the recorder's two sides) read fine as they are.
      unnamedSpeakers: sql<boolean>`exists (select 1 from jsonb_array_elements(coalesce(${transcripts.speakerSegments}, '[]'::jsonb)) s
        where s->>'speaker' ~ '^SPEAKER_[0-9]+$' and not (${transcripts.speakerNames} ? (s->>'speaker')))`,
      pendingTasks: sql<number>`(select count(*)::int from ${tasks} where ${tasks.transcriptId} = ${transcripts.id} and ${tasks.status} = 'pending')`,
    })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .leftJoin(pe, eq(pe.transcriptId, transcripts.id))
    .leftJoin(calendarEvents, eq(calendarEvents.id, pe.eventId))
    .leftJoin(calendars, eq(calendars.id, calendarEvents.calendarId))
    .leftJoin(devices, eq(devices.name, recordings.device))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(recordings.recordedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, displayTitle: meetingTitle(r), untitled: isUntitled(r) }));
}
