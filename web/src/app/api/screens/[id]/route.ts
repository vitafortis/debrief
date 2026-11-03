import fs from "node:fs";
import { eq } from "drizzle-orm";
import { screens } from "@debrief/core/schema";
import { inRoot, recordingsDir } from "@debrief/core/storage";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";

/** A shared screen's image. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const [s] = await db().select({ filePath: screens.filePath }).from(screens).where(eq(screens.id, id));
  if (!s) return new Response("Not found", { status: 404 });
  try {
    const body = await fs.promises.readFile(/*turbopackIgnore: true*/ inRoot(recordingsDir(), s.filePath));
    return new Response(new Uint8Array(body), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
