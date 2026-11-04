import path from "node:path";
import { eq } from "drizzle-orm";
import { recordings } from "@debrief/core/schema";
import { locateAudio, presignedAudioUrl } from "@debrief/core/storage";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";
import { fileResponse } from "@/lib/file-response";

const TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
};

/** Streams a recording from the server or the NAS, with Range support so the player can seek; S3 recordings redirect to a short-lived link. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const [rec] = await db().select({ filePath: recordings.filePath, storage: recordings.storage }).from(recordings).where(eq(recordings.id, id));
  if (!rec) return new Response("Not found", { status: 404 });

  let found;
  try {
    found = await locateAudio(rec);
  } catch {
    found = null;
  }
  if (!found) return new Response("The recording isn't on the server or in the archive any more.", { status: 404 });
  if (found.kind === "s3") return Response.redirect(await presignedAudioUrl(found.key), 302);
  const { path: file, size } = found;

  return fileResponse(req, file, size, TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
}
