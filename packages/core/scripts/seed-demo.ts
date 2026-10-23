/**
 * Fills a database with a made-up week of meetings for screenshots and demos.
 * Every person, company and conversation here is invented.
 *
 *   DATABASE_URL=… tsx scripts/seed-demo.ts
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";
import { runMigrations } from "../src/migrate";
import { calendarEvents, calendars, eventAttendees, recordings, tasks, transcriptEvents, transcripts, type SpeakerSegment } from "../src/schema";
import { correlateTranscript } from "../src/correlate";
import { saveSettings } from "../src/settings";

const db = getDb();
await runMigrations();
await db.execute(sql`truncate calendars, calendar_events, event_attendees, recordings, transcripts, transcript_events, tasks, devices, uploads, api_keys, settings cascade`);

const TZ = process.env.TZ || "America/Chicago";
// Wall-clock time in TZ, `dayOffset` days from today.
function at(dayOffset: number, hh: number, mm = 0) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d + dayOffset, hh, mm);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return new Date(guess - (asUtc - guess));
}

const [work, side, personal] = await db
  .insert(calendars)
  .values([
    { source: "google", externalId: "me@acme.example", name: "Work", context: "acme", lastSyncedAt: new Date(Date.now() - 3 * 60_000) },
    { source: "google", externalId: "primary", name: "lumen", context: "lumen", defaultDestination: "linear", lastSyncedAt: new Date(Date.now() - 3 * 60_000) },
    { source: "ics", externalId: "https://calendar.example.com/feeds/holidays.ics", name: "Holidays", context: "personal", enabled: false },
  ])
  .returning();
void personal;

type Person = { name: string; email: string };
const P = {
  me: { name: "Alex", email: "me@acme.example" },
  sarah: { name: "Sarah Okafor", email: "sarah@acme.example" },
  dev: { name: "Dev Patel", email: "dev@acme.example" },
  maria: { name: "Maria Lindqvist", email: "maria@acme.example" },
  jules: { name: "Jules Moreau", email: "jules@lumen.example" },
  kai: { name: "Kai Tanaka", email: "kai@client-northwind.example" },
} satisfies Record<string, Person>;

async function event(cal: typeof work, title: string, start: Date, mins: number, people: Person[], url = "https://meet.google.com/abc-defg-hij") {
  const [e] = await db
    .insert(calendarEvents)
    .values({
      source: cal.source,
      externalId: `demo-${title}-${start.toISOString()}`,
      calendarId: cal.id,
      title,
      startAt: start,
      endAt: new Date(start.getTime() + mins * 60_000),
      organizerEmail: people[0]?.email ?? null,
      conferenceUrl: url,
    })
    .returning();
  if (people.length) await db.insert(eventAttendees).values(people.map((p) => ({ eventId: e.id, email: p.email, name: p.name, rsvpStatus: "accepted" })));
  return e;
}

function waveform(seed: number, n = 1600) {
  let x = seed;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: n }, (_, i) => {
    const phrase = 0.55 + 0.45 * Math.sin(i / 23 + seed) * Math.sin(i / 7);
    const pause = i % 140 < 8 ? 0.1 : 1;
    return Math.round(Math.max(0.04, Math.abs(phrase) * pause * (0.6 + 0.4 * rnd())) * 1000) / 1000;
  });
}

function segs(lines: [string, string][], spacing = 9): SpeakerSegment[] {
  let t = 4;
  return lines.map(([speaker, text]) => {
    const len = Math.max(3, text.split(" ").length * 0.42);
    const s = { speaker, start: Math.round(t * 10) / 10, end: Math.round((t + len) * 10) / 10, text };
    t += len + spacing * 0.15;
    return s;
  });
}

async function meeting(opts: {
  file: string;
  start: Date;
  mins: number;
  device: string;
  lines: [string, string][];
  names: Record<string, string>;
  summary?: string;
  status?: "done" | "processing" | "pending";
  progress?: number;
  hint?: string;
}) {
  const [rec] = await db
    .insert(recordings)
    .values({
      filePath: opts.file,
      fileSize: opts.mins * 1_100_000,
      durationSecs: opts.mins * 60,
      recordedAt: opts.start,
      device: opts.device,
      titleHint: opts.hint ?? null,
      status: opts.status ?? "done",
      progress: opts.status === "processing" ? (opts.progress ?? 0.4) : opts.status === "pending" ? null : 1,
      waveform: opts.status && opts.status !== "done" ? null : waveform(opts.mins),
    })
    .returning();
  if (opts.status && opts.status !== "done") return null;
  const speakerSegments = segs(opts.lines);
  const [t] = await db
    .insert(transcripts)
    .values({
      recordingId: rec.id,
      content: speakerSegments.map((s) => s.text).join("\n"),
      speakerSegments,
      speakerNames: opts.names,
      summary: opts.summary ?? null,
      language: "en",
      modelVersion: "large-v3",
      tasksExtractedAt: opts.summary ? new Date() : null,
    })
    .returning();
  await correlateTranscript(db, t.id);
  return t;
}

// ── The week ─────────────────────────────────────────────────────────────

const standupToday = await event(work, "Platform standup", at(0, 9, 30), 15, [P.sarah, P.dev, P.maria, P.me]);
void standupToday;
await event(work, "API v2 design review", at(0, 13, 0), 60, [P.maria, P.dev, P.me]);
await event(side, "lumen: sync with Jules", at(0, 17, 30), 30, [P.jules, P.me]);
await event(work, "1:1 Sarah", at(0, 15, 0), 30, [P.sarah, P.me], "https://acme.zoom.us/j/5550101");

const standup = await meeting({
  file: "mac-work/Platform_standup_today/audio.mp4",
  start: at(0, 9, 31),
  mins: 14,
  device: "mac-work",
  names: { SPEAKER_00: "Sarah Okafor", SPEAKER_01: "Dev Patel", SPEAKER_02: "Alex", SPEAKER_03: "Maria Lindqvist" },
  summary:
    "Quick standup. The API v2 timeline may slip a week because the auth migration is still blocking the gateway work. Dev is fixing the login redirect bug before Thursday's release; Maria needs load-test numbers before the design review.",
  lines: [
    ["SPEAKER_00", "Morning, everyone. Let's keep it quick, the design review is at one."],
    ["SPEAKER_01", "I'm still on the login redirect bug. It only happens when the session cookie expires mid-checkout. I think I have it, fix should be up for review today."],
    ["SPEAKER_00", "Good. That has to land before Thursday's release, so flag me if it doesn't."],
    ["SPEAKER_02", "On my side, the gateway work is blocked on the auth migration. Realistically the API v2 timeline slips about a week."],
    ["SPEAKER_00", "Okay. Can you write that up and send me the API v2 timeline by Friday? I need to tell the partner team."],
    ["SPEAKER_02", "Sure, I'll send it today actually."],
    ["SPEAKER_03", "For the review this afternoon I'd really like load-test numbers. Dev, can you run the k6 suite against staging before one?"],
    ["SPEAKER_01", "I can kick it off now, it takes about forty minutes."],
    ["SPEAKER_03", "Perfect. And someone should update the runbook for the new rate limits, it still says a hundred per minute."],
    ["SPEAKER_02", "I'll take the runbook. Low priority, end of next week is fine."],
    ["SPEAKER_00", "Great. That's it, see you at one."],
  ],
});

await meeting({
  file: "mac-work/API_v2_design_review/audio.mp4",
  start: at(0, 13, 1),
  mins: 52,
  device: "mac-work",
  names: {},
  status: "processing",
  progress: 0.62,
  hint: "API v2 design review",
});

await event(work, "Platform standup", at(-1, 9, 30), 15, [P.sarah, P.dev, P.maria, P.me]);
const northwindEvent = await event(work, "Northwind onboarding call", at(-1, 11, 0), 45, [P.kai, P.sarah, P.me], "https://acme.zoom.us/j/5550199");
void northwindEvent;
const northwind = await meeting({
  file: "mac-work/Northwind_onboarding_call/audio.mp4",
  start: at(-1, 11, 3),
  mins: 41,
  device: "mac-work",
  names: { SPEAKER_00: "Kai Tanaka", SPEAKER_01: "Sarah Okafor", SPEAKER_02: "Alex" },
  summary:
    "Kickoff with Northwind. They want SSO through Okta before rolling out to their 300 seats, and an export of audit logs for their compliance team. Go-live target is the 15th of next month.",
  lines: [
    ["SPEAKER_00", "Thanks for making time. The big thing for us is SSO, we can't roll out to all three hundred seats without Okta."],
    ["SPEAKER_01", "That's supported. Alex, can you send Kai the SAML setup guide after this?"],
    ["SPEAKER_02", "Yes, I'll send it this afternoon along with the metadata URL."],
    ["SPEAKER_00", "Our compliance team will also ask for audit log exports. Is that a CSV or an API?"],
    ["SPEAKER_02", "Both. The API is better for them if they want it on a schedule. I'll set up a sandbox org so they can try it."],
    ["SPEAKER_00", "Great. We're targeting go-live on the fifteenth of next month."],
    ["SPEAKER_01", "That works. Let's book a check-in two weeks out to see where SSO is."],
  ],
});

await event(work, "Platform standup", at(-2, 9, 30), 15, [P.sarah, P.dev, P.maria, P.me]);
await event(side, "lumen roadmap", at(-2, 19, 0), 60, [P.jules, P.me], "https://app.slack.com/huddle/T0001/C0001");
const roadmap = await meeting({
  file: "win-desktop/lumen_roadmap/audio.mp4",
  start: at(-2, 19, 2),
  mins: 56,
  device: "win-desktop",
  names: { SPEAKER_00: "Jules Moreau", SPEAKER_01: "Alex" },
  summary:
    "Roadmap for the next lumen release: ship the report template editor first, then shared engagements. Jules will draft the pricing page; Alex owns the PDF renderer rewrite and the Stripe webhook bug.",
  lines: [
    ["SPEAKER_00", "So for the next release I think the report template editor has to come first. Every pentester we talked to asked for it."],
    ["SPEAKER_01", "Agreed. The PDF renderer needs a rewrite for that anyway, the current one can't do custom headers. I'll own that."],
    ["SPEAKER_00", "And shared engagements after that?"],
    ["SPEAKER_01", "Yes. Before either, though, I need to fix the Stripe webhook bug, renewals are double-counting seats."],
    ["SPEAKER_00", "Ugh, okay, that's urgent. I'll draft the new pricing page this week so it's ready when templates ship."],
    ["SPEAKER_01", "Let's do a demo for the beta group on the twenty-eighth."],
  ],
});

await event(work, "Quarterly planning", at(-3, 14, 0), 90, [P.sarah, P.maria, P.dev, P.me]);
await meeting({
  file: "mac-work/Quarterly_planning/audio.mp4",
  start: at(-3, 14, 4),
  mins: 84,
  device: "mac-work",
  names: { SPEAKER_00: "Sarah Okafor", SPEAKER_01: "Maria Lindqvist" },
  summary: "Planning for next quarter: reliability first (gateway, auth migration), then the partner API. Hiring one more backend engineer.",
  lines: [
    ["SPEAKER_00", "Let's start with what we committed to last quarter and what slipped."],
    ["SPEAKER_01", "The auth migration slipped, mostly because of the session store change. It's the top reliability item."],
    ["SPEAKER_00", "Then reliability first: gateway and auth. The partner API comes after."],
  ],
});

// A call recorded with nothing on the calendar.
await meeting({
  file: "mac-work/recording_adhoc/audio.mp4",
  start: at(-1, 16, 40),
  mins: 9,
  device: "mac-work",
  names: {},
  hint: "Quick call",
  lines: [
    ["SPEAKER_00", "Hey, quick one, do you have the staging credentials for the load test?"],
    ["SPEAKER_01", "They're in the vault under platform staging. I'll rotate them after."],
  ],
});

await event(work, "Platform standup", at(1, 9, 30), 15, [P.sarah, P.dev, P.maria, P.me]);
await event(work, "Northwind SSO check-in", at(2, 10, 0), 30, [P.kai, P.me], "https://acme.zoom.us/j/5550111");
await event(side, "Beta demo", at(3, 18, 0), 45, [P.jules, P.me]);

// ── Tasks ────────────────────────────────────────────────────────────────

const day = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(at(n, 12));
let n = 1;
await db.insert(tasks).values([
  { transcriptId: standup!.id, itemNumber: n++, description: "Send Sarah the API v2 timeline", details: "The auth migration is blocking gateway work; expect about a week's slip.", assignee: "Alex", dueDate: day(2), priority: "high", destination: "akiflow", context: "acme", sourceStart: 31 },
  { transcriptId: standup!.id, itemNumber: n++, description: "Fix the login redirect bug when the session expires mid-checkout", assignee: "Dev Patel", dueDate: day(1), priority: "high", destination: "linear", context: "acme", sourceStart: 9 },
  { transcriptId: standup!.id, itemNumber: n++, description: "Run the k6 load-test suite against staging before the design review", assignee: "Dev Patel", priority: "medium", destination: "akiflow", context: "acme", sourceStart: 54 },
  { transcriptId: standup!.id, itemNumber: n++, description: "Update the runbook for the new rate limits", assignee: "Alex", dueDate: day(8), priority: "low", destination: "linear", context: "acme", sourceStart: 77 },
]);
n = 1;
await db.insert(tasks).values([
  { transcriptId: northwind!.id, itemNumber: n++, description: "Send Kai the SAML setup guide and metadata URL", assignee: "Alex", dueDate: day(-1), priority: "high", destination: "akiflow", context: "acme", sourceStart: 18, status: "pushed", pushedTo: "akiflow", externalId: `debrief-${northwind!.id}-1`, pushedAt: new Date() },
  { transcriptId: northwind!.id, itemNumber: n++, description: "Set up a sandbox org for Northwind's compliance team to try audit log exports", assignee: "Alex", priority: "medium", destination: "akiflow", context: "acme", sourceStart: 40, status: "approved" },
  { transcriptId: northwind!.id, itemNumber: n++, description: "Book an SSO check-in with Northwind two weeks out", assignee: "Sarah Okafor", priority: "low", destination: "akiflow", context: "acme", sourceStart: 61 },
]);
n = 1;
await db.insert(tasks).values([
  { transcriptId: roadmap!.id, itemNumber: n++, description: "Fix the Stripe webhook double-counting seats on renewal", assignee: "Alex", priority: "high", destination: "linear", context: "lumen", sourceStart: 33, status: "pushed", pushedTo: "linear", externalId: "LUM-142", externalUrl: "https://linear.app/lumen/issue/LUM-142", pushedAt: new Date() },
  { transcriptId: roadmap!.id, itemNumber: n++, description: "Rewrite the PDF renderer to support custom report headers", assignee: "Alex", priority: "medium", destination: "linear", context: "lumen", sourceStart: 12 },
  { transcriptId: roadmap!.id, itemNumber: n++, description: "Draft the new pricing page", assignee: "Jules Moreau", dueDate: day(3), priority: "medium", destination: "akiflow", context: "lumen", sourceStart: 45 },
  { transcriptId: roadmap!.id, itemNumber: n++, description: "Prepare the beta group demo", assignee: "Alex", dueDate: day(3), priority: "medium", destination: "akiflow", context: "lumen", sourceStart: 58 },
]);

const linked = await db.select({ n: sql<number>`count(*)::int` }).from(transcriptEvents);
console.log(`Demo data ready: ${linked[0].n} transcripts linked to events.`);
// What the owner would have set in Settings (the environment still wins, as in the e2e tests).
await saveSettings(db, { OWNER_NAME: "Alex", TZ, PUBLIC_URL: "https://debrief.example.com", WHISPER_MODEL: "large-v3" });

await closeDb();
