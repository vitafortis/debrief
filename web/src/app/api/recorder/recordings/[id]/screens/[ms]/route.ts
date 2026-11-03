import { saveScreen } from "@debrief/core/uploads";
import { db } from "@/lib/db";
import { apiKey, errorResponse, json, validId } from "@/lib/api-key";

export const dynamic = "force-dynamic";

/** Saves a shared screen the recorder kept: the body is a JPEG, `ms` is when in the recording. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; ms: string }> }) {
  const key = await apiKey(req);
  if (key instanceof Response) return key;
  const { id, ms } = await params;
  if (!validId(id)) return json({ error: "The id must be a UUID." }, 400);
  if (!/^\d{1,9}$/.test(ms)) return json({ error: "The time must be milliseconds into the recording." }, 400);
  try {
    return json(await saveScreen(db(), id, Number(ms), new Uint8Array(await req.arrayBuffer())));
  } catch (err) {
    return errorResponse(err);
  }
}
