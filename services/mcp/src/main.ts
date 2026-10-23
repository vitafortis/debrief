/**
 * The Debrief MCP server: lets Claude search and read meetings, save the
 * action items it finds, and send them to Akiflow or Linear.
 *
 * Streamable HTTP at /mcp, stateless, behind a bearer token: an API key
 * from Settings, or the fixed MCP token (Settings → Claude).
 */
import crypto from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  EXTRACTION_GUIDE,
  PRIORITIES,
  TASK_DESTINATIONS,
  TASK_STATUSES,
  bearer,
  createLinearIssue,
  getDb,
  getMeeting,
  integrationStatus,
  listMeetings,
  listTasks,
  meetingBrief,
  meetingTitle,
  publicUrl,
  pushTask,
  refreshSettings,
  requestPublish,
  saveExtractedTasks,
  searchTranscripts,
  setTaskStatus,
  setting,
  taskInput,
  timeZone,
  transcriptText,
  transcripts,
  updateTask,
  verifyApiKey,
  type Meeting,
} from "@debrief/core";
import { HL_END, HL_START } from "@debrief/core/search";
import { waitForSchema } from "@debrief/core/migrate";

process.env.DATABASE_URL ||= process.env.POSTGRES_URL;
const PORT = Number(process.env.PORT ?? 3151);
const NO_AUTH = process.env.MCP_ALLOW_NO_AUTH === "true";

const db = () => getDb();
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const plain = (s: string) => s.replaceAll(HL_START, "**").replaceAll(HL_END, "**");
const link = (id: string) => (publicUrl() ? `${publicUrl()}/meetings/${id}` : undefined);
const date = (s: string | undefined, name: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${name} isn't a date (use YYYY-MM-DD).`);
  return d;
};

async function meetingOr404(id: string): Promise<Meeting> {
  const m = z.uuid().safeParse(id).success ? await getMeeting(db(), id) : null;
  if (!m) throw new Error(`No meeting with id ${id}. Find ids with search_transcripts or list_recent_meetings.`);
  return m;
}

function meetingHeader(m: Meeting) {
  return {
    id: m.transcript.id,
    title: m.displayTitle,
    recordedAt: m.recording.recordedAt.toISOString(),
    durationMinutes: m.recording.durationSecs ? Math.round(m.recording.durationSecs / 60) : null,
    calendar: m.context,
    url: link(m.transcript.id),
  };
}

