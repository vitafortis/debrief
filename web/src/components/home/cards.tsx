import Link from "next/link";
import { Check, Video } from "lucide-react";
import type { CleanupIssue, DeviceBadge as Badge } from "@debrief/core";
import { fmt, fmtDuration, fmtTime, isoDay } from "@/lib/format";
import { StatusBadge } from "@/components/ui";
import { DeviceBadge } from "@/components/device-badge";

export type SetupStep = { title: string; detail: string; done: boolean; href: string; action: string; optional?: boolean };

/** What's still to set up, and what each piece unlocks. Gone once the required steps are done; optional ones then shrink to a line. */
export function SetupCard({ steps }: { steps: SetupStep[] }) {
  const required = steps.filter((s) => !s.optional);
  const left = steps.filter((s) => !s.done);
  if (!left.length) return null;
  if (required.every((s) => s.done)) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="badge badge-success">
          <Check /> Set up
        </span>
        Optional:
        {left.map((s, i) => (
          <span key={s.title}>
            <Link href={s.href} className="text-foreground underline-offset-2 hover:underline">
              {s.title}
            </Link>
            {i < left.length - 1 ? " ·" : ""}
          </span>
        ))}
      </p>
    );
  }
  const done = steps.filter((s) => s.done).length;
  return (
    <section className="card grid gap-2.5 border-warning/45 bg-[color-mix(in_oklch,var(--warning)_5%,var(--card))] p-3" aria-label="Setup">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Finish setting up Debrief</h2>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex gap-0.5" aria-hidden>
            {steps.map((s) => (
              <i key={s.title} className={`h-1.5 w-5 rounded-full ${s.done ? "bg-success" : "bg-border"}`} />
            ))}
          </span>
          {done} of {steps.length}
        </span>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-1.5">
        {steps.map((s) => (
          <li key={s.title} className={`flex items-start gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-xs ${s.done ? "opacity-60" : ""}`}>
            <span
              className={`mt-px grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] ${s.done ? "border-success bg-success text-card" : s.optional ? "border-border" : "border-warning"}`}
            >
              {s.done && <Check className="size-2.5" strokeWidth={3} />}
            </span>
            <span className="min-w-0 flex-1">
              {s.optional && <span className="block text-[0.625rem] tracking-wide text-muted-foreground uppercase">Optional</span>}
              <b className="block font-semibold">{s.title}</b>
              <span className="text-[0.6875rem] text-muted-foreground">{s.detail}</span>
            </span>
            {!s.done && (
              <Link href={s.href} className={`btn btn-sm ${s.optional ? "btn-secondary" : "btn-primary"}`}>
                {s.action}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Queued = { id: string; title: string; status: "pending" | "processing" | "error"; progress: number | null; error: string | null; when: string };
type Ready = { id: string; title: string; untitled: boolean; badge?: Badge; when: string };

/** What's transcribing and what's ready that hasn't been opened. */
export function TranscriptionsCard({ queue, ready, readyCount }: { queue: Queued[]; ready: Ready[]; readyCount: number }) {
  const busy = queue.filter((q) => q.status !== "error").length;
  return (
    <section className="card grid gap-1 px-3.5 py-3" aria-label="Transcriptions">
      <div className="flex items-baseline justify-between gap-2 pb-1">
        <h2 className="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">Transcriptions</h2>
        <span className="flex gap-3.5 text-xs text-muted-foreground">
          <span>
            <b className="text-foreground tabular-nums">{busy}</b> in progress
          </span>
          <span>
            <b className="text-foreground tabular-nums">{readyCount}</b> ready to view
          </span>
        </span>
      </div>
      {queue.map((q) => (
        <div key={q.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-1.5 text-[0.8125rem]">
          <span className="min-w-0">
            <span className="block truncate font-medium">{q.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {q.when}
              {q.error ? ` · ${q.error}` : ""}
            </span>
            {q.status === "processing" && (
              <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${(q.progress ?? 0) * 100}%` }} />
              </span>
            )}
          </span>
          <StatusBadge status={q.status} progress={q.progress} />
        </div>
      ))}
      {ready.map((r) => (
        <Link key={r.id} href={`/recordings/${r.id}`} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-1.5 text-[0.8125rem]">
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className={`truncate font-medium group-hover:text-primary ${r.untitled ? "text-muted-foreground italic" : ""}`}>{r.untitled ? "Untitled" : r.title}</span>
              <DeviceBadge badge={r.badge} />
            </span>
            <span className="block truncate text-xs text-muted-foreground">{r.when}</span>
          </span>
          <span className="btn btn-primary btn-sm">Open</span>
        </Link>
      ))}
      {readyCount > ready.length && (
        <Link href="/recordings" className="border-t border-border pt-1.5 text-xs text-muted-foreground hover:text-foreground">
          {readyCount - ready.length} more ready →
        </Link>
      )}
      {!queue.length && !ready.length && <p className="text-xs text-muted-foreground">Nothing waiting. New recordings show here as they transcribe.</p>}
    </section>
  );
}

type Upcoming = { id: string; title: string; startAt: Date; color: string; conferenceUrl: string | null };

/** The next few meetings, the first with how soon it starts and a link to join. */
export function ComingUp({ events, calendarConnected, now }: { events: Upcoming[]; calendarConnected: boolean; now: Date }) {
  const today = isoDay(now);
  const tomorrow = isoDay(new Date(now.getTime() + 86400_000));
  const when = (d: Date) => {
    const mins = Math.round((d.getTime() - now.getTime()) / 60000);
    if (mins < 60) return `In ${Math.max(mins, 1)} min`;
    const day = isoDay(d) === today ? "Today" : isoDay(d) === tomorrow ? "Tomorrow" : fmt({ weekday: "short", month: "short", day: "numeric" }).format(d);
    return `${day}, ${fmtTime(d)}`;
  };
  return (
    <section className="card flex flex-1 flex-col gap-2 p-3" aria-label="Coming up">
      <h2 className="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">Coming up</h2>
      {!calendarConnected ? (
        <div className="grid flex-1 place-content-center justify-items-center gap-2 rounded-lg border border-dashed border-warning/50 px-2 py-4 text-center text-xs text-muted-foreground">
          <span>Connect a calendar and your next meetings show here, with how soon they start.</span>
          <Link href="/settings/calendars" className="btn btn-primary btn-sm">
            Connect
          </Link>
        </div>
      ) : events.length ? (
        <ul className="grid gap-0.5">
          {events.map((e, i) => (
            <li key={e.id} className={`grid grid-cols-[3px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-xs ${i === 0 ? "bg-primary-soft" : ""}`}>
              <span className="self-stretch rounded-full" style={{ background: e.color }} />
              <span className="min-w-0">
                <b className="block truncate font-semibold">{e.title}</b>
                <span className="text-[0.6875rem] text-muted-foreground tabular-nums">{when(e.startAt)}</span>
              </span>
              {e.conferenceUrl && (
                <a href={e.conferenceUrl} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm" aria-label={`Join ${e.title}`}>
                  <Video />
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing in the next two weeks.</p>
      )}
    </section>
  );
}

type CleanupRow = {
  id: string;
  title: string;
  untitled: boolean;
  recordedAt: Date;
  durationSecs: number | null;
  badge?: Badge;
  issues: CleanupIssue[];
  pendingTasks: number;
};

const ISSUE: Record<CleanupIssue, string> = {
  empty: "Empty recording",
  untitled: "No title",
  "no-event": "No calendar event",
  speakers: "Speakers not named",
  "no-summary": "No summary or tasks",
  tasks: "Tasks to review",
};

/** The fix to offer first, and where it is. */
function action(r: CleanupRow, canSummarize: boolean): { label: string; href: string } {
  const page = `/recordings/${r.id}`;
  const first = r.issues[0];
  if (first === "untitled") return { label: "Name it", href: page };
  if (first === "no-event") return { label: "Link event", href: page };
  if (first === "speakers") return { label: "Name speakers", href: page };
  if (first === "no-summary" && canSummarize) return { label: "Summarize", href: page };
  if (first === "tasks") return { label: "Review tasks", href: "/tasks" };
  return { label: "Open", href: page };
}

/** Every recent transcript that still needs something, with what's missing and the fix. */
export function CleanupList({ rows, canSummarize }: { rows: CleanupRow[]; canSummarize: boolean }) {
  const blocked = !canSummarize && rows.some((r) => r.issues.includes("no-summary"));
  return (
    <section className="card overflow-hidden" aria-label="Needs cleanup">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Needs cleanup {rows.length > 0 && <span className="badge badge-warning">{rows.length}</span>}
        </h2>
        <span className="text-xs text-muted-foreground">Newest first</span>
      </div>
      {rows.length ? (
        <ul className="divide-y divide-border">
          {rows.map((r) => {
            const a = action(r, canSummarize);
            return (
              <li key={r.id} className="grid items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 text-[0.8125rem] sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]">
                <span className="font-mono text-xs text-muted-foreground">
                  {fmt({ month: "short", day: "numeric" }).format(r.recordedAt)} {fmtTime(r.recordedAt)}
                </span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <Link href={`/recordings/${r.id}`} className={`truncate font-semibold hover:text-primary ${r.untitled ? "text-muted-foreground italic" : ""}`}>
                      {r.untitled ? "Untitled" : r.title}
                    </Link>
                    <DeviceBadge badge={r.badge} />
                    <span className="shrink-0 text-xs text-muted-foreground">{fmtDuration(r.durationSecs)}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {r.issues.map((i) => (
                      <span key={i} className={`badge ${i === "empty" ? "badge-danger" : "badge-warning"}`}>
                        {i === "tasks" ? `${r.pendingTasks} ${r.pendingTasks === 1 ? "task" : "tasks"} to review` : ISSUE[i]}
                      </span>
                    ))}
                  </span>
                </span>
                <Link href={a.href} className="btn btn-primary btn-sm justify-self-start sm:justify-self-end">
                  {a.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-3.5 py-6 text-center text-xs text-muted-foreground">Every transcript is named, linked and summarized.</p>
      )}
      {blocked && (
        <p className="border-t border-border bg-warning/5 px-3.5 py-2 text-xs text-warning">
          Summaries and tasks need an AI provider.{" "}
          <Link href="/settings/ai" className="underline underline-offset-2">
            Connect one in Settings → AI summaries
          </Link>
          .
        </p>
      )}
    </section>
  );
}
