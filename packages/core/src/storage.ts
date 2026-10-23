/**
 * Where recordings live. The recorder uploads into the server's recordings
 * volume (RECORDINGS_DIR); once a recording is transcribed, calendar-sync
 * copies it to the archive (the NAS folder or S3, Settings → Recordings) and
 * removes the server's copy after KEEP_LOCAL_DAYS. Recordings the transcriber
 * found in the watched NAS folder stay where they are.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AwsClient } from "aws4fetch";
import { and, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "./db";
import { recordings, type RecordingStorage } from "./schema";
import { setting, settingNumber } from "./settings";

/** The server's own recordings volume. */
export const recordingsDir = () => path.resolve(/*turbopackIgnore: true*/ process.env.RECORDINGS_DIR || "/data/recordings");
/** The NAS recordings folder, when one is mounted (AUDIO_DIR). */
export const folderDir = () => (process.env.AUDIO_DIR ? path.resolve(/*turbopackIgnore: true*/ process.env.AUDIO_DIR) : null);
/** The NAS exports folder for transcripts and notes, when one is mounted (EXPORT_DIR). */
export const exportsDir = () => process.env.EXPORT_DIR || null;

export type ArchiveTarget = "off" | "folder" | "s3";
export const archiveTarget = (): ArchiveTarget => {
  const v = setting("ARCHIVE");
  return v === "folder" || v === "s3" ? v : "off";
};

export function inRoot(root: string, rel: string) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error("Bad path.");
  return full;
}

async function sizeOf(file: string) {
  try {
    return (await fs.promises.stat(/*turbopackIgnore: true*/ file)).size;
  } catch {
    return null;
  }
}

// ── S3 ────────────────────────────────────────────────────────────────────

function s3() {
  const bucket = setting("S3_BUCKET");
  const accessKeyId = setting("S3_ACCESS_KEY_ID");
  const secretAccessKey = setting("S3_SECRET_ACCESS_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const region = setting("S3_REGION") || "us-east-1";
  const endpoint = (setting("S3_ENDPOINT") || `https://s3.${region}.amazonaws.com`).replace(/\/$/, "");
  const prefix = setting("S3_PREFIX");
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region }),
    // Path-style (endpoint/bucket/key) works with AWS, R2, B2, Wasabi and MinIO alike.
    url: (key: string) => `${endpoint}/${encodeURIComponent(bucket)}/${`${prefix}${key}`.split("/").map(encodeURIComponent).join("/")}`,
  };
}

export const s3Configured = () => !!s3();

function needS3() {
  const c = s3();
  if (!c) throw new Error("S3 isn't set up: add the bucket and keys in Settings → Recordings.");
  return c;
}

