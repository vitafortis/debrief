/**
 * Recordings streamed up by the desktop recorder, into the server's
 * recordings volume as <device>/<start>_<id>/audio.opus. Once every byte is
 * there, the recording is queued for the transcriber straight away.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db";
import { devices, recordings, transcripts, uploads } from "./schema";
import { settingNumber, timeZone } from "./settings";
import { recordingsDir } from "./storage";

export const AUDIO_TYPES = ["opus", "ogg", "m4a", "mp4", "wav", "flac", "mp3", "webm"] as const;
export const MAX_CHUNK = 32 * 1024 * 1024;

export const uploadStart = z.object({
  device: z.string().trim().min(1).max(80),
  startedAt: z.iso.datetime({ offset: true }),
  title: z.string().trim().max(200).nullish(),
  app: z.string().trim().max(200).nullish(),
  format: z.enum(AUDIO_TYPES).default("opus"),
});
export type UploadStart = z.infer<typeof uploadStart>;

export const uploadFinish = z.object({
  bytes: z.number().int().min(0),
  durationSecs: z.number().min(0).max(24 * 3600),
  title: z.string().trim().max(200).nullish(),
});

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly offset?: number
  ) {
    super(message);
  }
}

/** "Alex's MacBook Pro" -> "alexs-macbook-pro": the folder (and device) name. */
export function deviceSlug(name: string) {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "recorder";
}

