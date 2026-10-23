// Against a real Postgres: TEST_DATABASE_URL (it is wiped). Skipped without one.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to run";
if (url) process.env.DATABASE_URL = url;

const core = url ? await import("../src/index") : null;
const { storeEvents, normalizeIcs } = url ? await import("../src/calendar-sync") : ({} as never);
const { runMigrations } = url ? await import("../src/migrate") : ({} as never);

let transcriptId = "";
let calendarId = "";

before(async () => {
  if (!core) return;
  await runMigrations();
  const db = core.getDb();
  await db.execute(sql`truncate calendars, recordings cascade`);
  const [cal] = await db.insert(core.calendars).values({ source: "ics", externalId: "https://x.example/a.ics", name: "Work", context: "ironclad" }).returning();
  calendarId = cal.id;
  const [rec] = await db
    .insert(core.recordings)
    .values({ filePath: "mac-work/a/audio.mp4", recordedAt: new Date("2026-10-22T14:02:00Z"), durationSecs: 1500, status: "done" })
    .returning();
  const [t] = await db
    .insert(core.transcripts)
    .values({
      recordingId: rec.id,
      content: "We need the quarterly pricing deck. I will send the pricing deck by Friday.",
      speakerSegments: [
        { speaker: "SPEAKER_00", start: 3, end: 6, text: "We need the quarterly pricing deck." },
        { speaker: "SPEAKER_01", start: 7, end: 10, text: "I will send the pricing deck by Friday." },
      ],
      speakerNames: { SPEAKER_01: "Sam" },
    })
    .returning();
  transcriptId = t.id;
});

after(async () => {
  await core?.closeDb();
});

test("events sync in, and the transcript links to the one it overlaps", { skip }, async () => {
  const db = core!.getDb();
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:a",
    "DTSTAMP:20261001T000000Z",
    "DTSTART:20261022T140000Z",
    "DTEND:20261022T143000Z",
    "SUMMARY:Pricing review",
    "ATTENDEE;CN=Sam:mailto:sam@example.com",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:b",
    "DTSTAMP:20261001T000000Z",
    "DTSTART:20261022T160000Z",
    "DTEND:20261022T163000Z",
    "SUMMARY:Later",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const from = new Date("2026-10-01T00:00:00Z");
  const to = new Date("2026-11-01T00:00:00Z");
  await storeEvents(db, { id: calendarId, source: "ics" }, normalizeIcs(ics, from, to), from, to);
  const matches = await core!.correlateTranscript(db, transcriptId);
  assert.equal(matches.length, 1);
  const m = await core!.getMeeting(db, transcriptId);
  assert.equal(m!.displayTitle, "Pricing review");
  assert.equal(m!.context, "ironclad");
  assert.deepEqual(m!.attendees.map((a) => a.email), ["sam@example.com"]);

  // Resync without the event: it's deleted and the link goes with it.
  await storeEvents(db, { id: calendarId, source: "ics" }, normalizeIcs(ics.replace(/BEGIN:VEVENT\r\nUID:a[\s\S]*?END:VEVENT\r\n/, ""), from, to), from, to);
  assert.equal((await core!.getMeeting(db, transcriptId))!.event, null);
});

test("search finds the line, the speaker's name and the time", { skip }, async () => {
  const db = core!.getDb();
  const [hit] = await core!.searchTranscripts(db, "pricing deck Friday");
  assert.equal(hit.transcriptId, transcriptId);
  const x = hit.excerpts.find((e) => e.start === 7)!;
  assert.equal(hit.speakerNames[x.speaker!], "Sam");
  assert.match(x.text, new RegExp(`${core!.HL_START}Friday${core!.HL_END}`));
  assert.equal((await core!.searchTranscripts(db, "pricing", { context: "pwnbook" })).length, 0);
});

test("extracting again keeps reviewed tasks and replaces unreviewed ones", { skip }, async () => {
  const db = core!.getDb();
  const first = await core!.saveExtractedTasks(db, transcriptId, [{ description: "Send the pricing deck" }, { description: "Book a follow-up" }]);
  assert.deepEqual(first.map((t) => t.itemNumber), [1, 2]);
  await core!.setTaskStatus(db, [first[0].id], "approved");
  const second = await core!.saveExtractedTasks(db, transcriptId, [{ description: "Share the notes" }]);
  // Numbering continues after the kept ones; an unreviewed item's number was never sent anywhere, so reusing it is safe.
  assert.deepEqual(second.map((t) => t.itemNumber), [2]);
  const all = await core!.listTasks(db, { transcriptId });
  assert.deepEqual(all.map((r) => r.task.description), ["Send the pricing deck", "Share the notes"]);
});
