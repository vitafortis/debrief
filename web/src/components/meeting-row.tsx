import Link from "next/link";
import { ChevronRight, Users } from "lucide-react";
import type { DeviceBadge as Badge, MeetingSummary } from "@debrief/core";
import { fmt, fmtDuration, fmtTime } from "@/lib/format";
import { ContextBadge, Highlighted } from "@/components/ui";
import { DeviceBadge } from "@/components/device-badge";

const weekday = (d: Date) => fmt({ weekday: "short" }).format(d);
const dayNum = (d: Date) => fmt({ day: "numeric" }).format(d);
const month = (d: Date) => fmt({ month: "short" }).format(d);

/** One meeting as a card: the date, what it was, who and how long, and where its words matched a search. */
export function MeetingRow({ m, color, badge }: { m: MeetingSummary; color: string; badge?: Badge }) {
  return (
    <Link
      href={`/recordings/${m.id}`}
      className="card group flex items-center gap-4 p-3 pr-4 transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-surface-lg focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="flex w-12 shrink-0 flex-col items-center rounded-lg bg-muted py-1.5 leading-none" aria-hidden>
        <span className="text-[0.625rem] font-medium tracking-wider text-muted-foreground uppercase">{weekday(m.recordedAt)}</span>
        <span className="mt-1 text-lg font-semibold tabular-nums">{dayNum(m.recordedAt)}</span>
        <span className="mt-0.5 text-[0.625rem] text-muted-foreground">{month(m.recordedAt)}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {/* With no event or name, the date beside it already says when: "Untitled" and the device say the rest. */}
          <span className={`truncate text-[0.9375rem] font-semibold tracking-tight group-hover:text-primary ${m.untitled ? "text-muted-foreground italic" : ""}`}>
            {m.untitled ? "Untitled" : m.displayTitle}
          </span>
          <DeviceBadge badge={badge} />
          {!m.eventId && !m.untitled && <span className="badge shrink-0">No event</span>}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {fmtTime(m.recordedAt)} · {fmtDuration(m.durationSecs)}
          </span>
          {m.attendeeCount > 0 && (
            <span className="flex items-center gap-1">
              <Users className="size-3" />
              {m.attendeeCount}
            </span>
          )}
        </span>
        {m.excerpt ? (
          <span className="mt-1.5 line-clamp-2 text-[0.8125rem] text-muted-foreground">
            <Highlighted text={m.excerpt} />
          </span>
        ) : (
          m.summary && <span className="mt-1.5 line-clamp-1 text-[0.8125rem] text-muted-foreground">{m.summary}</span>
        )}
      </span>
      <span className="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
        <ContextBadge context={m.context} color={color} />
        {m.openTasks > 0 && <span className="badge badge-primary">{m.openTasks} tasks</span>}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 group-hover:text-primary" />
    </Link>
  );
}
