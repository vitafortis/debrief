import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const ts = (name: string) => timestamp(name, { withTimezone: true });

/** One speaker turn from diarized transcription. Times are seconds from the start. */
export type SpeakerSegment = { speaker: string | null; start: number; end: number; text: string };

export const RECORDING_STATUSES = ["pending", "processing", "done", "error"] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const TASK_STATUSES = ["pending", "approved", "pushed", "dismissed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_DESTINATIONS = ["akiflow", "linear"] as const;
export type TaskDestination = (typeof TASK_DESTINATIONS)[number];
export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * A calendar Debrief reads. `context` ("ironclad", "pwnbook") is what splits
 * work from side projects: meetings, search and task routing filter on it.
 */
export const calendars = pgTable(
  "calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(), // 'google' | 'ics'
    externalId: text("external_id").notNull(), // Google calendar id, or the ICS feed URL
    name: text("name").notNull(),
    context: text("context").notNull().default("default"),
    // Where approved tasks from this calendar's meetings go unless chosen per task.
    defaultDestination: text("default_destination").$type<TaskDestination>().notNull().default("akiflow"),
    enabled: boolean("enabled").notNull().default(true),
    lastSyncedAt: ts("last_synced_at"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendars_source_external").on(t.source, t.externalId)]
);

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    cancelled: boolean("cancelled").notNull().default(false),
    organizerEmail: text("organizer_email"),
    conferenceUrl: text("conference_url"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("calendar_events_calendar_external").on(t.calendarId, t.externalId),
    index("calendar_events_start").on(t.startAt),
  ]
);

export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    rsvpStatus: text("rsvp_status"), // 'accepted' | 'declined' | 'tentative' | 'needsAction'
  },
  (t) => [uniqueIndex("event_attendees_event_email").on(t.eventId, t.email)]
);

/** Audio files found under the recordings folder. The transcriber owns these rows. */
export const recordings = pgTable(
  "recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    filePath: text("file_path").notNull().unique(), // relative to the audio root
    fileSize: bigint("file_size", { mode: "number" }),
    durationSecs: integer("duration_secs"),
    recordedAt: ts("recorded_at").notNull(),
    device: text("device"),
    titleHint: text("title_hint"), // e.g. Meetily's meeting name
    // Peak levels (0–1) across the recording, so the player draws the waveform without downloading the file.
    waveform: jsonb("waveform").$type<number[]>(),
    status: text("status").$type<RecordingStatus>().notNull().default("pending"),
    progress: real("progress"), // 0–1 while processing
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("recordings_recorded_at").on(t.recordedAt), index("recordings_status").on(t.status)]
);

export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .unique()
      .references(() => recordings.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    speakerSegments: jsonb("speaker_segments").$type<SpeakerSegment[]>(),
    // Names given to diarized speakers: { "SPEAKER_00": "Sarah" }.
    speakerNames: jsonb("speaker_names").$type<Record<string, string>>().notNull().default({}),
    title: text("title"), // set by hand; otherwise the meeting's title is used
    summary: text("summary"),
    language: text("language").default("en"),
    modelVersion: text("model_version"),
    processedAt: ts("processed_at").notNull().defaultNow(),
    tasksExtractedAt: ts("tasks_extracted_at"),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || content)`
    ),
  },
  (t) => [index("idx_transcripts_search").using("gin", t.searchVector)]
);

/** Which calendar event a transcript belongs to, scored by time overlap. */
export const transcriptEvents = pgTable(
  "transcript_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    confidence: real("confidence").notNull(), // 0–1; 1 for a link made by hand
    manual: boolean("manual").notNull().default(false),
  },
  (t) => [uniqueIndex("transcript_events_pair").on(t.transcriptId, t.eventId)]
);

/** Action items pulled from a transcript, reviewed, then pushed to Akiflow or Linear. */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    itemNumber: integer("item_number").notNull(), // stable per transcript, for Akiflow dedup
    assignee: text("assignee"),
    description: text("description").notNull(),
    details: text("details"),
    dueDate: date("due_date"),
    priority: text("priority").$type<Priority>(),
    context: text("context"),
    destination: text("destination").$type<TaskDestination>(),
    status: text("status").$type<TaskStatus>().notNull().default("pending"),
    sourceStart: real("source_start"), // where in the recording it was said, in seconds
    pushedTo: text("pushed_to").$type<TaskDestination>(),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    pushError: text("push_error"),
    pushedAt: ts("pushed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tasks_transcript_item").on(t.transcriptId, t.itemNumber),
    index("tasks_status").on(t.status),
  ]
);