function build() {
  const server = new McpServer(
    { name: "debrief", version: "0.1.0" },
    {
      instructions:
        "Debrief holds the user's meeting transcripts, matched to their calendar events. Calendar contexts split work (e.g. acme) from side projects (e.g. lumen). To capture follow-ups: read a meeting with extract_tasks, then save what you find with save_tasks; the user reviews them in Debrief, or you can send them with push_task.",
    }
  );
  const wrap =
    <A,>(fn: (a: A) => Promise<ReturnType<typeof json>>) =>
    async (a: A) => {
      try {
        return await fn(a);
      } catch (err) {
        return fail(err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message);
      }
    };

  server.registerTool(
    "search_transcripts",
    {
      title: "Search transcripts",
      description:
        'Full-text search across meeting transcripts. Supports "exact phrases", -excluded words and OR. Returns meetings with the matching lines, who said them and when (seconds from the start).',
      inputSchema: {
        query: z.string().min(1).describe("What to look for"),
        date_from: z.string().optional().describe("YYYY-MM-DD, inclusive"),
        date_to: z.string().optional().describe("YYYY-MM-DD, inclusive"),
        calendar: z.string().optional().describe("A calendar context, e.g. acme or lumen"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ query, date_from, date_to, calendar, limit }) => {
      const to = date(date_to, "date_to");
      const results = await searchTranscripts(db(), query, {
        context: calendar,
        from: date(date_from, "date_from"),
        to: to ? new Date(to.getTime() + 86400_000) : undefined,
        limit: limit ?? 10,
      });
      return json(
        results.map((r) => ({
          id: r.transcriptId,
          title: r.title,
          recordedAt: r.recordedAt.toISOString(),
          calendar: r.context,
          url: link(r.transcriptId),
          matches: r.excerpts.map((x) => ({
            speaker: x.speaker ? (r.speakerNames[x.speaker] ?? x.speaker) : null,
            atSeconds: x.start,
            text: plain(x.text),
          })),
        }))
      );
    })
  );

  server.registerTool(
    "list_recent_meetings",
    {
      title: "Recent meetings",
      description: "Meetings recorded in the last few days, newest first, with their summaries and how many tasks are still open.",
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe("How far back (default 7)"),
        calendar: z.string().optional().describe("A calendar context, e.g. acme or lumen"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ days, calendar }) => {
      const rows = await listMeetings(db(), { context: calendar, from: new Date(Date.now() - (days ?? 7) * 86400_000), limit: 100 });
      return json(
        rows.map((m) => ({
          id: m.id,
          title: m.displayTitle,
          recordedAt: m.recordedAt.toISOString(),
          durationMinutes: m.durationSecs ? Math.round(m.durationSecs / 60) : null,
          calendar: m.context,
          attendees: m.attendeeCount,
          summary: m.summary,
          openTasks: m.openTasks,
          url: link(m.id),
        }))
      );
    })
  );

  server.registerTool(
    "get_transcript",
    {
      title: "Get a transcript",
      description: "The full transcript of one meeting, one speaker turn per line as [m:ss] Speaker: text.",
      inputSchema: { id: z.string().describe("Meeting (transcript) id") },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ id }) => {
      const m = await meetingOr404(id);
      return text(`${JSON.stringify(meetingHeader(m))}\n\n${transcriptText(m)}`);
    })
  );

  server.registerTool(
    "get_meeting_context",
    {
      title: "Get meeting context",
      description: "One meeting's calendar event, attendees, summary and tasks, plus its transcript.",
      inputSchema: { id: z.string().describe("Meeting (transcript) id"), include_transcript: z.boolean().optional().describe("Default true") },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ id, include_transcript }) => {
      const m = await meetingOr404(id);
      return json({
        ...meetingHeader(m),
        event: m.event && {
          title: m.event.title,
          start: m.event.startAt.toISOString(),
          end: m.event.endAt.toISOString(),
          organizer: m.event.organizerEmail,
          conferenceUrl: m.event.conferenceUrl,
          matchedBy: m.event.manual ? "hand" : `time overlap ${Math.round(m.event.confidence * 100)}%`,
        },
        attendees: m.attendees.map((a) => ({ name: a.name, email: a.email, rsvp: a.rsvpStatus })),
        summary: m.transcript.summary,
        tasks: m.tasks.map((t) => ({ id: t.id, description: t.description, assignee: t.assignee, dueDate: t.dueDate, status: t.status, destination: t.destination })),
        transcript: include_transcript === false ? undefined : transcriptText(m),
      });
    })
  );

  server.registerTool(
    "extract_tasks",
    {
      title: "Extract tasks from a meeting",
      description:
        "Returns a meeting's transcript and context with instructions for pulling out its action items. Read it, then call save_tasks with what you find (and a short summary).",
      inputSchema: { transcript_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ transcript_id }) => {
      const m = await meetingOr404(transcript_id);
      const existing = m.tasks.filter((t) => t.status !== "pending");
      return text(
        [
          EXTRACTION_GUIDE,
          `Today is ${new Date().toLocaleDateString("en-CA", { timeZone: timeZone() })}.`,
          existing.length
            ? `Already reviewed or sent (don't repeat these): ${existing.map((t) => `"${t.description}"`).join("; ")}.`
            : null,
          `When done, call save_tasks with transcript_id "${m.transcript.id}".`,
          "",
          "---",
          meetingBrief(m),
        ]
          .filter((l) => l !== null)
          .join("\n")
      );
    })
  );

  server.registerTool(
    "save_tasks",
    {
      title: "Save a meeting's action items",
      description:
        "Saves action items for a meeting, for the user to review in Debrief. Replaces items still awaiting review; ones already approved or sent are kept. Optionally saves a summary too.",
      inputSchema: {
        transcript_id: z.string(),
        tasks: z.array(z.object(taskInput.shape)).max(50),
        summary: z.string().max(4000).optional().describe("2–5 sentences on what was covered and decided"),
      },
    },
    wrap(async ({ transcript_id, tasks, summary }) => {
      const m = await meetingOr404(transcript_id);
      if (summary) await db().update(transcripts).set({ summary }).where(eq(transcripts.id, m.transcript.id));
      const rows = await saveExtractedTasks(db(), m.transcript.id, tasks);
      if (summary || m.transcript.summary) await requestPublish(db(), m.transcript.id);
      return json({
        saved: rows.map((t) => ({ id: t.id, description: t.description, destination: t.destination })),
        reviewAt: link(m.transcript.id) ?? "the Tasks page in Debrief",
      });
    })
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "Action items from meetings, by status (pending = awaiting the user's review).",
      inputSchema: {
        status: z.array(z.enum(TASK_STATUSES)).optional().describe("Default: pending and approved"),
        calendar: z.string().optional(),
        transcript_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ status, calendar, transcript_id }) => {
      const rows = await listTasks(db(), { status: status ?? ["pending", "approved"], context: calendar, transcriptId: transcript_id, limit: 200 });
      return json(
        rows.map((r) => ({
          id: r.task.id,
          description: r.task.description,
          assignee: r.task.assignee,
          dueDate: r.task.dueDate,
          priority: r.task.priority,
          status: r.task.status,
          destination: r.task.destination,
          calendar: r.task.context,
          meeting: meetingTitle({ title: r.transcriptTitle, eventTitle: r.eventTitle, titleHint: r.titleHint, recordedAt: r.recordedAt }),
          meetingId: r.task.transcriptId,
          sentAs: r.task.externalUrl ?? r.task.externalId,
        }))
      );
    })
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a task",
      description: "Edit a task, or approve / dismiss it.",
      inputSchema: {
        task_id: z.string(),
        description: z.string().optional(),
        assignee: z.string().nullable().optional(),
        due_date: z.string().nullable().optional().describe("YYYY-MM-DD"),
        priority: z.enum(PRIORITIES).optional(),
        destination: z.enum(TASK_DESTINATIONS).optional(),
        status: z.enum(["pending", "approved", "dismissed"]).optional(),
      },
    },
    wrap(async ({ task_id, status, due_date, ...rest }) => {
      const id = z.uuid().parse(task_id);
      const patch = Object.fromEntries(Object.entries({ ...rest, dueDate: due_date }).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length) await updateTask(db(), id, patch);
      if (status) await setTaskStatus(db(), [id], status);
      return text("Updated.");
    })
  );

  server.registerTool(
    "push_task",
    {
      title: "Send a task",
      description: "Sends one task to Akiflow or Linear (its own destination unless given) and marks it sent. Only do this when the user asked to send it.",
      inputSchema: { task_id: z.string(), destination: z.enum(TASK_DESTINATIONS).optional() },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    wrap(async ({ task_id, destination }) => {
      const row = await pushTask(db(), z.uuid().parse(task_id), destination);
      return json({ sentTo: row.pushedTo, id: row.externalId, url: row.externalUrl });
    })
  );

  server.registerTool(
    "create_linear_issue",
    {
      title: "Create a Linear issue",
      description:
        "Creates a Linear issue directly, e.g. for dev work discussed in a meeting. Pass transcript_id to link back to the meeting. The team comes from the calendar context unless team_id is given.",
      inputSchema: {
        title: z.string().min(1).max(250),
        description: z.string().max(10000).optional(),
        transcript_id: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        due_date: z.string().optional().describe("YYYY-MM-DD"),
        calendar: z.string().optional().describe("Calendar context, to pick the team"),
        team_id: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    wrap(async ({ title, description, transcript_id, priority, due_date, calendar, team_id }) => {
      if (!integrationStatus().linear) throw new Error("Linear isn't set up on this Debrief (LINEAR_API_KEY).");
      let context = calendar ?? null;
      let body = description ?? "";
      if (transcript_id) {
        const m = await meetingOr404(transcript_id);
        context ??= m.context;
        const url = link(m.transcript.id);
        body += `\n\nFrom ${url ? `[${m.displayTitle}](${url})` : m.displayTitle} on ${m.recording.recordedAt.toISOString().slice(0, 10)}.`;
      }
      const issue = await createLinearIssue({ title, description: body.trim() || null, priority, dueDate: due_date, context, teamId: team_id });
      return json(issue);
    })
  );

  return server;
}

async function authorized(req: http.IncomingMessage) {
  if (NO_AUTH) return true;
  const got = bearer(req.headers.authorization);
  if (!got) return false;
  // Claude sends a bearer token: an API key made in Settings, or the fixed MCP token.
  const token = setting("MCP_TOKEN");
  if (token) {
    const a = crypto.createHash("sha256").update(got).digest();
    const b = crypto.createHash("sha256").update(token).digest();
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return !!(await verifyApiKey(db(), got));
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4_000_000) throw new Error("Request too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

await waitForSchema();

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    await refreshSettings(db());
    if (!(await authorized(req))) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end('{"error":"Missing or wrong bearer token"}');
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no server-sent stream to resume.
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    try {
      const body = await readBody(req);
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
  })
  .listen(PORT, () => console.log(`Debrief MCP server on :${PORT}/mcp`));
