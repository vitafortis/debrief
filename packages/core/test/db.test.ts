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
  await db.execute(sql`truncate calendars, recordings, devices, uploads, api_keys, settings, service_status cascade`);
  const [cal] = await db.insert(core.calendars).values({ source: "ics", externalId: "https://x.example/a.ics", name: "Work", context: "acme" }).returning();
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
  assert.equal(m!.context, "acme");
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
  assert.equal((await core!.searchTranscripts(db, "pricing", { context: "lumen" })).length, 0);
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
  const recorder = async () => (await core!.listApiKeys(db)).find((r) => r.id === k.id)?.recorder;
  assert.equal(await recorder(), null);
  await core!.verifyApiKey(db, k.key, "DebriefRecorder/0.1.15 (macos)");
  assert.equal(await recorder(), "0.1.15 on macOS");
  await core!.verifyApiKey(db, k.key, "claude-code/2.1");
  assert.equal(await recorder(), "0.1.15 on macOS");
  const rows = await db.execute(sql`select hash from api_keys where id = ${k.id}`);
  assert.notEqual(rows.rows[0].hash, k.key);
  await core!.deleteApiKey(db, k.id);
  assert.equal(await core!.verifyApiKey(db, k.key), null);
});

test("an upload resumes at the right offset and is queued for the transcriber when it finishes", { skip }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Readable } = await import("node:stream");
  const up = await import("../src/uploads");
  const db = core!.getDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-up-"));
  const id = "3b8f1c2a-0000-4000-8000-000000000001";
  const chunk = (s: string) => Readable.from([Buffer.from(s)]);

  const s0 = await up.startUpload(db, id, { device: "Alex's MacBook Pro", startedAt: "2026-10-22T18:00:00Z", app: "zoom.us", format: "opus" }, null, root);
  assert.equal(s0!.offset, 0);
  const a = await up.appendUpload(db, id, 0, chunk("hello "), 6, root);
  assert.equal(a.offset, 6);
  // A retried chunk at a stale offset writes nothing and says where to resume.
  await assert.rejects(up.appendUpload(db, id, 0, chunk("hello "), 6, root), (e: InstanceType<typeof up.UploadError>) => e.status === 409 && e.offset === 6);
  // Starting again (the recorder restarted) is the same upload.
  assert.equal((await up.startUpload(db, id, { device: "Alex's MacBook Pro", startedAt: "2026-10-22T18:00:00Z", format: "opus" }, null, root))!.offset, 6);
  await up.appendUpload(db, id, 6, chunk("world"), 5, root);
  await assert.rejects(up.finishUpload(db, id, { bytes: 99, durationSecs: 60 }, root), (e: InstanceType<typeof up.UploadError>) => e.status === 409);
  const done = await up.finishUpload(db, id, { bytes: 11, durationSecs: 60, title: "Pricing sync" }, root);
  assert.equal(done!.status, "completed");
  assert.equal(done!.recording, "pending");
  // Finishing again (a retry) changes nothing.
  assert.equal((await up.finishUpload(db, id, { bytes: 11, durationSecs: 60 }, root))!.offset, 11);

  const [u] = await db.select().from(core!.uploads).where(sql`id = ${id}`);
  assert.equal(u.device, "alexs-macbook-pro");
  assert.match(u.folder, /^alexs-macbook-pro\/2026-10-22_\d\d-00-00_3b8f1c2a$/);
  assert.equal(fs.readFileSync(path.join(root, u.folder, "audio.opus"), "utf8"), "hello world");
  const [rec] = await db.select().from(core!.recordings).where(sql`file_path = ${`${u.folder}/audio.opus`}`);
  assert.deepEqual([rec.storage, rec.status, rec.titleHint, rec.durationSecs, rec.device], ["local", "pending", "Pricing sync", 60, "alexs-macbook-pro"]);
  assert.equal(rec.recordedAt.toISOString(), "2026-10-22T18:00:00.000Z");
  // The device shows up, untagged.
  const dev = (await core!.listDevices(db)).find((d) => d.name === "alexs-macbook-pro");
  assert.equal(dev?.context, null);
  fs.rmSync(root, { recursive: true });
});