/** 2026-10-22_14-03-11 in the server's time zone, the way recorders name folders. */
function folderStamp(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}`;
}

function resolveInRoot(root: string, rel: string) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new UploadError("Bad path.", 400);
  return full;
}

async function sizeOf(file: string) {
  try {
    return (await fs.promises.stat(/*turbopackIgnore: true*/ file)).size;
  } catch {
    return 0;
  }
}

/** Where an upload is at, and its transcript once there is one. */
export async function uploadStatus(db: Db, id: string, root = recordingsDir()) {
  const [u] = await db.select().from(uploads).where(eq(uploads.id, id));
  if (!u) return null;
  // A finished upload may since have moved to the archive.
  const offset = u.status === "completed" ? u.bytes : await sizeOf(resolveInRoot(root, path.join(u.folder, u.fileName)));
  const [rec] = await db
    .select({ status: recordings.status, transcriptId: transcripts.id })
    .from(recordings)
    .leftJoin(transcripts, eq(transcripts.recordingId, recordings.id))
    .where(eq(recordings.filePath, `${u.folder}/${u.fileName}`));
  return { id: u.id, status: u.status, offset, recording: rec?.status ?? null, transcriptId: rec?.transcriptId ?? null };
}

/** Starts an upload, or picks up the one with this id (the recorder retries freely). */
export async function startUpload(db: Db, id: string, input: UploadStart, apiKeyId: string | null, root = recordingsDir()) {
  const i = uploadStart.parse(input);
  const device = deviceSlug(i.device);
  const startedAt = new Date(i.startedAt);
  const folder = `${device}/${folderStamp(startedAt)}_${id.slice(0, 8)}`;
  const [u] = await db
    .insert(uploads)
    .values({ id, device, folder, fileName: `audio.${i.format}`, startedAt, title: i.title || null, app: i.app || null, apiKeyId })
    .onConflictDoUpdate({ target: uploads.id, set: { updatedAt: new Date(), title: sql`coalesce(excluded.title, ${uploads.title})` } })
    .returning();
  await db
    .insert(devices)
    .values({ name: device, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: devices.name, set: { lastSeenAt: new Date() } });
  const dir = resolveInRoot(root, u.folder);
  await fs.promises.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  return uploadStatus(db, id, root);
}

const locks = new Map<string, Promise<unknown>>();
function serialized<T>(id: string, fn: () => Promise<T>) {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next);
  next.finally(() => locks.get(id) === next && locks.delete(id)).catch(() => {});
  return next;
}

/**
 * Appends bytes at `offset`. When the offset isn't where the file ends (a
 * retried or lost chunk), nothing is written and the real end comes back.
 */
export function appendUpload(db: Db, id: string, offset: number, body: ReadableStream<Uint8Array> | Readable, length: number | null, root = recordingsDir()) {
  return serialized(id, async () => {
    const [u] = await db.select().from(uploads).where(eq(uploads.id, id));
    if (!u) throw new UploadError("No such upload. Start it first.", 404);
    if (u.status === "completed") throw new UploadError("This upload is finished.", 409, u.bytes);
    if (length !== null && length > MAX_CHUNK) throw new UploadError(`Send at most ${MAX_CHUNK} bytes at a time.`, 413);
    const file = resolveInRoot(root, path.join(u.folder, u.fileName));
    const size = await sizeOf(file);
    if (offset !== size) throw new UploadError("Offset doesn't match.", 409, size);

    const src = body instanceof Readable ? body : Readable.fromWeb(body as never);
    let written = 0;
    const counter = new (await import("node:stream")).Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > MAX_CHUNK) return cb(new UploadError(`Send at most ${MAX_CHUNK} bytes at a time.`, 413));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(src, counter, fs.createWriteStream(/*turbopackIgnore: true*/ file, { flags: "a" }));
    } catch (err) {
      // A cut-off chunk leaves a partial write: trim back so the next try lines up.
      await fs.promises.truncate(/*turbopackIgnore: true*/ file, size).catch(() => {});
      throw err instanceof UploadError ? err : new UploadError("The upload was interrupted.", 400, size);
    }
    const end = size + written;
    await db.update(uploads).set({ bytes: end, updatedAt: new Date() }).where(eq(uploads.id, id));
    return { offset: end };
  });
}

/** Queues a finished upload for the transcriber (once; finishing again changes nothing). */
async function queueRecording(db: Db, u: typeof uploads.$inferSelect) {
  const [rec] = await db
    .insert(recordings)
    .values({
      filePath: `${u.folder}/${u.fileName}`,
      fileSize: u.bytes,
      durationSecs: u.durationSecs ? Math.round(u.durationSecs) : null,
      recordedAt: u.startedAt,
      device: u.device,
      titleHint: u.title,
      status: "pending",
      storage: "local",
    })
    .onConflictDoNothing({ target: recordings.filePath })
    .returning({ id: recordings.id });
  if (rec) await db.execute(sql`select pg_notify('debrief_recording', ${rec.id})`);
}

/** Marks the upload done once every byte is here, and queues it for the transcriber. */
export function finishUpload(db: Db, id: string, input: z.infer<typeof uploadFinish>, root = recordingsDir()) {
  return serialized(id, async () => {
    const i = uploadFinish.parse(input);
    const [u] = await db.select().from(uploads).where(eq(uploads.id, id));
    if (!u) throw new UploadError("No such upload.", 404);
    if (u.status !== "completed") {
      const size = await sizeOf(resolveInRoot(root, path.join(u.folder, u.fileName)));
      if (size !== i.bytes) throw new UploadError(`Have ${size} of ${i.bytes} bytes.`, 409, size);
      const [done] = await db
        .update(uploads)
        .set({ status: "completed", bytes: size, durationSecs: i.durationSecs, title: i.title || u.title, updatedAt: new Date() })
        .where(eq(uploads.id, id))
        .returning();
      await queueRecording(db, done);
    } else if (u.bytes !== i.bytes) throw new UploadError(`Have ${u.bytes} of ${i.bytes} bytes.`, 409, u.bytes);
    return uploadStatus(db, id, root);
  });
}

/** Uploads that stopped (the laptop died or the app was killed) are transcribed as far as they got, after ABANDON_HOURS. */
export async function finishAbandonedUploads(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - settingNumber("ABANDON_HOURS") * 3600_000);
  const stale = await db
    .update(uploads)
    .set({ status: "completed", updatedAt: now })
    .where(and(eq(uploads.status, "recording"), lt(uploads.updatedAt, cutoff), gt(uploads.bytes, 0)))
    .returning();
  for (const u of stale) await queueRecording(db, u);
  return stale.length;
}
