import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { listContexts, listEventsWithStatus, type EventStatus } from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { addDays, fmt, fmtTime, isoDay, minutesOfDay, startOfDay, zonedMidnight } from "@/lib/format";
import { contextColor } from "@/lib/colors";
import { EmptyState, PageHeader, StatusDot } from "@/components/ui";

export const metadata: Metadata = { title: "Calendar" };

const HOUR = 44; // px per hour
const weekdayFmt = { format: (d: Date) => fmt({ weekday: "short" }).format(d) };
const dayNumFmt = { format: (d: Date) => fmt({ day: "numeric" }).format(d) };
const rangeFmt = { format: (d: Date) => fmt({ month: "long", year: "numeric" }).format(d) };

type Ev = Awaited<ReturnType<typeof listEventsWithStatus>>[number];

/** Side-by-side lanes for overlapping events in one day. */
function lanes(events: Ev[]) {
  const placed: { e: Ev; lane: number; lanes: number }[] = [];
  let cluster: typeof placed = [];
  let clusterEnd = 0;
  const flush = () => {
    const n = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) c.lanes = n;
    cluster = [];
  };
  for (const e of [...events].sort((a, b) => a.startAt.getTime() - b.startAt.getTime())) {
    if (e.startAt.getTime() >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.e.endAt > e.startAt).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    const p = { e, lane, lanes: 1 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, e.endAt.getTime());
  }
  flush();
  return placed;
}

