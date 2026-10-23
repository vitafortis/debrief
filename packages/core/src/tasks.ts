import { and, asc, desc, eq, inArray, max, notInArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db";
import { getMeeting } from "./meetings";
import {
  PRIORITIES,
  TASK_DESTINATIONS,
  TASK_STATUSES,
  calendarEvents,
  recordings,
  tasks,
  transcriptEvents,
  transcripts,
  type TaskDestination,
} from "./schema";

/** An action item as Claude (or a person) hands it over. */
export const taskInput = z.object({
  description: z.string().trim().min(1).max(500),
  details: z.string().trim().max(4000).nullish(),
  assignee: z.string().trim().max(200).nullish(),
  dueDate: z.iso.date().nullish(),
  priority: z.enum(PRIORITIES).nullish(),
  destination: z.enum(TASK_DESTINATIONS).nullish(),
  sourceStart: z.number().min(0).nullish(),
});
export type TaskInput = z.infer<typeof taskInput>;

/**
 * Saves extracted action items for a transcript. Items still awaiting review
 * are replaced; ones already approved, pushed or dismissed are kept, so
 * extracting again never duplicates what went to Akiflow or Linear.
 */
export async function saveExtractedTasks(db: Db, transcriptId: string, items: TaskInput[]) {
  const meeting = await getMeeting(db, transcriptId);
  if (!meeting) throw new Error("No such transcript.");
  const parsed = items.map((i) => taskInput.parse(i));
  return db.transaction(async (tx) => {
    await tx.delete(tasks).where(and(eq(tasks.transcriptId, transcriptId), eq(tasks.status, "pending")));
    const [{ n }] = await tx.select({ n: max(tasks.itemNumber) }).from(tasks).where(eq(tasks.transcriptId, transcriptId));
    let next = (n ?? 0) + 1;
    const rows = parsed.length
      ? await tx
          .insert(tasks)
          .values(
            parsed.map((i) => ({
              transcriptId,
              itemNumber: next++,
              description: i.description,
              details: i.details ?? null,
              assignee: i.assignee ?? null,
              dueDate: i.dueDate ?? null,
              priority: i.priority ?? null,
              destination: i.destination ?? meeting.defaultDestination,
              context: meeting.context,
              sourceStart: i.sourceStart ?? null,
            }))
          )
          .returning()
      : [];
    await tx.update(transcripts).set({ tasksExtractedAt: new Date() }).where(eq(transcripts.id, transcriptId));
    return rows;
  });
}

/** Adds one task by hand, after the extracted ones. */
export async function addTask(db: Db, transcriptId: string, input: TaskInput) {
  const meeting = await getMeeting(db, transcriptId);
  if (!meeting) throw new Error("No such transcript.");
  const i = taskInput.parse(input);
  const [{ n }] = await db.select({ n: max(tasks.itemNumber) }).from(tasks).where(eq(tasks.transcriptId, transcriptId));
  const [row] = await db
    .insert(tasks)
    .values({
      transcriptId,
      itemNumber: (n ?? 0) + 1,
      description: i.description,
      details: i.details ?? null,
      assignee: i.assignee ?? null,
      dueDate: i.dueDate ?? null,
      priority: i.priority ?? null,
      destination: i.destination ?? meeting.defaultDestination,
      context: meeting.context,
      sourceStart: i.sourceStart ?? null,
    })
    .returning();
  return row;
}

export const taskPatch = taskInput.partial().extend({ status: z.enum(TASK_STATUSES).optional() });

export async function updateTask(db: Db, id: string, patch: z.infer<typeof taskPatch>) {
  const p = taskPatch.parse(patch);
  const [row] = await db
    .update(tasks)
    .set({ ...p, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return row ?? null;
}

export async function setTaskStatus(db: Db, ids: string[], status: (typeof TASK_STATUSES)[number]) {
  if (!ids.length) return [];
  // Pushed tasks stay pushed: the item exists in Akiflow or Linear.
  return db
    .update(tasks)
    .set({ status, updatedAt: new Date() })
    .where(and(inArray(tasks.id, ids), notInArray(tasks.status, ["pushed"])))
    .returning({ id: tasks.id });
}

export type TaskFilter = { status?: (typeof TASK_STATUSES)[number][]; context?: string | null; transcriptId?: string; limit?: number };

export async function listTasks(db: Db, f: TaskFilter = {}) {
  const where: SQL[] = [];
  if (f.status?.length) where.push(inArray(tasks.status, f.status));
  if (f.context) where.push(eq(tasks.context, f.context));
  if (f.transcriptId) where.push(eq(tasks.transcriptId, f.transcriptId));
  const pe = db
    .selectDistinctOn([transcriptEvents.transcriptId], { transcriptId: transcriptEvents.transcriptId, eventId: transcriptEvents.eventId })
    .from(transcriptEvents)
    .orderBy(transcriptEvents.transcriptId, desc(transcriptEvents.manual), desc(transcriptEvents.confidence))
    .as("pe");
  return db
    .select({
      task: tasks,
      recordedAt: recordings.recordedAt,
      transcriptTitle: transcripts.title,
      titleHint: recordings.titleHint,
      eventTitle: calendarEvents.title,
    })
    .from(tasks)
    .innerJoin(transcripts, eq(transcripts.id, tasks.transcriptId))
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .leftJoin(pe, eq(pe.transcriptId, transcripts.id))
    .leftJoin(calendarEvents, eq(calendarEvents.id, pe.eventId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(recordings.recordedAt), asc(tasks.itemNumber))
    .limit(f.limit ?? 200);
}

// ── Pushing ───────────────────────────────────────────────────────────────

export function integrationStatus() {
  return {
    akiflow: !!process.env.AKIFLOW_WEBHOOK_URL,
    linear: !!process.env.LINEAR_API_KEY,
  };
}

function publicUrl(path: string) {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, "");
  return base ? `${base}${path}` : null;
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: process.env.TZ || undefined });
}

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ || undefined });

