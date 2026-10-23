import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { recordings } from "@debrief/core/schema";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";

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

/** Streams a recording from the NAS mount, with Range support so the player can seek. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const [rec] = await db().select({ filePath: recordings.filePath }).from(recordings).where(eq(recordings.id, id));
  if (!rec) return new Response("Not found", { status: 404 });

  const root = path.resolve(/*turbopackIgnore: true*/ process.env.AUDIO_DIR ?? "/mnt/meetings/audio");
  const file = path.resolve(root, rec.filePath);
  if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
  let size: number;
  try {
    size = (await fs.promises.stat(/*turbopackIgnore: true*/ file)).size;
  } catch {
    return new Response("The recording isn't in the recordings folder any more.", { status: 404 });
  }

  const headers = new Headers({
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  });
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(Readable.toWeb(fs.createReadStream(/*turbopackIgnore: true*/ file, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(Readable.toWeb(fs.createReadStream(/*turbopackIgnore: true*/ file)) as ReadableStream, { headers });
}
