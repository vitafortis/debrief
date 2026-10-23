import { appendUpload } from "@debrief/core/uploads";
import { db } from "@/lib/db";
import { apiKey, errorResponse, json, validId } from "@/lib/api-key";

export const dynamic = "force-dynamic";

/**
 * Appends the body to the recording. Upload-Offset says where it starts; a
 * mismatch is a 409 with the offset the server has, to resume from.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const key = await apiKey(req);
  if (key instanceof Response) return key;
  const { id } = await params;
  if (!validId(id)) return json({ error: "The id must be a UUID." }, 400);
  const offset = Number(req.headers.get("upload-offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) return json({ error: "Send Upload-Offset: the byte position this chunk starts at." }, 400);
  if (!req.body) return json({ error: "No data." }, 400);
  const length = req.headers.get("content-length");
  try {
    return json(await appendUpload(db(), id, offset, req.body, length ? Number(length) : null));
  } catch (err) {
    return errorResponse(err);
  }
}
