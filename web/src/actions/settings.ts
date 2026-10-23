"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { TASK_DESTINATIONS, calendars, createApiKey, deleteApiKey, setDeviceRule } from "@debrief/core";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";

type Result = { ok: true; message?: string } | { ok: false; error: string };

const context = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "A context is one short word, like acme or lumen.");

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
