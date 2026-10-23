import "server-only";
import { bearer, verifyApiKey } from "@debrief/core/apikeys";
import { UploadError } from "@debrief/core/uploads";
import { db } from "@/lib/db";

export const json = (data: unknown, status = 200) => Response.json(data, { status });

/** The API key on a request (Authorization: Bearer dbk_…), or a 401 to send back. */
export async function apiKey(req: Request) {
  const key = await verifyApiKey(db(), bearer(req.headers.get("authorization")));
  return key ?? json({ error: "Missing or unknown API key. Make one in Debrief → Settings → API keys." }, 401);
}

export const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** Turns a thrown error into the JSON the recorder reads ({ error, offset? }). */
export function errorResponse(err: unknown) {
  if (err instanceof UploadError) return json({ error: err.message, ...(err.offset !== undefined ? { offset: err.offset } : {}) }, err.status);
  const e = err as { issues?: { message: string; path: (string | number)[] }[]; message: string };
  if (e.issues) return json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  console.error(err);
  return json({ error: e.message || "Something went wrong." }, 500);
}