test("an upload that stops part-way is queued after ABANDON_HOURS", { skip }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Readable } = await import("node:stream");
  const up = await import("../src/uploads");
  const db = core!.getDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-up-"));
  const id = "3b8f1c2a-0000-4000-8000-000000000002";
  await up.startUpload(db, id, { device: "home-pc", startedAt: "2026-10-22T20:00:00Z", format: "opus" }, null, root);
  await up.appendUpload(db, id, 0, Readable.from([Buffer.from("partial")]), 7, root);
  assert.equal(await up.finishAbandonedUploads(db), 0);
  assert.equal(await up.finishAbandonedUploads(db, new Date(Date.now() + 13 * 3600_000)), 1);
  const [rec] = await db.select().from(core!.recordings).where(sql`file_path like ${"home-pc/%"}`);
  assert.deepEqual([rec.status, rec.storage], ["pending", "local"]);
  await db.execute(sql`delete from recordings where id = ${rec.id}`);
  fs.rmSync(root, { recursive: true });
});

test("settings: saved values apply, the environment wins, secrets aren't shown", { skip }, async () => {
  const s = await import("../src/settings");
  const db = core!.getDb();
  await s.saveSettings(db, { ANTHROPIC_MODEL: "claude-test", SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" });
  assert.equal(s.setting("ANTHROPIC_MODEL"), "claude-test");
  assert.equal(s.settingSource("ANTHROPIC_MODEL"), "saved");
  assert.equal(s.setting("WHISPER_MODEL"), "large-v3");
  assert.equal(s.settingSource("WHISPER_MODEL"), "default");
  const shown = s.settingForDisplay(s.settingDef("SLACK_WEBHOOK_URL")!);
  assert.deepEqual([shown.value, shown.isSet], ["", true]);
  process.env.ANTHROPIC_MODEL = "from-env";
  try {
    assert.equal(s.setting("ANTHROPIC_MODEL"), "from-env");
    assert.equal(s.settingSource("ANTHROPIC_MODEL"), "env");
  } finally {
    delete process.env.ANTHROPIC_MODEL;
  }
  await s.saveSettings(db, { ANTHROPIC_MODEL: null, SLACK_WEBHOOK_URL: "" });
  assert.equal(s.setting("ANTHROPIC_MODEL"), "claude-haiku-5-5");
  await assert.rejects(s.saveSettings(db, { NOT_A_SETTING: "x" }));

  assert.equal(s.ownerPasswordSet(), false);
  await assert.rejects(s.setOwnerPassword(db, "short"));
  await s.setOwnerPassword(db, "correct horse");
  assert.ok(s.verifyOwnerPassword("correct horse"));
  assert.ok(!s.verifyOwnerPassword("wrong horse"));
  assert.notEqual(s.setting("PASSWORD_HASH"), "correct horse");
  const secret = await s.ensureAuthSecret(db);
  assert.equal(await s.ensureAuthSecret(db), secret);
  await db.execute(sql`delete from settings`);
  await s.loadSettings(db);
});

test("archiving to the NAS folder copies, records and later prunes the server's copy", { skip }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const s = await import("../src/settings");
  const st = await import("../src/storage");
  const db = core!.getDb();
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-local-"));
  const nas = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-nas-"));
  process.env.RECORDINGS_DIR = local;
  process.env.AUDIO_DIR = nas;
  try {
    const rel = "laptop/2026-10-22_10-00-00_aaaaaaaa/audio.opus";
    fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true });
    fs.writeFileSync(path.join(local, rel), "opus bytes");
    const [rec] = await db
      .insert(core!.recordings)
      .values({ filePath: rel, recordedAt: new Date("2026-10-22T14:00:00Z"), status: "done", storage: "local", titleHint: "Standup" })
      .returning();
    // Off: nothing moves.
    assert.deepEqual(await st.archivePending(db), { archived: 0, errors: [] });

    await s.saveSettings(db, { ARCHIVE: "folder", KEEP_LOCAL_DAYS: "7" });
    assert.match(await st.testArchive(), /Wrote to/);
    assert.equal((await st.archivePending(db)).archived, 1);
    assert.equal(fs.readFileSync(path.join(nas, rel), "utf8"), "opus bytes");
    assert.equal(JSON.parse(fs.readFileSync(path.join(nas, path.dirname(rel), "metadata.json"), "utf8")).meeting_name, "Standup");
    const [after] = await db.select().from(core!.recordings).where(sql`id = ${rec.id}`);
    assert.equal(after.storage, "folder");
    // Played from the server while it still has a copy, then from the NAS.
    const playedFrom = async () => ((await st.locateAudio(after)) as { path: string }).path;
    assert.equal(await playedFrom(), path.join(local, rel));
    assert.equal(await st.pruneLocalCopies(db), 0);
    assert.equal(await st.pruneLocalCopies(db, new Date(Date.now() + 8 * 86400_000)), 1);
    assert.ok(!fs.existsSync(path.join(local, "laptop")));
    assert.equal(await playedFrom(), path.join(nas, rel));
    await db.execute(sql`delete from recordings where id = ${rec.id}`);
  } finally {
    delete process.env.RECORDINGS_DIR;
    delete process.env.AUDIO_DIR;
    await db.execute(sql`delete from settings`);
    await s.loadSettings(db);
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(nas, { recursive: true, force: true });
  }
});

