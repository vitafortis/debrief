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
  await db.execute(sql`truncate calendars, recordings, devices, uploads, api_keys cascade`);
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

test("an API key works until it's deleted, and only its hash is kept", { skip }, async () => {
  const db = core!.getDb();
  const k = await core!.createApiKey(db, "Work MacBook");
  assert.match(k.key, /^dbk_/);
  assert.equal((await core!.verifyApiKey(db, k.key))?.name, "Work MacBook");
  assert.equal(await core!.verifyApiKey(db, k.key + "x"), null);
  const rows = await db.execute(sql`select hash from api_keys where id = ${k.id}`);
  assert.notEqual(rows.rows[0].hash, k.key);
  await core!.deleteApiKey(db, k.id);
  assert.equal(await core!.verifyApiKey(db, k.key), null);
});

test("an upload resumes at the right offset and finishes as a Meetily-style folder", { skip }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Readable } = await import("node:stream");
  const up = await import("../src/uploads");
  const db = core!.getDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-up-"));
  const id = "3b8f1c2a-0000-4000-8000-000000000001";
  const chunk = (s: string) => Readable.from([Buffer.from(s)]);

  const s0 = await up.startUpload(db, id, { device: "Nathan's MacBook Pro", startedAt: "2026-10-22T18:00:00Z", app: "zoom.us", format: "opus" }, null, root);
  assert.equal(s0!.offset, 0);
  const a = await up.appendUpload(db, id, 0, chunk("hello "), 6, root);
  assert.equal(a.offset, 6);
  // A retried chunk at a stale offset writes nothing and says where to resume.
  await assert.rejects(up.appendUpload(db, id, 0, chunk("hello "), 6, root), (e: InstanceType<typeof up.UploadError>) => e.status === 409 && e.offset === 6);
  // Starting again (the recorder restarted) is the same upload.
  assert.equal((await up.startUpload(db, id, { device: "Nathan's MacBook Pro", startedAt: "2026-10-22T18:00:00Z", format: "opus" }, null, root))!.offset, 6);
  await up.appendUpload(db, id, 6, chunk("world"), 5, root);
  await assert.rejects(up.finishUpload(db, id, { bytes: 99, durationSecs: 60 }, root), (e: InstanceType<typeof up.UploadError>) => e.status === 409);
  const done = await up.finishUpload(db, id, { bytes: 11, durationSecs: 60, title: "Pricing sync" }, root);
  assert.equal(done!.status, "completed");

  const [u] = await db.select().from(core!.uploads).where(sql`id = ${id}`);
  assert.equal(u.device, "nathans-macbook-pro");
  assert.match(u.folder, /^nathans-macbook-pro\/2026-10-22_\d\d-00-00_3b8f1c2a$/);
  assert.equal(fs.readFileSync(path.join(root, u.folder, "audio.opus"), "utf8"), "hello world");
  const meta = JSON.parse(fs.readFileSync(path.join(root, u.folder, "metadata.json"), "utf8"));
  assert.deepEqual([meta.status, meta.created_at, meta.meeting_name, meta.duration_seconds], ["completed", "2026-10-22T18:00:00.000Z", "Pricing sync", 60]);
  // The device shows up, untagged.
  const dev = (await core!.listDevices(db)).find((d) => d.name === "nathans-macbook-pro");
  assert.equal(dev?.context, null);
  fs.rmSync(root, { recursive: true });
});

test("a device's context applies only once set, and a calendar event wins over it", { skip }, async () => {
  const db = core!.getDb();
  const [rec] = await db
    .insert(core!.recordings)
    .values({ filePath: "home-pc/b/audio.opus", recordedAt: new Date("2026-10-23T02:00:00Z"), durationSecs: 600, status: "done", device: "home-pc" })
    .returning();
  const [t] = await db.insert(core!.transcripts).values({ recordingId: rec.id, content: "Roadmap for the side project." }).returning();
  assert.equal((await core!.getMeeting(db, t.id))!.context, null);
  await core!.setDeviceRule(db, "home-pc", { context: "pwnbook", defaultDestination: "linear" });
  const m = await core!.getMeeting(db, t.id);
  assert.equal(m!.context, "pwnbook");
  assert.equal(m!.defaultDestination, "linear");
  assert.deepEqual((await core!.listMeetings(db, { context: "pwnbook" })).map((x) => x.id), [t.id]);
  assert.ok((await core!.listContexts(db)).includes("pwnbook"));
  const [task] = await core!.saveExtractedTasks(db, t.id, [{ description: "Draft the roadmap" }]);
  assert.deepEqual([task.context, task.destination], ["pwnbook", "linear"]);
  // A device rule never overrides a calendar: the same device, now with an ironclad event over the recording.
  const [ev] = await db
    .insert(core!.calendarEvents)
    .values({ source: "ics", externalId: "c", calendarId, title: "Vendor call", startAt: new Date("2026-10-23T02:00:00Z"), endAt: new Date("2026-10-23T02:10:00Z") })
    .returning();
  await core!.linkTranscript(db, t.id, ev.id);
  assert.equal((await core!.getMeeting(db, t.id))!.context, "ironclad");
});

test("the Slack message carries the summary and each action item's details", { skip }, async () => {
  const db = core!.getDb();
  process.env.PUBLIC_URL = "https://debrief.example";
  await db.update(core!.transcripts).set({ summary: "Agreed the <Q4> pricing & deck." }).where(sql`id = ${transcriptId}`);
  const m = (await core!.getMeeting(db, transcriptId))!;
  const msg = core!.slackMessage(m);
  const text = JSON.stringify(msg.blocks);
  assert.match(text, /Agreed the &lt;Q4&gt; pricing &amp; deck\./);
  assert.match(text, /Send the pricing deck/);
  assert.match(text, /https:\/\/debrief\.example\/meetings\//);
  assert.ok(core!.meetingMarkdown(m).includes("## Action items"));
});