const STATUS_LABEL: Record<EventStatus, string> = {
  none: "No recording",
  pending: "Queued",
  processing: "Transcribing",
  done: "Transcript ready",
  error: "Transcription failed",
};

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string }> }) {
  const sp = await searchParams;
  const view = sp.view === "day" ? "day" : "week";
  const context = await currentContext();
  const anchor = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? zonedMidnight(...(sp.date.split("-").map(Number) as [number, number, number])) : startOfDay(new Date());
  // Weeks start on Monday.
  const weekday = (new Date(`${isoDay(anchor)}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = view === "week" ? addDays(anchor, -weekday) : anchor;
  const days = Array.from({ length: view === "week" ? 7 : 1 }, (_, i) => addDays(start, i));
  const end = addDays(start, days.length);
  const [events, contexts] = await Promise.all([listEventsWithStatus(db(), start, end, context), listContexts(db())]);

  const timed = events.filter((e) => !e.allDay);
  const allDay = events.filter((e) => e.allDay);
  const mins = timed.flatMap((e) => [minutesOfDay(e.startAt), Math.min(24 * 60, minutesOfDay(e.endAt) || 24 * 60)]);
  const first = Math.max(0, Math.min(8, ...mins.map((m) => Math.floor(m / 60))));
  const last = Math.min(24, Math.max(18, ...mins.map((m) => Math.ceil(m / 60))));
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const today = isoDay(new Date());
  const step = view === "week" ? 7 : 1;
  const link = (d: Date, v = view) => `/calendar?${new URLSearchParams({ view: v, date: isoDay(d) })}`;

  return (
    <div>
      <PageHeader
        title="Calendar"
        description={`${rangeFmt.format(start)}${context ? ` · ${context}` : ""}`}
        actions={
          <>
            <div className="flex rounded-xl bg-muted p-0.5 text-xs font-medium">
              {(["day", "week"] as const).map((v) => (
                <Link key={v} href={link(anchor, v)} className={`rounded-lg px-3 py-1.5 capitalize ${view === v ? "bg-card shadow-surface" : "text-muted-foreground"}`}>
                  {v}
                </Link>
              ))}
            </div>
            <Link href={link(addDays(start, -step))} className="btn btn-secondary btn-icon btn-sm" aria-label="Previous">
              <ChevronLeft />
            </Link>
            <Link href={`/calendar?view=${view}`} className="btn btn-secondary btn-sm">
              Today
            </Link>
            <Link href={link(addDays(start, step))} className="btn btn-secondary btn-icon btn-sm" aria-label="Next">
              <ChevronRight />
            </Link>
          </>
        }
      />
      <div className="px-4 pb-10 md:px-8">
        {events.length === 0 && contexts.length === 0 ? (
          <EmptyState icon={CalendarDays} title="No calendars yet" body="Add a Google calendar or an ICS feed in Settings, and meetings appear here." />
        ) : (
          <div className="card overflow-x-auto">
            <div className="min-w-[44rem]" style={view === "day" ? { minWidth: 0 } : undefined}>
              <div className="grid border-b border-border" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
                <div />
                {days.map((d) => {
                  const isToday = isoDay(d) === today;
                  return (
                    <Link key={d.toISOString()} href={link(d, "day")} className="border-l border-border px-2 py-2 text-center hover:bg-accent/40">
                      <span className="block text-[0.6875rem] text-muted-foreground uppercase">{weekdayFmt.format(d)}</span>
                      <span className={`mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-sm font-semibold ${isToday ? "bg-primary-soft text-primary" : ""}`}>
                        {dayNumFmt.format(d)}
                      </span>
                    </Link>
                  );
                })}
              </div>
              {allDay.length > 0 && (
                <div className="grid border-b border-border" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
                  <div className="px-1 py-1.5 text-right text-[0.625rem] text-muted-foreground">all day</div>
                  {days.map((d) => (
                    <div key={d.toISOString()} className="space-y-0.5 border-l border-border p-1">
                      {allDay
                        .filter((e) => e.startAt < addDays(d, 1) && e.endAt > d)
                        .map((e) => (
                          <p key={e.id} className="truncate rounded px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground" style={{ background: `color-mix(in oklch, ${contextColor(e.context, contexts)} 14%, transparent)` }}>
                            {e.title}
                          </p>
                        ))}
                    </div>
                  ))}
                </div>
              )}
              <div className="relative grid" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
                <div>
                  {hours.map((h) => (
                    <div key={h} className="relative pr-2 text-right font-mono text-[0.625rem] text-muted-foreground" style={{ height: HOUR }}>
                      <span className="relative -top-1.5">{h === 0 ? "" : `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`}</span>
                    </div>
                  ))}
                </div>
                {days.map((d) => {
                  const dayEvents = timed.filter((e) => e.startAt < addDays(d, 1) && e.endAt > d);
                  const isToday = isoDay(d) === today;
                  const nowMin = minutesOfDay(new Date());
                  return (
                    <div key={d.toISOString()} className="relative border-l border-border">
                      {hours.map((h) => (
                        <div key={h} className="border-t border-border/60" style={{ height: HOUR }} />
                      ))}
                      {isToday && nowMin >= first * 60 && nowMin <= last * 60 && (
                        <div className="pointer-events-none absolute inset-x-0 z-10 h-px bg-danger" style={{ top: ((nowMin - first * 60) / 60) * HOUR }}>
                          <span className="absolute -top-1 -left-1 size-2 rounded-full bg-danger" />
                        </div>
                      )}
                      {lanes(dayEvents).map(({ e, lane, lanes: n }) => {
                        const s = e.startAt < d ? first * 60 : minutesOfDay(e.startAt);
                        const en = e.endAt > addDays(d, 1) ? last * 60 : minutesOfDay(e.endAt) || 24 * 60;
                        const top = ((Math.max(s, first * 60) - first * 60) / 60) * HOUR;
                        const height = Math.max(18, ((Math.min(en, last * 60) - Math.max(s, first * 60)) / 60) * HOUR - 2);
                        const color = contextColor(e.context, contexts);
                        const cls =
                          "absolute overflow-hidden rounded-md border-l-2 px-1.5 py-1 text-left text-[0.6875rem] leading-tight transition-shadow hover:shadow-surface-lg";
                        const style = {
                          top,
                          height,
                          left: `calc(${(lane / n) * 100}% + 2px)`,
                          width: `calc(${100 / n}% - 4px)`,
                          borderLeftColor: color,
                          background: `color-mix(in oklch, ${color} ${e.status === "done" ? 18 : 10}%, var(--card))`,
                        };
                        const inner = (
                          <>
                            <span className="flex items-center gap-1 font-medium">
                              <StatusDot status={e.status} />
                              <span className="truncate">{e.title}</span>
                            </span>
                            {height > 30 && (
                              <span className="block truncate text-muted-foreground">
                                {fmtTime(e.startAt)} · {STATUS_LABEL[e.status]}
                              </span>
                            )}
                          </>
                        );
                        return e.transcriptId ? (
                          <Link key={e.id} href={`/meetings/${e.transcriptId}`} className={cls} style={style} title={`${e.title} — ${STATUS_LABEL[e.status]}`}>
                            {inner}
                          </Link>
                        ) : (
                          <div key={e.id} className={`${cls} cursor-default opacity-90`} style={style} title={`${e.title} — ${STATUS_LABEL[e.status]}`}>
                            {inner}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[0.6875rem] text-muted-foreground">
          {(["done", "processing", "pending", "error", "none"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <StatusDot status={s} />
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
