import fs from "node:fs";
import { eq } from "drizzle-orm";
import { recordings } from "@debrief/core/schema";
import { listVideos } from "@debrief/core/storage";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";
import { fileResponse } from "@/lib/file-response";

/** A video of the meeting window, `ms` into the recording, with Range support so the player can seek. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; ms: string }> }) {
  await requireViewer();
  const { id, ms } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{1,9}$/.test(ms)) return new Response("Not found", { status: 404 });
  const [rec] = await db().select({ filePath: recordings.filePath }).from(recordings).where(eq(recordings.id, id));
  if (!rec) return new Response("Not found", { status: 404 });
  const video = (await listVideos(rec.filePath).catch(() => [])).find((v) => v.ms === Number(ms));
  const stat = video && (await fs.promises.stat(/*turbopackIgnore: true*/ video.file).catch(() => null));
  if (!video || !stat) return new Response("Not found", { status: 404 });
  return fileResponse(req, video.file, stat.size, "video/mp4");
}
