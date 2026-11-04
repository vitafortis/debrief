import fs from "node:fs";
import { Readable } from "node:stream";

/** Streams a file with Range support, so a player can seek without downloading all of it. */
export function fileResponse(req: Request, file: string, size: number, type: string) {
  const headers = new Headers({ "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=3600" });
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
