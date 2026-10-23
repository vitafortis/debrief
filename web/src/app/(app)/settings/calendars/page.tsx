import type { Metadata } from "next";
import { calendars } from "@debrief/core";
import { db } from "@/lib/db";
import { fmtAgo } from "@/lib/format";
import { CalendarSettings } from "../calendar-settings";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";

export const metadata: Metadata = { title: "Calendars · Settings" };

export default async function CalendarsSettings() {
  const [fields, cals] = await Promise.all([fieldsFor("calendars"), db().select().from(calendars).orderBy(calendars.context, calendars.name)]);
  return (
    <>
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
      <SettingsForm
        title="Google and syncing"
        description="Google calendars need credentials: a service account key, or your own account's. ICS feeds don't."
        fields={fields}
      />
    </>
  );
}
