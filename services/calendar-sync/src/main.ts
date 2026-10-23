/**
 * calendar-sync: pulls calendar events every few minutes and links
 * transcripts to their meetings. Also wakes up when the transcriber finishes
 * a recording (to link it, have Claude summarize it when an API key is set,
 * and archive it), when a summary is saved (to write the notes file and tell
 * Slack), when "Sync now" is pressed, and when settings change. Each pass
 * also archives recordings, removes the server's old copies and finishes
 * uploads that stopped.
 */
import pg from "pg";
import {
  archivePending,
  autoExtract,
  closeDb,
  correlateTranscript,
  extractWithClaude,
  getDb,
  loadSettings,
  publishMeeting,
  pruneLocalCopies,
  settingNumber,
} from "@debrief/core";
import { registerConfiguredCalendars, syncAllCalendars } from "@debrief/core/calendar-sync";
import { waitForSchema } from "@debrief/core/migrate";
import { finishAbandonedUploads } from "@debrief/core/uploads";

process.env.DATABASE_URL ||= process.env.POSTGRES_URL;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

await waitForSchema();
const db = getDb();
await loadSettings(db);
await registerConfiguredCalendars(db);

/** Archiving, pruning and abandoned uploads; failures are logged and retried next pass. */
async function housekeeping() {
  try {
    const stale = await finishAbandonedUploads(db);
    if (stale) log(`Queued ${stale} upload(s) that stopped part-way`);
    const a = await archivePending(db);
    if (a.archived) log(`Archived ${a.archived} recording(s)`);
    for (const e of a.errors) log("Couldn't archive", e);
    const pruned = await pruneLocalCopies(db);
    if (pruned) log(`Removed the server's copy of ${pruned} archived recording(s)`);
  } catch (err) {
    log("Housekeeping failed:", (err as Error).message);
  }
}

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
  }
  await housekeeping();
  running = false;
  if (again) {
    again = false;
    void sync("queued");
  }
}

let timer: NodeJS.Timeout | undefined;
let interval = 0;
function schedule() {
  const next = Math.max(30, settingNumber("POLL_INTERVAL_SECONDS")) * 1000;
  if (next === interval) return;
  interval = next;
  clearInterval(timer);
  timer = setInterval(() => void sync("timer"), interval);
}

// LISTEN needs its own connection, outside the pool.
async function listen() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on("error", (err) => {
    log("Listener lost:", err.message, "- reconnecting");
    setTimeout(listen, 5000);
  });
  await client.connect();
  for (const channel of ["debrief_transcribed", "debrief_sync_now", "debrief_summarized", "debrief_settings"]) await client.query(`LISTEN ${channel}`);
  client.on("notification", async (n) => {
    if (n.channel === "debrief_sync_now") return void sync("requested");
    if (n.channel === "debrief_settings") {
      await loadSettings(db).catch((err) => log("Couldn't reload settings:", (err as Error).message));
      schedule();
      return void sync("settings changed");
    }
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
      await housekeeping();
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
  log("Listening for new transcripts, summaries, settings and sync requests");
}

await listen();
await sync("startup");
schedule();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await closeDb();
    process.exit(0);
  });
}