async function s3Check(res: Response, what: string) {
  if (!res.ok) throw new Error(`S3 ${what}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res;
}

async function s3Put(key: string, body: Buffer, type: string) {
  const c = needS3();
  await s3Check(await c.client.fetch(c.url(key), { method: "PUT", body: new Uint8Array(body), headers: { "content-type": type } }), `upload of ${key}`);
}

async function s3Size(key: string) {
  const c = needS3();
  const res = await c.client.fetch(c.url(key), { method: "HEAD" });
  if (res.status === 404) return null;
  await s3Check(res, `check of ${key}`);
  return Number(res.headers.get("content-length"));
}

/** A link the browser can play for the next hour; S3 handles the seeking. */
export async function presignedAudioUrl(key: string, seconds = 3600) {
  const c = needS3();
  const url = new URL(c.url(key));
  url.searchParams.set("X-Amz-Expires", String(seconds));
  return (await c.client.sign(url, { method: "GET", aws: { signQuery: true } })).url;
}

async function s3Download(key: string, dest: string) {
  const c = needS3();
  const res = await s3Check(await c.client.fetch(c.url(key)), `download of ${key}`);
  const tmp = `${dest}.part`;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(/*turbopackIgnore: true*/ tmp));
  await fs.promises.rename(/*turbopackIgnore: true*/ tmp, dest);
}

// ── Finding a recording ───────────────────────────────────────────────────

type Rec = { filePath: string; storage: RecordingStorage };
export type AudioSource = { kind: "file"; path: string; size: number } | { kind: "s3"; key: string } | null;

/** The server's copy if it still has one, else the NAS folder or S3. */
export async function locateAudio(rec: Rec): Promise<AudioSource> {
  const local = inRoot(recordingsDir(), rec.filePath);
  const size = await sizeOf(local);
  if (size !== null) return { kind: "file", path: local, size };
  const folder = folderDir();
  if (rec.storage === "folder" && folder) {
    const p = inRoot(folder, rec.filePath);
    const s = await sizeOf(p);
    if (s !== null) return { kind: "file", path: p, size: s };
  }
  if (rec.storage === "s3" && s3Configured()) return { kind: "s3", key: rec.filePath };
  return null;
}

/** Brings an S3 recording back to the server so the transcriber can read it. */
export async function restoreLocal(rec: Rec) {
  const local = inRoot(recordingsDir(), rec.filePath);
  if ((await sizeOf(local)) !== null) return;
  if (rec.storage === "s3") return s3Download(rec.filePath, local);
  if (rec.storage === "folder" && !folderDir()) throw new Error("This recording is in the NAS folder, which isn't mounted.");
}

// ── Archiving ─────────────────────────────────────────────────────────────

/** What a recorder writes beside its audio, so the archive makes sense without the database. */
function sidecar(r: typeof recordings.$inferSelect) {
  return JSON.stringify(
    {
      status: "completed",
      created_at: r.recordedAt.toISOString(),
      meeting_name: r.titleHint,
      duration_seconds: r.durationSecs,
      device: r.device,
      source: "debrief-recorder",
    },
    null,
    2
  );
}

const AUDIO_TYPE: Record<string, string> = { ".opus": "audio/ogg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".wav": "audio/wav", ".flac": "audio/flac", ".mp3": "audio/mpeg", ".webm": "audio/webm" };

/** Copies one recording from the server to the archive, checks the copy, and records where it went. */
export async function archiveRecording(db: Db, r: typeof recordings.$inferSelect) {
  const target = archiveTarget();
  if (target === "off") throw new Error("Archiving is off.");
  const local = inRoot(recordingsDir(), r.filePath);
  const size = await sizeOf(local);
  if (size === null) throw new Error(`${r.filePath} isn't on the server.`);

  if (target === "folder") {
    const root = folderDir();
    if (!root) throw new Error("No NAS folder is mounted (AUDIO_DIR).");
    const dest = inRoot(root, r.filePath);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    // A dot-name while copying, so a watching transcriber skips it.
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.part`);
    await fs.promises.copyFile(/*turbopackIgnore: true*/ local, tmp);
    await fs.promises.rename(/*turbopackIgnore: true*/ tmp, dest);
    if ((await sizeOf(dest)) !== size) throw new Error(`The copy of ${r.filePath} on the NAS is the wrong size.`);
    const meta = path.join(path.dirname(dest), "metadata.json");
    if ((await sizeOf(meta)) === null) await fs.promises.writeFile(/*turbopackIgnore: true*/ meta, sidecar(r));
  } else {
    await s3Put(r.filePath, await fs.promises.readFile(/*turbopackIgnore: true*/ local), AUDIO_TYPE[path.extname(local).toLowerCase()] ?? "application/octet-stream");
    if ((await s3Size(r.filePath)) !== size) throw new Error(`The copy of ${r.filePath} in S3 is the wrong size.`);
    await s3Put(`${path.posix.dirname(r.filePath)}/metadata.json`, Buffer.from(sidecar(r)), "application/json");
  }
  await db.update(recordings).set({ storage: target, archivedAt: new Date() }).where(eq(recordings.id, r.id));
}

/** Archives transcribed recordings still only on the server. */
export async function archivePending(db: Db, limit = 20) {
  if (archiveTarget() === "off") return { archived: 0, errors: [] as string[] };
  const rows = await db
    .select()
    .from(recordings)
    .where(and(eq(recordings.storage, "local"), inArray(recordings.status, ["done", "error"])))
    .orderBy(recordings.recordedAt)
    .limit(limit);
  const errors: string[] = [];
  let archived = 0;
  for (const r of rows) {
    try {
      await archiveRecording(db, r);
      archived++;
    } catch (err) {
      errors.push(`${r.filePath}: ${(err as Error).message}`);
    }
  }
  return { archived, errors };
}

async function walk(dir: string, root: string, out: string[] = []) {
  for (const e of await fs.promises.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, root, out);
    else out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
}

async function removeEmptyDirs(dir: string, root: string) {
  while (dir !== root && dir.startsWith(root + path.sep)) {
    const left = await fs.promises.readdir(/*turbopackIgnore: true*/ dir).catch(() => null);
    if (!left || left.length) return;
    await fs.promises.rmdir(/*turbopackIgnore: true*/ dir).catch(() => {});
    dir = path.dirname(dir);
  }
}

/** Removes the server's copy of recordings archived more than KEEP_LOCAL_DAYS ago. */
export async function pruneLocalCopies(db: Db, now = new Date()) {
  if (archiveTarget() === "off") return 0;
  const root = recordingsDir();
  const files = await walk(root, root);
  if (!files.length) return 0;
  const cutoff = new Date(now.getTime() - settingNumber("KEEP_LOCAL_DAYS") * 86400_000);
  const done = await db
    .select({ filePath: recordings.filePath })
    .from(recordings)
    .where(
      and(
        inArray(recordings.filePath, files),
        ne(recordings.storage, "local"),
        isNotNull(recordings.archivedAt),
        lt(recordings.archivedAt, cutoff),
        inArray(recordings.status, ["done", "error"])
      )
    );
  for (const { filePath } of done) {
    const full = inRoot(root, filePath);
    await fs.promises.rm(/*turbopackIgnore: true*/ full, { force: true });
    await removeEmptyDirs(path.dirname(full), root);
  }
  return done.length;
}

/** Writes and deletes a small file in the archive, to check the settings work. */
export async function testArchive() {
  const target = archiveTarget();
  const name = `.debrief-test-${Date.now()}`;
  if (target === "folder") {
    const root = folderDir();
    if (!root) throw new Error("No NAS folder is mounted on the server (AUDIO_DIR). See the README, \"Archive to a NAS\".");
    const p = path.join(root, name);
    await fs.promises.writeFile(/*turbopackIgnore: true*/ p, "ok");
    await fs.promises.rm(/*turbopackIgnore: true*/ p);
    return `Wrote to ${root}.`;
  }
  if (target === "s3") {
    await s3Put(name, Buffer.from("ok"), "text/plain");
    const c = needS3();
    await s3Check(await c.client.fetch(c.url(name), { method: "DELETE" }), "delete");
    return `Wrote to bucket ${setting("S3_BUCKET")}.`;
  }
  throw new Error("Archiving is off.");
}

/** Where recordings are, for Settings. */
export async function storageCounts(db: Db) {
  const rows = await db
    .select({ storage: recordings.storage, n: sql<number>`count(*)::int` })
    .from(recordings)
    .groupBy(recordings.storage);
  return Object.fromEntries(rows.map((r) => [r.storage, r.n])) as Partial<Record<RecordingStorage, number>>;
}
