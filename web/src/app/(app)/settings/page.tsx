import type { Metadata } from "next";
import { desc, eq, sql } from "drizzle-orm";
import { autoExtract, calendars, extractionAvailable, integrationStatus, listApiKeys, listContexts, listDevices, recordings, slackConfigured } from "@debrief/core";
import { db } from "@/lib/db";
import { authMode } from "@/lib/auth";
import { fmtAgo } from "@/lib/format";
import { PageHeader } from "@/components/ui";
import { CalendarSettings } from "./calendar-settings";
import { ApiKeys, DeviceSettings } from "./recorder-settings";

export const metadata: Metadata = { title: "Settings" };

function Row({ name, ok, detail }: { name: string; ok: boolean; detail: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${ok ? "bg-success" : "bg-muted-foreground/40"}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[0.8125rem] font-medium">{name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
      <span className={`badge ${ok ? "badge-success" : ""}`}>{ok ? "On" : "Off"}</span>
    </div>
  );
}

const code = (s: string) => <code className="font-mono text-[0.6875rem] text-foreground">{s}</code>;

export default async function SettingsPage() {
  const d = db();
  const [cals, [last], queue, keys, devs, contexts] = await Promise.all([
    d.select().from(calendars).orderBy(calendars.context, calendars.name),
    d.select({ at: recordings.createdAt }).from(recordings).where(eq(recordings.status, "done")).orderBy(desc(recordings.createdAt)).limit(1),
    d.select({ status: recordings.status, n: sql<number>`count(*)::int` }).from(recordings).groupBy(recordings.status),
    listApiKeys(d),
    listDevices(d),
    listContexts(d),
  ]);
  const publicUrl = (process.env.PUBLIC_URL ?? "https://debrief.example.com").replace(/\/$/, "");
  const i = integrationStatus();
  const counts = Object.fromEntries(queue.map((q) => [q.status, q.n]));
  const lastSync = cals.map((c) => c.lastSyncedAt).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
  const mode = authMode();

  return (
    <div>
      <PageHeader title="Settings" description="Calendars, devices, keys, where tasks go, and how the pieces are doing." />
      <div className="space-y-6 px-4 pb-10 md:px-8">
        <CalendarSettings
          calendars={cals.map((c) => ({
            id: c.id,
            source: c.source,
            externalId: c.externalId,
            name: c.name,
            context: c.context,
            enabled: c.enabled,
            defaultDestination: c.defaultDestination,
            lastSynced: c.lastSyncedAt ? fmtAgo(c.lastSyncedAt) : null,
            lastError: c.lastError,
          }))}
        />

        <DeviceSettings
          contexts={contexts}
          devices={devs.map((x) => ({ ...x, lastActive: x.lastActive ? fmtAgo(x.lastActive) : null }))}
        />

        <ApiKeys
          publicUrl={publicUrl}
          keys={keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, created: fmtAgo(k.createdAt), lastUsed: k.lastUsedAt ? fmtAgo(k.lastUsedAt) : null }))}
        />

        <section className="card overflow-hidden">
          <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Services</h2>
          <div className="divide-y divide-border">
            <Row
              name="Transcriber"
              ok={!!last}
              detail={
                <>
                  {last ? `Last transcript ${fmtAgo(last.at)}.` : "Nothing transcribed yet."} {counts.pending ?? 0} queued, {counts.processing ?? 0} in progress
                  {counts.error ? `, ${counts.error} failed` : ""}.
                </>
              }
            />
            <Row
              name="Calendar sync"
              ok={!!lastSync}
              detail={lastSync ? `Last synced ${fmtAgo(lastSync)}, every ${Math.round(Number(process.env.POLL_INTERVAL_SECONDS ?? 300) / 60)} minutes.` : "Hasn't synced yet. Is the calendar-sync container running?"}
            />
            <Row name="Akiflow" ok={i.akiflow} detail={i.akiflow ? "Tasks post to your IFTTT / Zapier webhook." : <>Set {code("AKIFLOW_WEBHOOK_URL")} on the web and mcp-server containers.</>} />
            <Row
              name="Linear"
              ok={i.linear}
              detail={
                i.linear ? (
                  <>Dev tasks become issues{process.env.LINEAR_TEAM ? ` in ${process.env.LINEAR_TEAM}` : ""}.</>
                ) : (
                  <>
                    Set {code("LINEAR_API_KEY")} and {code("LINEAR_TEAM")} (or {code("LINEAR_TEAMS")} per context).
                  </>
                )
              }
            />
            <Row
              name="Claude in the app"
              ok={extractionAvailable()}
              detail={
                extractionAvailable() ? (
                  <>
                    {autoExtract() ? "Every new meeting is summarized as soon as it's transcribed" : "\u201cExtract with Claude\u201d on a meeting"}, with{" "}
                    {process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"}.
                  </>
                ) : (
                  <>Optional. Set {code("ANTHROPIC_API_KEY")} for a one-click Extract button; the MCP server works without it.</>
                )
              }
            />
            <Row
              name="Slack"
              ok={slackConfigured()}
              detail={
                slackConfigured() ? (
                  "Each meeting's summary and action items are posted once it's summarized."
                ) : (
                  <>
                    Set {code("SLACK_WEBHOOK_URL")} (an incoming webhook), or {code("SLACK_WEBHOOKS")} per context, on calendar-sync and web.
                  </>
                )
              }
            />
            <Row
              name="Sign-in"
              ok={mode !== "none"}
              detail={
                mode === "oidc"
                  ? `Through ${process.env.AUTH_OIDC_NAME || "Authentik"}${process.env.ALLOWED_EMAILS ? `, limited to ${process.env.ALLOWED_EMAILS}` : ""}.`
                  : mode === "password"
                    ? "One password (DEBRIEF_PASSWORD)."
                    : "Off: a proxy in front is expected to guard Debrief."
              }
            />
          </div>
        </section>
      </div>
    </div>
  );
}
