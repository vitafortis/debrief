import { finishUpload } from "@debrief/core/uploads";
import { db } from "@/lib/db";
import { apiKey, errorResponse, json, validId } from "@/lib/api-key";

export const dynamic = "force-dynamic";

/** Ends an upload once every byte is in: { bytes, durationSecs, title? }. Transcription starts from here. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const key = await apiKey(req);
  if (key instanceof Response) return key;
  const { id } = await params;
  if (!validId(id)) return json({ error: "The id must be a UUID." }, 400);
  try {
    return json(await finishUpload(db(), id, await req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}
