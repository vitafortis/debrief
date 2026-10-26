import Link from "next/link";
import { ArrowRight, AudioLines, CalendarDays, Clock, ListChecks, MessagesSquare, Video } from "lucide-react";
import { listContexts, listEventsWithStatus, listMeetings, listQueue, listTasks } from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { addDays, fmtAgo, fmtDay, fmtDuration, fmtTime, startOfDay } from "@/lib/format";
import { contextColor } from "@/lib/colors";
import { ContextBadge, EmptyState, PageHeader, Stat, StatusBadge, StatusDot } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { fmtDue } from "@/lib/due";

export default async function Dashboard() {
  const d = db();
  const context = await currentContext();
  const today = startOfDay(new Date());
  const weekAgo = addDays(today, -6);
  const [events, recent, week, queue, pending, contexts] = await Promise.all([
    listEventsWithStatus(d, today, addDays(today, 1), context),
    listMeetings(d, { context, limit: 6 }),
    listMeetings(d, { context, from: weekAgo, limit: 500 }),
    listQueue(d),
    listTasks(d, { status: ["pending"], context, limit: 6 }),
    listContexts(d),
  ]);
  const pendingCount = (await listTasks(d, { status: ["pending"], context, limit: 1000 })).length;
  const secs = week.reduce((s, m) => s + (m.durationSecs ?? 0), 0);
  const busy = queue.filter((q) => q.status !== "error");
  const timed = events.filter((e) => !e.allDay);

  return (
    <div>
      <AutoRefresh active={busy.length > 0} />
      <PageHeader
        title="Today"
        description={`${fmtDay(new Date())}${context ? ` · ${context}` : ""}`}
        actions={
          <Link href="/search" className="btn btn-secondary">
            Search transcripts
          </Link>
        }
      />
      <div className="space-y-6 px-4 pb-10 md:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Meetings this week" value={week.length} icon={MessagesSquare} hint="last 7 days" />
          <Stat label="Recorded" value={fmtDuration(secs)} icon={Clock} hint="last 7 days" />
          <Stat label="Tasks to review" value={pendingCount} icon={ListChecks} hint={pendingCount ? "waiting for approval" : "all caught up"} />
          <Stat
            label="Transcribing"
            value={busy.length}
            icon={AudioLines}
            hint={queue.some((q) => q.status === "error") ? `${queue.filter((q) => q.status === "error").length} failed` : "in the queue"}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <section className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <CalendarDays className="size-4 text-muted-foreground" />
                Today&apos;s meetings
              </h2>
              <Link href="/calendar" className="text-xs text-muted-foreground hover:text-foreground">
                Calendar →
              </Link>
            </div>
            {timed.length ? (
              <ul className="divide-y divide-border">
                {timed.map((e) => {
                  const body = (
                    <>
                      <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{fmtTime(e.startAt)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.8125rem] font-medium">{e.title}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
                          {fmtTime(e.startAt)}–{fmtTime(e.endAt)}
                          {e.conferenceUrl && <Video className="size-3" />}
                        </span>
                      </span>
                      <ContextBadge context={e.context} color={contextColor(e.context, contexts)} />
                      <StatusBadge status={e.status} />
                    </>
                  );
                  return (
                    <li key={e.id}>
                      {e.transcriptId ? (
                        <Link href={`/meetings/${e.transcriptId}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50">
                          {body}
                        </Link>
                      ) : (
                        <div className="flex items-center gap-3 px-4 py-3">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-[0.8125rem] text-muted-foreground">Nothing on the calendar today.</p>
            )}
          </section>

          <section className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ListChecks className="size-4 text-muted-foreground" />
                To review
              </h2>
              <Link href="/tasks" className="text-xs text-muted-foreground hover:text-foreground">
                All tasks →
              </Link>
            </div>
            {pending.length ? (
              <ul className="divide-y divide-border">
                {pending.map(({ task, eventTitle, transcriptTitle, titleHint }) => (
                  <li key={task.id} className="px-4 py-2.5">
                    <p className="text-[0.8125rem] leading-snug">{task.description}</p>
                    <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
                      {transcriptTitle || eventTitle || titleHint || "Meeting"}
                      {task.assignee ? ` · ${task.assignee}` : ""}
                      {task.dueDate ? ` · due ${fmtDue(task.dueDate)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-[0.8125rem] text-muted-foreground">No tasks waiting.</p>
            )}
          </section>
        </div>

        {queue.length > 0 && (
          <section className="card overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <AudioLines className="size-4 text-muted-foreground" />
                Transcription queue
              </h2>
            </div>
            <ul className="divide-y divide-border">
              {queue.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <StatusDot status={r.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.8125rem]">{r.titleHint || r.filePath}</span>
                    <span className="block truncate text-[0.6875rem] text-muted-foreground">
                      {fmtAgo(r.recordedAt)}
                      {r.device ? ` · ${r.device}` : ""}
                      {r.error ? ` · ${r.error}` : ""}
                    </span>
                    {r.status === "processing" && (
                      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${(r.progress ?? 0) * 100}%` }} />
                      </span>
                    )}
                  </span>
                  <StatusBadge status={r.status} progress={r.progress} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent transcripts</h2>
            <Link href="/meetings" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              All meetings <ArrowRight className="size-3" />
            </Link>
          </div>
          {recent.length ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {recent.map((m) => (
                <Link key={m.id} href={`/meetings/${m.id}`} className="card group flex flex-col p-4 transition-shadow hover:shadow-surface-lg">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="line-clamp-1 text-[0.9375rem] font-semibold tracking-tight group-hover:text-primary">{m.displayTitle}</h3>
                    <ContextBadge context={m.context} color={contextColor(m.context, contexts)} />
                  </div>
                  <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                    {fmtAgo(m.recordedAt)} · {fmtDuration(m.durationSecs)}
                    {m.attendeeCount ? ` · ${m.attendeeCount} people` : ""}
                  </p>
                  {m.summary && <p className="mt-2 line-clamp-2 text-[0.8125rem] text-muted-foreground">{m.summary}</p>}
                  {m.openTasks > 0 && <p className="mt-auto pt-3 text-[0.6875rem] text-primary">{m.openTasks} open tasks</p>}
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={AudioLines}
              title="No transcripts yet"
              body="Install the Debrief Recorder on your Mac or PC and give it an API key. It records your calls and sends them here, and each one shows up a minute or two after you hang up."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Link href="/settings/devices" className="btn btn-primary">
                    Create an API key
                  </Link>
                  <Link href="/settings/devices#recorder" className="btn btn-secondary">
                    Get the recorder
                  </Link>
                </div>
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}
