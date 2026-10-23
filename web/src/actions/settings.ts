"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { TASK_DESTINATIONS, calendars, createApiKey, deleteApiKey, setDeviceRule, testArchive } from "@debrief/core";
import { saveSettings, setOwnerPassword, settingDef, settingSource } from "@debrief/core/settings";
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

export async function addCalendar(input: { source: string; externalId: string; name: string; context: string }): Promise<Result> {
  try {
    await requireViewer();
    const v = z
      .object({
        source: z.enum(["google", "ics"]),
        externalId: z.string().trim().min(3).max(1000),
        name: z.string().trim().max(120),
        context,
      })
      .parse(input);
    if (v.source === "ics" && !/^(https?|webcal):\/\//i.test(v.externalId)) return { ok: false, error: "An ICS feed is a link starting with https://." };
    const externalId = v.source === "ics" ? v.externalId.replace(/^webcal:/i, "https:") : v.externalId;
    await db()
      .insert(calendars)
      .values({ source: v.source, externalId, name: v.name || (v.source === "ics" ? `${v.context} feed` : externalId), context: v.context });
    await db().execute(sql`select pg_notify('debrief_sync_now', '')`);
    refresh();
    return { ok: true, message: "Added. Syncing it now." };
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

export async function updateDevice(name: string, rule: { context?: string | null; defaultDestination?: (typeof TASK_DESTINATIONS)[number] | null }): Promise<Result> {
  try {
    await requireViewer();
    const v = z
      .object({ context: context.nullish().or(z.literal("").transform(() => null)), defaultDestination: z.enum(TASK_DESTINATIONS).nullish() })
      .parse(rule);
    await setDeviceRule(db(), z.string().min(1).max(80).parse(name), {
      ...(rule.context !== undefined ? { context: v.context ?? null } : {}),
      ...(rule.defaultDestination !== undefined ? { defaultDestination: v.defaultDestination ?? null } : {}),
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
        if (/^(PUBLIC_URL|S3_ENDPOINT|AUTH_OIDC_ISSUER)$/.test(key) && !/^https?:\/\//i.test(value)) throw new Error(`${def.label} should start with https://.`);
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
