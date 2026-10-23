import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { archiveTarget, autoExtract, calendars, extractionAvailable, integrationStatus, recordings, setting, settingNumber, slackConfigured } from "@debrief/core";
import { db } from "@/lib/db";
import { authMode, oidcEnabled, oidcName } from "@/lib/auth";
import { fmtAgo } from "@/lib/format";
import { fieldsFor } from "./fields";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

function Row({ name, ok, detail, href }: { name: string; ok: boolean; detail: React.ReactNode; href?: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${ok ? "bg-success" : "bg-muted-foreground/40"}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[0.8125rem] font-medium">{href ? <Link href={href} className="hover:underline">{name}</Link> : name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
      <span className={`badge ${ok ? "badge-success" : ""}`}>{ok ? "On" : "Off"}</span>
    </div>
  );
}

export default async function GeneralSettings() {
  const d = db();
  const fields = await fieldsFor("general");
  const [cals, [last], queue] = await Promise.all([
    d.select({ lastSyncedAt: calendars.lastSyncedAt }).from(calendars),
    d.select({ at: recordings.createdAt }).from(recordings).where(eq(recordings.status, "done")).orderBy(desc(recordings.createdAt)).limit(1),
    d.select({ status: recordings.status, n: sql<number>`count(*)::int` }).from(recordings).groupBy(recordings.status),
  ]);
  const i = integrationStatus();
  const counts = Object.fromEntries(queue.map((q) => [q.status, q.n]));
  const lastSync = cals.map((c) => c.lastSyncedAt).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
  const mode = authMode();
  const archive = archiveTarget();

  return (
    <>
      <SettingsForm title="General" fields={fields} />

      <section className="card overflow-hidden">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Status</h2>
        <div className="divide-y divide-border">
          <Row
            name="Transcriber"
            href="/settings/transcription"
            ok={!!last}
            detail={
              <>
                {last ? `Last transcript ${fmtAgo(last.at)}.` : "Nothing transcribed yet."} {counts.pending ?? 0} queued, {counts.processing ?? 0} in progress
                {counts.error ? `, ${counts.error} failed` : ""}. Model {setting("WHISPER_MODEL")}.
              </>
            }
          />
          <Row
            name="Calendar sync"
            href="/settings/calendars"
            ok={!!lastSync}
            detail={lastSync ? `Last synced ${fmtAgo(lastSync)}, every ${Math.round(settingNumber("POLL_INTERVAL_SECONDS") / 60)} minutes.` : "Hasn't synced yet. Is the calendar-sync container running?"}
          />
          <Row
            name="Archive"
            href="/settings/recordings"
            ok={archive !== "off"}
            detail={archive === "folder" ? "Recordings are copied to the NAS folder once transcribed." : archive === "s3" ? `Recordings are copied to ${setting("S3_BUCKET") || "S3"} once transcribed.` : "Recordings stay on the server."}
          />
          <Row
            name="Claude in the app"
            href="/settings/claude"
            ok={extractionAvailable()}
            detail={
              extractionAvailable()
                ? `${autoExtract() ? "Every new meeting is summarized as soon as it's transcribed" : "“Extract with Claude” on a meeting"}, with ${setting("ANTHROPIC_MODEL")}.`
                : "Optional. Add an Anthropic API key for automatic summaries; Claude through MCP works without it."
            }
          />
          <Row name="Slack" href="/settings/integrations" ok={slackConfigured()} detail={slackConfigured() ? "Each meeting's summary and action items are posted once it's summarized." : "Add an incoming webhook to post summaries."} />
          <Row name="Akiflow" href="/settings/integrations" ok={i.akiflow} detail={i.akiflow ? "Tasks post to your Zapier / Make / IFTTT webhook." : "Add a webhook to send tasks to Akiflow."} />
          <Row
            name="Linear"
            href="/settings/integrations"
            ok={i.linear}
            detail={i.linear ? `Tasks become issues${setting("LINEAR_TEAM") ? ` in ${setting("LINEAR_TEAM")}` : ""}.` : "Add an API key and a team to send tasks to Linear."}
          />
          <Row
            name="Sign-in"
            href="/settings/sign-in"
            ok={mode !== "none"}
            detail={
              mode === "none"
                ? "Off (AUTH_MODE=none): a proxy in front is expected to guard Debrief."
                : oidcEnabled()
                  ? `Through ${oidcName()}${setting("ALLOWED_EMAILS") ? `, limited to ${setting("ALLOWED_EMAILS")}` : ""}.`
                  : "With your password."
            }
          />
        </div>
      </section>
    </>
  );
}
