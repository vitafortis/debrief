/**
 * calendar-sync: pulls calendar events every few minutes and links
 * transcripts to their meetings. Also wakes up when the transcriber finishes
 * a recording (to link it, then have Claude summarize it when an API key is
 * set), when a summary is saved (to write the notes file and tell Slack),
 * and when "Sync now" is pressed.
 */
import pg from "pg";
import { autoExtract, closeDb, correlateTranscript, extractWithClaude, getDb, publishMeeting } from "@debrief/core";
import { registerConfiguredCalendars, syncAllCalendars } from "@debrief/core/calendar-sync";
import { waitForSchema } from "@debrief/core/migrate";

process.env.DATABASE_URL ||= process.env.POSTGRES_URL;
const INTERVAL = Number(process.env.POLL_INTERVAL_SECONDS ?? 300) * 1000;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

await waitForSchema();
const db = getDb();
await registerConfiguredCalendars(db);

let running = false;
let again = false;
async function sync(reason: string) {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const r = await syncAllCalendars(db);
    const summary = r.calendars.map((c) => (c.error ? `${c.calendar}: ${c.error}` : `${c.calendar}: ${c.events}`)).join(", ");
    log(`Synced (${reason}): ${summary || "no calendars enabled"}; linked ${r.correlation.linked} of ${r.correlation.checked} unmatched transcripts`);
  } catch (err) {
    log("Sync failed:", (err as Error).message);
  } finally {
    running = false;
    if (again) {
      again = false;
      void sync("queued");
    }
  }
}

// LISTEN needs its own connection, outside the pool.
async function listen() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on("error", (err) => {
    log("Listener lost:", err.message, "- reconnecting");
    setTimeout(listen, 5000);
  });
  await client.connect();
  await client.query("LISTEN debrief_transcribed");
  await client.query("LISTEN debrief_sync_now");
  await client.query("LISTEN debrief_summarized");
  client.on("notification", async (n) => {
    if (n.channel === "debrief_sync_now") return void sync("requested");
    if (n.channel === "debrief_transcribed" && n.payload) {
      try {
        const m = await correlateTranscript(db, n.payload);
        log(`Transcript ${n.payload}: ${m.length ? `linked to ${m.length} event(s)` : "no matching event yet"}`);
      } catch (err) {
        log("Couldn't link transcript:", (err as Error).message);
      }
      if (autoExtract()) {
        try {
          const r = await extractWithClaude(db, n.payload);
          log(`Transcript ${n.payload}: summarized, ${r.tasks.length} action item(s)`);
        } catch (err) {
          log("Couldn't summarize:", (err as Error).message);
        }
      }
    }
    if (n.channel === "debrief_summarized" && n.payload) {
      try {
        const { id, again } = JSON.parse(n.payload) as { id: string; again?: boolean };
        const r = await publishMeeting(db, id, { again });
        log(`Meeting ${id}: ${[r.notes && `notes at ${r.notes}`, r.slack && "sent to Slack", ...r.errors].filter(Boolean).join("; ") || "nothing to do"}`);
      } catch (err) {
        log("Couldn't publish:", (err as Error).message);
      }
    }
  });
  log("Listening for new transcripts, summaries and sync requests");
}

await listen();
await sync("startup");
const timer = setInterval(() => void sync("timer"), INTERVAL);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await closeDb();
    process.exit(0);
  });
}
