import type { Metadata } from "next";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { calendarEvents, calendars, listContexts, setting } from "@debrief/core";
import { googleCredentialInfo, googleIdFromIcs, googleOAuthReady, listGoogleCalendars, syncWindow } from "@debrief/core/calendar-sync";
import { settingSource } from "@debrief/core/settings";
import { db } from "@/lib/db";
import { fmtAgo } from "@/lib/format";
import { googleRedirectUri } from "@/lib/origin";
import { CalendarSettings, type GoogleState } from "../calendar-settings";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";
import { PageHead } from "../ui";

export const metadata: Metadata = { title: "Calendars · Settings" };

type Params = { add?: string; google?: string; google_error?: string };

export default async function CalendarsSettings({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const d = db();
  const { from, to } = syncWindow();
  const [fields, cals, counts, contexts, cred] = await Promise.all([
    fieldsFor("calendars"),
    d.select().from(calendars).orderBy(calendars.context, calendars.name),
    d
      .select({ id: calendarEvents.calendarId, n: sql<number>`count(*)::int` })
      .from(calendarEvents)
      .where(and(gte(calendarEvents.startAt, from), lte(calendarEvents.startAt, to), eq(calendarEvents.cancelled, false)))
      .groupBy(calendarEvents.calendarId),
    listContexts(d),
    googleCredentialInfo(),
  ]);

  // With an account connected, list what it can see, so you tick calendars instead of typing IDs.
  let found: GoogleState["found"] = null;
  let listError: string | null = null;
  if (cred.kind === "account") {
    try {
      // Already here: added through Google, or as its ICS link (which would otherwise be added a second time).
      const added = new Map<string, "google" | "ics">();
      for (const c of cals.filter((c) => c.enabled)) {
        const id = c.source === "google" ? c.externalId : googleIdFromIcs(c.externalId);
        if (id && !added.has(id)) added.set(id, c.source === "google" ? "google" : "ics");
      }
      found = (await listGoogleCalendars()).map((c) => ({ ...c, added: added.get(c.id) ?? null }));
    } catch (err) {
      listError = `Couldn't list your calendars: ${(err as Error).message}`;
    }
  }
  const n = Object.fromEntries(counts.map((c) => [c.id, c.n]));

  return (
    <>
      <PageHead title="Calendars">
        Debrief reads your calendars to name each recording, list who was there, and show what&apos;s coming up. It only reads; it never changes them.
      </PageHead>
      <div className="space-y-6">
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
            events: n[c.id] ?? 0,
          }))}
          contexts={contexts}
          google={{
            oauthReady: googleOAuthReady(),
            clientId: setting("GOOGLE_OAUTH_CLIENT_ID"),
            kind: cred.kind,
            email: cred.email,
            locked: cred.fromFile || settingSource("GOOGLE_CREDENTIALS") === "env",
            redirectUri: await googleRedirectUri(),
            found,
            listError,
          }}
          flash={{ add: sp.add === "google", connected: sp.google ?? null, error: sp.google_error ?? null }}
        />
        <SettingsForm fields={fields} />
      </div>
    </>
  );
}
