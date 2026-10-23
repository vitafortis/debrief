import { eq } from "drizzle-orm";
import { devices } from "@debrief/core";
import { deviceSlug } from "@debrief/core/uploads";
import { db } from "@/lib/db";
import { apiKey, json } from "@/lib/api-key";

export const dynamic = "force-dynamic";

/** The recorder's "Test connection": checks the key, and says what this device is tagged as. */
export async function GET(req: Request) {
  const key = await apiKey(req);
  if (key instanceof Response) return key;
  const name = new URL(req.url).searchParams.get("device");
  const slug = name ? deviceSlug(name) : null;
  const [rule] = slug ? await db().select().from(devices).where(eq(devices.name, slug)) : [];
  return json({ ok: true, server: "Debrief", key: key.name, device: slug, context: rule?.context ?? null });
}