/** The JSON sent to the Akiflow webhook (IFTTT / Zapier / Make turn it into a task). */
export function akiflowPayload(
  task: typeof tasks.$inferSelect,
  meeting: { title: string; recordedAt: Date; transcriptId: string }
) {
  const link = publicUrl(`/meetings/${meeting.transcriptId}${task.sourceStart != null ? `?t=${Math.floor(task.sourceStart)}` : ""}`);
  const description = [
    `From ${meeting.title} ${fmtDate(meeting.recordedAt)}${task.details ? ` — ${task.details}` : ""}`,
    task.assignee ? `Owner: ${task.assignee}` : null,
    link,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title: task.description,
    date: today(),
    duration: Number(process.env.AKIFLOW_DEFAULT_DURATION ?? 30),
    priority: task.priority ?? "medium",
    due_date: task.dueDate,
    description,
    context: task.context,
    uniqueIdentifier: `debrief-${meeting.transcriptId}-${task.itemNumber}`,
  };
}

async function pushToAkiflow(payload: ReturnType<typeof akiflowPayload>) {
  const url = process.env.AKIFLOW_WEBHOOK_URL;
  if (!url) throw new Error("Akiflow isn't set up: set AKIFLOW_WEBHOOK_URL.");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The Akiflow webhook answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { externalId: payload.uniqueIdentifier, externalUrl: null };
}

const LINEAR_PRIORITY = { high: 2, medium: 3, low: 4 } as const;

async function linearQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("Linear isn't set up: set LINEAR_API_KEY.");
  const res = await fetch(process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!res.ok || body?.errors?.length || !body?.data) {
    throw new Error(`Linear: ${body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`);
  }
  return body.data;
}

const teamIds = new Map<string, string>();

