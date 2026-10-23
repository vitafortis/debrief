import { startUpload, uploadStatus } from "@debrief/core/uploads";
import { db } from "@/lib/db";
import { apiKey, errorResponse, json, validId } from "@/lib/api-key";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Where an upload is at: bytes received ("offset"), and its transcript once it has one. */
export async function GET(req: Request, { params }: Ctx) {
  const key = await apiKey(req);
  if (key instanceof Response) return key;
  const { id } = await params;
  const s = validId(id) ? await uploadStatus(db(), id) : null;
  return s ? json(s) : json({ error: "No such upload." }, 404);
}

/** Starts (or resumes) an upload: { device, startedAt, title?, app?, format? }. The id is the recorder's. */
export async function PUT(req: Request, { params }: Ctx) {
  const key = await apiKey(req);
  if (key instanceof Response) return key;
  const { id } = await params;
  if (!validId(id)) return json({ error: "The id must be a UUID." }, 400);
  try {
    return json(await startUpload(db(), id, await req.json(), key.id));
  } catch (err) {
    return errorResponse(err);
  }
}
