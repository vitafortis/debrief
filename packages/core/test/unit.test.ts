import { test } from "node:test";
import assert from "node:assert/strict";
import { overlapScore, rankMatches } from "../src/correlate";
import { findConferenceUrl, normalizeGoogleEvent, normalizeIcs } from "../src/calendar-sync";
import { HL_END, HL_START, highlightRuns } from "../src/search";
import { akiflowPayload } from "../src/tasks";
import { clock, speakerName } from "../src/extract";

const at = (hhmm: string) => new Date(`2026-10-22T${hhmm}:00Z`);

test("a recording inside the meeting scores 1, even joined late", () => {
  assert.equal(overlapScore({ start: at("10:10"), end: at("10:50") }, { start: at("10:00"), end: at("11:00") }), 1);
});

test("a recording that runs past a short meeting scores against the meeting", () => {
  // 15 of the meeting's 30 minutes overlap.
  assert.equal(overlapScore({ start: at("10:15"), end: at("11:30") }, { start: at("10:00"), end: at("10:30") }), 0.5);
});

test("no overlap scores 0", () => {
  assert.equal(overlapScore({ start: at("09:00"), end: at("09:30") }, { start: at("10:00"), end: at("10:30") }), 0);
});

test("matches above the threshold, best first, call links win ties", () => {
  const rec = { start: at("10:00"), end: at("11:00") };
  const ranked = rankMatches(rec, [
    { id: "lunch", start: at("10:50"), end: at("12:00"), hasConference: false },
    { id: "a", start: at("10:00"), end: at("10:30"), hasConference: false },
    { id: "b", start: at("10:30"), end: at("11:00"), hasConference: true },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["b", "a"]);
});

test("conference links are found in free text", () => {
  assert.equal(findConferenceUrl("Join: https://acme.zoom.us/j/123456?pwd=abc)."), "https://acme.zoom.us/j/123456?pwd=abc");
  assert.equal(findConferenceUrl(null, "meet at https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
  assert.equal(findConferenceUrl("Room 4"), null);
});

test("google events: declined invites count as cancelled, rooms are not attendees", () => {
  const e = normalizeGoogleEvent({
    id: "x",
    summary: "Standup",
    start: { dateTime: "2026-10-22T14:00:00Z" },
    end: { dateTime: "2026-10-22T14:15:00Z" },
    hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
    attendees: [
      { email: "Me@Example.com", self: true, responseStatus: "declined" },
      { email: "room@resource.calendar.google.com", resource: true },
    ],
  })!;
  assert.equal(e.cancelled, true);
  assert.equal(e.conferenceUrl, "https://meet.google.com/aaa-bbbb-ccc");
  assert.deepEqual(e.attendees.map((a) => a.email), ["me@example.com"]);
  assert.equal(normalizeGoogleEvent({ id: "d", start: { date: "2026-10-22" }, end: { date: "2026-10-23" } })!.allDay, true);
});

test("ics feeds expand recurring meetings into instances", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:weekly-1",
    "DTSTAMP:20261001T000000Z",
    "DTSTART:20261005T150000Z",
    "DTEND:20261005T153000Z",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "SUMMARY:Weekly sync",
    "LOCATION:https://acme.zoom.us/j/999",
    "ATTENDEE;CN=Sarah;PARTSTAT=ACCEPTED:mailto:sarah@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const events = normalizeIcs(ics, new Date("2026-10-10T00:00:00Z"), new Date("2026-10-31T00:00:00Z"));
  assert.equal(events.length, 3);
  assert.equal(events[0].title, "Weekly sync");
  assert.equal(events[0].conferenceUrl, "https://acme.zoom.us/j/999");
  assert.deepEqual(events[0].attendees, [{ email: "sarah@example.com", name: "Sarah", rsvpStatus: "accepted" }]);
  assert.notEqual(events[0].externalId, events[1].externalId);
});

test("highlight runs split on the markers", () => {
  assert.deepEqual(highlightRuns(`the ${HL_START}API${HL_END} slips`), [
    { text: "the ", match: false },
    { text: "API", match: true },
    { text: " slips", match: false },
  ]);
});

test("akiflow payload follows the plan's shape and dedup key", () => {
  process.env.PUBLIC_URL = "https://debrief.example.dev/";
  const p = akiflowPayload(
    {
      itemNumber: 1,
      description: "Follow up with Sarah on API timeline",
      details: "Sarah mentioned API v2 timeline may slip",
      dueDate: "2026-10-25",
      priority: "high",
      context: "acme",
      assignee: null,
      sourceStart: 125.4,
    } as never,
    { title: "Standup", recordedAt: new Date("2026-10-22T14:00:00Z"), transcriptId: "abc123" }
  );
  assert.equal(p.uniqueIdentifier, "debrief-abc123-1");
  assert.equal(p.due_date, "2026-10-25");
  assert.equal(p.priority, "high");
  assert.match(p.description, /^From Standup 10\/22 — Sarah mentioned/);
  assert.match(p.description, /https:\/\/debrief\.example\.dev\/meetings\/abc123\?t=125/);
});

test("clock and speaker labels", () => {
  assert.equal(clock(65), "1:05");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(speakerName({}, "SPEAKER_00"), "Speaker 1");
  assert.equal(speakerName({ SPEAKER_01: "Sarah" }, "SPEAKER_01"), "Sarah");
});

test("S3 links are path-style, presigned and expire", async () => {
  const { presignedAudioUrl } = await import("../src/storage");
  const env = { S3_BUCKET: "meetings", S3_ACCESS_KEY_ID: "AKIDEXAMPLE", S3_SECRET_ACCESS_KEY: "secret", S3_ENDPOINT: "https://minio.example.com/", S3_PREFIX: "debrief/" };
  Object.assign(process.env, env);
  try {
    const url = new URL(await presignedAudioUrl("laptop/2026-10-22_10-00-00_aaaaaaaa/audio.opus", 600));
    assert.equal(url.origin + url.pathname, "https://minio.example.com/meetings/debrief/laptop/2026-10-22_10-00-00_aaaaaaaa/audio.opus");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
    assert.ok(url.searchParams.get("X-Amz-Signature"));
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
});
