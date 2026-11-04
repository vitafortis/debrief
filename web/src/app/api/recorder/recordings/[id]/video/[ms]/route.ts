import { appendVideo } from "@debrief/core/uploads";
import { db } from "@/lib/db";
import { apiKey, errorResponse, json, validId } from "@/lib/api-key";

export const dynamic = "force-dynamic";

/**
 * Appends the body to a video of the meeting window, `ms` into the recording.
 * Upload-Offset says where it starts and Upload-Length how big the whole video
 * is; a mismatch is a 409 with the offset the server has, to resume from.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; ms: string }> }) {
  const key = await apiKey(req);
  if (key instanceof Response) return key;
  const { id, ms } = await params;
  if (!validId(id)) return json({ error: "The id must be a UUID." }, 400);
  if (!/^\d{1,9}$/.test(ms)) return json({ error: "The time must be milliseconds into the recording." }, 400);
  const offset = Number(req.headers.get("upload-offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) return json({ error: "Send Upload-Offset: the byte position this chunk starts at." }, 400);
  if (!req.body) return json({ error: "No data." }, 400);
  const length = req.headers.get("content-length");
  try {
    return json(await appendVideo(db(), id, Number(ms), offset, Number(req.headers.get("upload-length")), req.body, length ? Number(length) : null));
  } catch (err) {
    return errorResponse(err);
  }
}
