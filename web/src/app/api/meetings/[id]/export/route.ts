import { getMeeting, transcriptText } from "@debrief/core";
import { clock, speakerName } from "@debrief/core/extract";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";
import { fmtDateTime, isoDay } from "@/lib/format";

/** The transcript as Markdown or plain text, for pasting elsewhere. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireViewer();
  const { id } = await params;
  const m = /^[0-9a-f-]{36}$/i.test(id) ? await getMeeting(db(), id) : null;
  if (!m) return new Response("Not found", { status: 404 });
  const format = new URL(req.url).searchParams.get("format") === "txt" ? "txt" : "md";
  const name = `${isoDay(m.recording.recordedAt)} ${m.displayTitle}`.replace(/[^\w .-]+/g, "").slice(0, 80);

  let body: string;
  if (format === "txt") {
    body = transcriptText(m) + "\n";
  } else {
    const segs = m.transcript.speakerSegments ?? [];
    body = [
      `# ${m.displayTitle}`,
      "",
      `${fmtDateTime(m.recording.recordedAt)}${m.attendees.length ? ` · ${m.attendees.map((a) => a.name ?? a.email).join(", ")}` : ""}`,
      "",
      ...(m.transcript.summary ? ["## Summary", "", m.transcript.summary, ""] : []),
      ...(m.tasks.length ? ["## Action items", "", ...m.tasks.filter((t) => t.status !== "dismissed").map((t) => `- [${t.status === "pushed" ? "x" : " "}] ${t.description}${t.assignee ? ` (${t.assignee})` : ""}`), ""] : []),
      "## Transcript",
      "",
      ...(segs.length
        ? segs.map((s) => `**${speakerName(m.transcript.speakerNames, s.speaker)}** \`${clock(s.start)}\` ${s.text.trim()}\n`)
        : [m.transcript.content]),
    ].join("\n");
  }
  return new Response(body, {
    headers: {
      "content-type": format === "txt" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.${format}"`,
    },
  });
}