/** The Linear team for a context: LINEAR_TEAMS="acme:ENG,lumen:LUM", else LINEAR_TEAM. Keys or ids. */
export async function linearTeamFor(context: string | null) {
  const map = Object.fromEntries(
    (process.env.LINEAR_TEAMS ?? "")
      .split(",")
      .map((s) => s.split(":").map((x) => x.trim()))
      .filter((p) => p.length === 2 && p[0] && p[1])
  );
  const team = (context && map[context]) || process.env.LINEAR_TEAM;
  if (!team) throw new Error("No Linear team: set LINEAR_TEAM (a team key like ENG) or LINEAR_TEAMS per context.");
  if (/^[0-9a-f-]{36}$/i.test(team)) return team;
  if (!teamIds.has(team)) {
    const data = await linearQuery<{ teams: { nodes: { id: string }[] } }>(
      `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
      { key: team }
    );
    const id = data.teams.nodes[0]?.id;
    if (!id) throw new Error(`Linear has no team with the key ${team}.`);
    teamIds.set(team, id);
  }
  return teamIds.get(team)!;
}

export async function createLinearIssue(input: {
  title: string;
  description?: string | null;
  priority?: "high" | "medium" | "low" | null;
  dueDate?: string | null;
  context?: string | null;
  teamId?: string | null;
}) {
  const teamId = input.teamId || (await linearTeamFor(input.context ?? null));
  const data = await linearQuery<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } } }>(
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
    {
      input: {
        teamId,
        title: input.title,
        description: input.description ?? undefined,
        priority: input.priority ? LINEAR_PRIORITY[input.priority] : undefined,
        dueDate: input.dueDate ?? undefined,
      },
    }
  );
  if (!data.issueCreate.success) throw new Error("Linear didn't create the issue.");
  return data.issueCreate.issue;
}

/**
 * Sends a task to its destination and records where it went. A task already
 * pushed is not sent again.
 */
export async function pushTask(db: Db, id: string, destination?: TaskDestination) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task) throw new Error("No such task.");
  if (task.status === "pushed") return task;
  const meeting = await getMeeting(db, task.transcriptId);
  if (!meeting) throw new Error("No such transcript.");
  const dest = destination ?? task.destination ?? "akiflow";
  const ref = { title: meeting.displayTitle, recordedAt: meeting.recording.recordedAt, transcriptId: task.transcriptId };
  try {
    let result: { externalId: string; externalUrl: string | null };
    if (dest === "akiflow") {
      result = await pushToAkiflow(akiflowPayload(task, ref));
    } else {
      const link = publicUrl(`/meetings/${task.transcriptId}`);
      const issue = await createLinearIssue({
        title: task.description,
        description: [
          task.details,
          task.assignee ? `**Owner:** ${task.assignee}` : null,
          `From [${ref.title}](${link ?? "#"}) on ${fmtDate(ref.recordedAt)}.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        priority: task.priority,
        dueDate: task.dueDate,
        context: task.context,
      });
      result = { externalId: issue.identifier, externalUrl: issue.url };
    }
    const [row] = await db
      .update(tasks)
      .set({ status: "pushed", pushedTo: dest, destination: dest, ...result, pushError: null, pushedAt: new Date(), updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    return row;
  } catch (err) {
    await db
      .update(tasks)
      .set({ pushError: (err as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(eq(tasks.id, id));
    throw err;
  }
}

/** Pushes every approved task; returns what went and what failed. */
export async function pushApproved(db: Db, ids?: string[]) {
  const where = [eq(tasks.status, "approved")];
  if (ids?.length) where.push(inArray(tasks.id, ids));
  const rows = await db.select({ id: tasks.id }).from(tasks).where(and(...where));
  const out = { pushed: 0, failed: [] as { id: string; error: string }[] };
  for (const r of rows) {
    try {
      await pushTask(db, r.id);
      out.pushed++;
    } catch (err) {
      out.failed.push({ id: r.id, error: (err as Error).message });
    }
  }
  return out;
}

export async function taskCounts(db: Db) {
  const rows = await db
    .select({ status: tasks.status, n: sql<number>`count(*)::int` })
    .from(tasks)
    .groupBy(tasks.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<(typeof TASK_STATUSES)[number], number>>;
}