test("a device's context applies only once set, and a calendar event wins over it", { skip }, async () => {
  const db = core!.getDb();
  const [rec] = await db
    .insert(core!.recordings)
    .values({ filePath: "home-pc/b/audio.opus", recordedAt: new Date("2026-10-23T02:00:00Z"), durationSecs: 600, status: "done", device: "home-pc" })
    .returning();
  const [t] = await db.insert(core!.transcripts).values({ recordingId: rec.id, content: "Roadmap for the side project." }).returning();
  assert.equal((await core!.getMeeting(db, t.id))!.context, null);
  await core!.setDeviceRule(db, "home-pc", { context: "lumen", defaultDestination: "linear" });
  const m = await core!.getMeeting(db, t.id);
  assert.equal(m!.context, "lumen");
  assert.equal(m!.defaultDestination, "linear");
  assert.deepEqual((await core!.listMeetings(db, { context: "lumen" })).map((x) => x.id), [t.id]);
  assert.ok((await core!.listContexts(db)).includes("lumen"));
  const [task] = await core!.saveExtractedTasks(db, t.id, [{ description: "Draft the roadmap" }]);
  assert.deepEqual([task.context, task.destination], ["lumen", "linear"]);
  // A device rule never overrides a calendar: the same device, now with an acme event over the recording.
  const [ev] = await db
    .insert(core!.calendarEvents)
    .values({ source: "ics", externalId: "c", calendarId, title: "Vendor call", startAt: new Date("2026-10-23T02:00:00Z"), endAt: new Date("2026-10-23T02:10:00Z") })
    .returning();
  await core!.linkTranscript(db, t.id, ev.id);
  assert.equal((await core!.getMeeting(db, t.id))!.context, "acme");
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
  assert.match(text, /https:\/\/debrief\.example\/recordings\//);
  assert.ok(core!.meetingMarkdown(m).includes("## Action items"));
});

test("the cleanup list says what each transcript still needs, and opening one marks it seen", { skip }, async () => {
  const db = core!.getDb();
  const add = async (file: string, content: string, segs: { speaker: string }[], durationSecs = 600) => {
    const [rec] = await db.insert(core!.recordings).values({ filePath: file, device: "laptop", recordedAt: new Date("2026-10-30T15:00:00Z"), durationSecs, status: "done" }).returning();
    const [t] = await db
      .insert(core!.transcripts)
      .values({ recordingId: rec.id, content, speakerSegments: segs.map((s, i) => ({ ...s, start: i, end: i + 1, text: "Hi." })) })
      .returning();
    return t.id;
  };
  const untitled = await add("laptop/u/audio.opus", "Hello there.", [{ speaker: "YOU" }, { speaker: "OTHERS" }]);
  const diarized = await add("laptop/d/audio.opus", "Hello there.", [{ speaker: "YOU" }, { speaker: "SPEAKER_00" }]);
  const empty = await add("laptop/e/audio.opus", "", [], 0);

  const issues = Object.fromEntries((await core!.listCleanup(db)).map((c) => [c.id, c.issues]));
  // The recorder's two sides read fine as they are; only diarized labels with no name count.
  assert.deepEqual(issues[untitled], ["untitled", "no-event", "no-summary"]);
  assert.deepEqual(issues[diarized], ["untitled", "no-event", "speakers", "no-summary"]);
  assert.deepEqual(issues[empty], ["empty"]);

  const unseen = await core!.listUnviewed(db);
  assert.ok(unseen.items.some((m) => m.id === untitled));
  await core!.markViewed(db, untitled);
  assert.ok(!(await core!.listUnviewed(db)).items.some((m) => m.id === untitled));
});

test("a device's badge is its label and color once set, and steady before that", { skip }, async () => {
  const db = core!.getDb();
  const before = (await core!.deviceBadges(db)).laptop;
  assert.equal(before.label, "laptop");
  assert.deepEqual(core!.deviceBadge("laptop"), before);
  await core!.setDeviceRule(db, "laptop", { label: "MacBook", color: "violet" });
  assert.deepEqual((await core!.deviceBadges(db)).laptop, { label: "MacBook", color: "violet" });
  // A device's context isn't touched by setting its badge.
  assert.equal((await core!.listDevices(db)).find((d) => d.name === "laptop")?.context, null);
});

test("each service's check-in shows whether it's running, quiet too long, or on another build", { skip }, async () => {
  const db = core!.getDb();
  await core!.reportStatus(db, "transcriber", "idle");
  await db.insert(core!.serviceStatus).values({ service: "mcp", version: "0.0.1", seenAt: new Date() });
  await db.insert(core!.serviceStatus).values({ service: "calendar-sync", version: "dev", seenAt: new Date(Date.now() - 10 * 60_000) });
  const health = Object.fromEntries((await core!.serviceHealth(db)).map((s) => [s.service, s]));
  assert.equal(health.web.state, "ok");
  assert.equal(health.transcriber.state, "ok");
  assert.equal(health.transcriber.detail, "idle");
  assert.equal(health.mcp.state, "behind");
  assert.equal(health["calendar-sync"].state, "down");
  // A transcriber mid-recording gets longer before it counts as down.
  await db.update(core!.serviceStatus).set({ detail: "transcribing", seenAt: new Date(Date.now() - 10 * 60_000) }).where(sql`service = 'transcriber'`);
  assert.equal((await core!.serviceHealth(db)).find((s) => s.service === "transcriber")?.state, "ok");
});

test("calendars added with the same ID are turned on again rather than doubled", { skip }, async () => {
  const db = core!.getDb();
  await db.insert(core!.calendars).values({ source: "google", externalId: "team@example.com", name: "Team", enabled: false });
  await db
    .insert(core!.calendars)
    .values({ source: "google", externalId: "team@example.com", name: "Team", context: "acme" })
    .onConflictDoUpdate({ target: [core!.calendars.source, core!.calendars.externalId], set: { enabled: true, context: "acme" } });
  const rows = await db.select().from(core!.calendars).where(sql`external_id = 'team@example.com'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, true);
});

test("deleting a recording removes its audio, screens, video, archive copy, exports and transcript, and stops the recorder sending it", { skip }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Readable } = await import("node:stream");
  const up = await import("../src/uploads");
  const st = await import("../src/storage");
  const db = core!.getDb();
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-local-"));
  const nas = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-nas-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-out-"));
  process.env.RECORDINGS_DIR = local;
  process.env.AUDIO_DIR = nas;
  process.env.EXPORT_DIR = out;
  try {
    const id = "3b8f1c2a-0000-4000-8000-000000000003";
    await up.startUpload(db, id, { device: "laptop", startedAt: "2026-10-23T15:00:00Z", format: "opus" }, null, local);
    await up.appendUpload(db, id, 0, Readable.from([Buffer.from("secret")]), 6, local);
    // A shared screen: a JPEG, saved beside the audio by its time; anything else is refused.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    assert.deepEqual(await up.saveScreen(db, id, 12_500, jpeg, local), { saved: "000012500.jpg" });
    await assert.rejects(up.saveScreen(db, id, 13_000, new Uint8Array([1, 2, 3, 4]), local), (e: InstanceType<typeof up.UploadError>) => e.status === 415);
    await assert.rejects(up.saveScreen(db, "3b8f1c2a-0000-4000-8000-0000000000ff", 1, jpeg, local), (e: InstanceType<typeof up.UploadError>) => e.status === 404);
    await up.finishUpload(db, id, { bytes: 6, durationSecs: 30 }, local);
    const [u] = await db.select().from(core!.uploads).where(sql`id = ${id}`);
    const rel = `${u.folder}/audio.opus`;
    assert.ok(fs.existsSync(path.join(local, u.folder, "screens", "000012500.jpg")));
    // A video of the meeting window comes after the audio, in pieces, and is kept once all of it is here.
    const mp4 = Buffer.from("\0\0\0\x18ftypmp42 rest of the movie");
    const piece = (b: Buffer) => Readable.from([b]);
    assert.deepEqual(await up.appendVideo(db, id, 90_000, 0, mp4.length, piece(mp4.subarray(0, 10)), 10, local), { offset: 10, done: false });
    await assert.rejects(up.appendVideo(db, id, 90_000, 0, mp4.length, piece(mp4), null, local), (e: InstanceType<typeof up.UploadError>) => e.status === 409 && e.offset === 10);
    assert.deepEqual(await up.appendVideo(db, id, 90_000, 10, mp4.length, piece(mp4.subarray(10)), null, local), { offset: mp4.length, done: true });
    assert.deepEqual(await up.appendVideo(db, id, 90_000, 0, mp4.length, piece(mp4), null, local), { offset: mp4.length, done: true });
    assert.equal(fs.readFileSync(path.join(local, u.folder, "video", "000090000.mp4")).toString(), mp4.toString());
    await assert.rejects(up.appendVideo(db, id, 95_000, 0, 4, piece(Buffer.from("nope")), null, local), (e: InstanceType<typeof up.UploadError>) => e.status === 415);
    assert.deepEqual(fs.readdirSync(path.join(local, u.folder, "video")), ["000090000.mp4"]);
    const [rec] = await db.select().from(core!.recordings).where(sql`file_path = ${rel}`);
    const [tr] = await db.insert(core!.transcripts).values({ recordingId: rec.id, content: "Something sensitive." }).returning();
    await db.insert(core!.screens).values({ recordingId: rec.id, atSecs: 12.5, filePath: `${u.folder}/screens/000012500.jpg`, text: "Launch checklist: pricing page, docs" });
    const m = (await core!.getMeeting(db, tr.id))!;
    assert.deepEqual(m.screens.map((x) => [x.atSecs, x.text]), [[12.5, "Launch checklist: pricing page, docs"]]);
    assert.deepEqual(m.videoStarts, [90_000]);
    assert.match(core!.meetingBrief(m), /Text on screens shared[\s\S]*\[0:12\]\nLaunch checklist/);
    // An archive copy with its sidecar, and the exports.
    fs.mkdirSync(path.join(nas, u.folder), { recursive: true });
    fs.writeFileSync(path.join(nas, rel), "secret");
    fs.writeFileSync(path.join(nas, u.folder, "metadata.json"), "{}");
    fs.mkdirSync(path.join(out, "2026-10-23"));
    for (const f of [`call-${rec.id.slice(0, 8)}.txt`, `call-${rec.id.slice(0, 8)}.json`, `call-${rec.id.slice(0, 8)}.notes.md`, "other-12345678.txt"]) fs.writeFileSync(path.join(out, "2026-10-23", f), "x");

    assert.equal(await st.deleteRecording(db, rec.id), true);
    assert.equal((await db.select().from(core!.recordings).where(sql`id = ${rec.id}`)).length, 0);
    assert.equal((await db.select().from(core!.transcripts).where(sql`recording_id = ${rec.id}`)).length, 0);
    assert.equal((await db.select().from(core!.screens).where(sql`recording_id = ${rec.id}`)).length, 0);
    assert.ok(!fs.existsSync(path.join(local, "laptop")));
    assert.ok(!fs.existsSync(path.join(nas, "laptop")));
    assert.deepEqual(fs.readdirSync(path.join(out, "2026-10-23")), ["other-12345678.txt"]);
    // The recorder is told it's finished, and finishing again doesn't bring it back.
    await assert.rejects(up.appendUpload(db, id, 6, Readable.from([Buffer.from("more")]), 4, local), (e: InstanceType<typeof up.UploadError>) => e.status === 409 && /finished/.test(e.message));
    assert.equal((await up.finishUpload(db, id, { bytes: 6, durationSecs: 30 }, local))!.status, "deleted");
    assert.equal((await db.select().from(core!.recordings).where(sql`file_path = ${rel}`)).length, 0);
    assert.equal(await st.deleteRecording(db, rec.id), false);
  } finally {
    delete process.env.RECORDINGS_DIR;
    delete process.env.AUDIO_DIR;
    delete process.env.EXPORT_DIR;
    for (const d of [local, nas, out]) fs.rmSync(d, { recursive: true, force: true });
  }
});
