import type { Metadata } from "next";
import Link from "next/link";
import { AudioLines, Users } from "lucide-react";
import { listContexts, listMeetings } from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import { contextColor } from "@/lib/colors";
import { ContextBadge, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Meetings" };

const PAGE = 30;

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ page?: string; unmatched?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const unmatched = sp.unmatched === "1";
  const context = await currentContext();
  const [rows, contexts] = await Promise.all([
    listMeetings(db(), { context: unmatched ? "unmatched" : context, limit: PAGE + 1, offset: (page - 1) * PAGE }),
    listContexts(db()),
  ]);
  const more = rows.length > PAGE;
  const list = rows.slice(0, PAGE);
  const href = (p: number) => `/meetings?${new URLSearchParams({ ...(p > 1 ? { page: String(p) } : {}), ...(unmatched ? { unmatched: "1" } : {}) })}`;

  return (
    <div>
      <PageHeader
        title="Meetings"
        description={unmatched ? "Transcripts with no calendar event." : context ? `Transcripts from ${context} calendars.` : "Every transcript, newest first."}
        actions={
          <div className="flex rounded-xl bg-muted p-0.5 text-xs font-medium">
            <Link href="/meetings" className={`rounded-lg px-3 py-1.5 ${!unmatched ? "bg-card shadow-surface" : "text-muted-foreground"}`}>
              All
            </Link>
            <Link href="/meetings?unmatched=1" className={`rounded-lg px-3 py-1.5 ${unmatched ? "bg-card shadow-surface" : "text-muted-foreground"}`}>
              No event
            </Link>
          </div>
        }
      />
      <div className="px-4 pb-10 md:px-8">
        {list.length ? (
          <div className="card divide-y divide-border overflow-hidden">
            {list.map((m) => (
              <Link key={m.id} href={`/meetings/${m.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-accent/50">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.8125rem] font-medium">{m.displayTitle}</p>
                  <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
                    {fmtDateTime(m.recordedAt)} · {fmtDuration(m.durationSecs)}
                    {m.device ? ` · ${m.device}` : ""}
                    {m.summary ? ` · ${m.summary}` : ""}
                  </p>
                </div>
                {m.attendeeCount > 0 && (
                  <span className="hidden items-center gap-1 text-[0.6875rem] text-muted-foreground sm:flex">
                    <Users className="size-3" />
                    {m.attendeeCount}
                  </span>
                )}
                {m.openTasks > 0 && <span className="badge badge-primary">{m.openTasks} tasks</span>}
                {m.eventId ? (
                  <ContextBadge context={m.context} color={contextColor(m.context, contexts)} />
                ) : (
                  <span className="badge">No event</span>
                )}
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState icon={AudioLines} title={unmatched ? "Every transcript has its meeting" : "No transcripts yet"} />
        )}
        {(page > 1 || more) && (
          <div className="mt-4 flex justify-between">
            {page > 1 ? (
              <Link href={href(page - 1)} className="btn btn-secondary btn-sm">
                Newer
              </Link>
            ) : (
              <span />
            )}
            {more && (
              <Link href={href(page + 1)} className="btn btn-secondary btn-sm">
                Older
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
