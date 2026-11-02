"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DEVICE_COLORS, TASK_DESTINATIONS, calendars, createApiKey, deleteApiKey, setDeviceRule, testAi, testArchive } from "@debrief/core";
import { saveSettings, setOwnerPassword, settingDef, settingNumber, settingSource } from "@debrief/core/settings";
import { checkCalendar } from "@debrief/core/calendar-sync";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";

type Result = { ok: true; message?: string } | { ok: false; error: string };

const context = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "A context is one short word, like work or side.");

const patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  context: context.optional(),
  enabled: z.boolean().optional(),
  defaultDestination: z.enum(TASK_DESTINATIONS).optional(),
});

function fail(err: unknown): Result {
  if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the fields." };
  const msg = (err as Error).message;
  return { ok: false, error: /duplicate key/.test(msg) ? "That calendar is already added." : msg };
}

function refresh() {
  revalidatePath("/", "layout");
}

export async function updateCalendar(id: string, input: z.infer<typeof patch>): Promise<Result> {
  try {
    await requireViewer();
    await db().update(calendars).set(patch.parse(input)).where(eq(calendars.id, z.uuid().parse(id)));
    refresh();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

const newCalendar = z.object({ source: z.enum(["google", "ics"]), externalId: z.string().trim().min(3).max(1000), name: z.string().trim().max(120) });

/** Adds calendars (or turns on ones found in a Google account) under one context, and syncs them straight away. */
export async function addCalendars(list: z.input<typeof newCalendar>[], ctx: string, defaultDestination: string): Promise<Result> {
  try {
    await requireViewer();
    const items = z.array(newCalendar).min(1, "Pick a calendar.").max(50).parse(list);
    const c = context.parse(ctx);
    const dest = z.enum(TASK_DESTINATIONS).parse(defaultDestination);
    for (const v of items) {
      if (v.source === "ics" && !/^(https?|webcal):\/\//i.test(v.externalId)) return { ok: false, error: "An ICS link starts with https://." };
      const externalId = v.source === "ics" ? v.externalId.replace(/^webcal:/i, "https:") : v.externalId;
      const name = v.name || (v.source === "ics" ? `${c} feed` : externalId);
      await db()
        .insert(calendars)
        .values({ source: v.source, externalId, name, context: c, defaultDestination: dest })
        .onConflictDoUpdate({ target: [calendars.source, calendars.externalId], set: { enabled: true, name, context: c, defaultDestination: dest } });
    }
    await db().execute(sql`select pg_notify('debrief_sync_now', '')`);
    refresh();
    return { ok: true, message: items.length === 1 ? "Added. Syncing it now." : `Added ${items.length} calendars. Syncing them now.` };
  } catch (err) {
    return fail(err);
  }
}

/** Tries a calendar before it's added. */
export async function checkCalendarAction(source: "google" | "ics", externalId: string): Promise<Result & { name?: string | null; events?: number }> {
  try {
    await requireViewer();
    const id = z.string().trim().min(3).max(1000).parse(externalId);
    const r = await checkCalendar(z.enum(["google", "ics"]).parse(source), source === "ics" ? id.replace(/^webcal:/i, "https:") : id);
    const days = settingNumber("SYNC_DAYS_BACK") + settingNumber("SYNC_DAYS_AHEAD");
    return { ok: true, name: r.name, events: r.events, message: `Can read it${r.name ? `: ${r.name}` : ""}. ${r.events} event${r.events === 1 ? "" : "s"} in the ${days} days Debrief syncs.` };
  } catch (err) {
    return fail(err);
  }
}

/** The OAuth client from the owner's Google Cloud project, for Connect Google. */
export async function saveGoogleClient(clientId: string, clientSecret: string): Promise<Result> {
  try {
    await requireViewer();
    const id = z
      .string()
      .trim()
      .regex(/\.apps\.googleusercontent\.com$/, "The client ID ends in .apps.googleusercontent.com.")
      .parse(clientId);
    const secret = z.string().trim().min(10, "Paste the client secret too.").parse(clientSecret);
    await saveSettings(db(), { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret });
    refresh();
    return { ok: true, message: "Saved. Now connect your Google account." };
  } catch (err) {
    return fail(err);
  }
}

/** A service account key or gcloud's file, uploaded in the calendar steps. */
export async function saveGoogleKey(json: string): Promise<Result> {
  return saveSettingsAction({ GOOGLE_CREDENTIALS: json });
}

/** Forgets the Google credentials. Calendars stay, and stop syncing until Google is connected again. */
export async function disconnectGoogle(): Promise<Result> {
  try {
    await requireViewer();
    if (settingSource("GOOGLE_CREDENTIALS") === "env") throw new Error("The Google credentials are set in the environment.");
    await saveSettings(db(), { GOOGLE_CREDENTIALS: null });
    refresh();
    return { ok: true, message: "Google disconnected." };
  } catch (err) {
    return fail(err);
  }
}

export async function removeCalendar(id: string): Promise<Result> {
  try {
    await requireViewer();
    await db().delete(calendars).where(eq(calendars.id, z.uuid().parse(id)));
    refresh();
    return { ok: true, message: "Removed, with its events." };
  } catch (err) {
    return fail(err);
  }
}

export async function createKey(name: string): Promise<Result & { key?: string }> {
  try {
    await requireViewer();
    const k = await createApiKey(db(), z.string().trim().min(1, "Name the key (where it's used).").max(80).parse(name));
    refresh();
    return { ok: true, key: k.key };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteKey(id: string): Promise<Result> {
  try {
    await requireViewer();
    await deleteApiKey(db(), z.uuid().parse(id));
    refresh();
    return { ok: true, message: "Key revoked. Anything using it is signed out." };
  } catch (err) {
    return fail(err);
  }
}

export async function updateDevice(
  name: string,
  rule: { context?: string | null; defaultDestination?: (typeof TASK_DESTINATIONS)[number] | null; label?: string | null; color?: (typeof DEVICE_COLORS)[number] | null }
): Promise<Result> {
  try {
    await requireViewer();
    const v = z
      .object({
        context: context.nullish().or(z.literal("").transform(() => null)),
        defaultDestination: z.enum(TASK_DESTINATIONS).nullish(),
        label: z.string().trim().max(24).nullish(),
        color: z.enum(DEVICE_COLORS).nullish(),
      })
      .parse(rule);
    await setDeviceRule(db(), z.string().min(1).max(80).parse(name), {
      ...(rule.context !== undefined ? { context: v.context ?? null } : {}),
      ...(rule.defaultDestination !== undefined ? { defaultDestination: v.defaultDestination ?? null } : {}),
      ...(rule.label !== undefined ? { label: v.label || null } : {}),
      ...(rule.color !== undefined ? { color: v.color ?? null } : {}),
    });
    refresh();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Saves settings from a Settings form. Values set in the environment can't be changed here. */
export async function saveSettingsAction(values: Record<string, string | null>): Promise<Result> {
  try {
    await requireViewer();
    const clean: Record<string, string | null> = {};
    for (const [key, raw] of Object.entries(values)) {
      const def = settingDef(key);
      if (!def || def.hidden) throw new Error(`Unknown setting ${key}.`);
      if (settingSource(key) === "env") continue;
      const value = raw === null ? null : raw.trim();
      if (value) {
        if (def.type === "number" && !Number.isFinite(Number(value))) throw new Error(`${def.label} should be a number.`);
        if (def.type === "select" && def.options && !def.options.some((o) => o.value === value)) throw new Error(`Pick one of the options for ${def.label}.`);
        if (key === "TZ") {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: value });
          } catch {
            throw new Error(`${value} isn't a time zone (try America/New_York).`);
          }
        }
        if (key === "GOOGLE_CREDENTIALS") {
          try {
            const j = JSON.parse(value);
            if (!j.type) throw new Error();
          } catch {
            throw new Error("The Google credentials should be the JSON file from Google Cloud (it has a \"type\" field).");
          }
        }
        if (/^(PUBLIC_URL|S3_ENDPOINT|AUTH_OIDC_ISSUER|AI_BASE_URL)$/.test(key) && !/^https?:\/\//i.test(value)) throw new Error(`${def.label} should start with https://.`);
      }
      clean[key] = value || null;
    }
    await saveSettings(db(), clean);
    refresh();
    return { ok: true, message: "Saved." };
  } catch (err) {
    return fail(err);
  }
}

export async function changePassword(password: string): Promise<Result> {
  try {
    await requireViewer();
    await setOwnerPassword(db(), password);
    return { ok: true, message: "Password changed." };
  } catch (err) {
    return fail(err);
  }
}

export async function testArchiveAction(): Promise<Result> {
  try {
    await requireViewer();
    return { ok: true, message: await testArchive() };
  } catch (err) {
    return fail(err);
  }
}

export async function testAiAction(): Promise<Result> {
  try {
    await requireViewer();
    const r = await testAi();
    return { ok: true, message: `✓ ${r.model} answered in ${(r.ms / 1000).toFixed(1)} s.` };
  } catch (err) {
    return fail(err);
  }
}
