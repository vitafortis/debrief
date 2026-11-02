import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { fmt, isoDay } from "@/lib/format";
import { TimeWindow } from "./time-window";

/** One thing on the home calendar: a calendar event (recorded or not) or a recording with no event. */
export type CalItem = {
  key: string;
  day: string; // YYYY-MM-DD in the owner's zone
  start: number; // minutes since midnight
  end: number;
  title: string;
  untitled: boolean;
  color: string;
  kind: "recorded" | "busy" | "failed" | "upcoming" | "missed";
  href: string | null;
  cleanup: boolean;
  time: string;
};

const HOUR_PX = 40;

const SUB: Record<CalItem["kind"], string> = { recorded: "", busy: "transcribing", failed: "failed", upcoming: "", missed: "not recorded" };

function Block({ item, compact }: { item: CalItem; compact: boolean }) {
  const top = (item.start / 60) * HOUR_PX;
  const height = Math.max(((item.end - item.start) / 60) * HOUR_PX - 2, 16);
  const look = {
    recorded: "border-l-[3px] bg-[color-mix(in_oklch,var(--c)_18%,var(--card))]",
    busy: "border-l-[3px] border-l-primary bg-[repeating-linear-gradient(135deg,var(--primary-soft)_0_6px,transparent_6px_12px)]",
    failed: "border-l-[3px] border-l-danger bg-danger/10",
    upcoming: "border border-dashed border-[color-mix(in_oklch,var(--c)_60%,var(--border))] border-l-[3px] border-l-(--c)",
    missed: "border border-border border-l-[3px] opacity-70",
  }[item.kind];
  const body = (
    <>
      {item.cleanup && <span title="Needs cleanup" className="absolute top-1 right-1 size-1.5 rounded-full bg-warning" />}
      <span className={`block truncate font-semibold ${item.kind === "missed" ? "text-muted-foreground line-through" : ""} ${item.untitled ? "italic" : ""} ${compact ? "hidden @lg:block" : ""}`}>
        {item.title}
      </span>
      {height > 26 && (
        <span className={`block truncate text-[0.625rem] text-muted-foreground ${compact ? "hidden @lg:block" : ""}`}>
          {item.time}
          {SUB[item.kind] && ` · ${SUB[item.kind]}`}
        </span>
      )}
    </>
  );
  const cls = `absolute inset-x-0.5 overflow-hidden rounded-md px-1.5 py-0.5 text-[0.6875rem] leading-tight ${look} border-l-(--c)`;
  const style = { top, height, "--c": item.color } as React.CSSProperties;
  return item.href ? (
    <Link href={item.href} className={`${cls} hover:ring-1 hover:ring-primary/50`} style={style} title={`${item.title}, ${item.time}`}>
      {body}
    </Link>
  ) : (
    <div className={cls} style={style} title={`${item.title}, ${item.time}`}>
      {body}
    </div>
  );
}

export function CalendarPanel({
  view,
  days,
  items,
  today,
  nowMinutes,
  work,
  link,
  prev,
  next,
  calendarConnected,
}: {
  view: "day" | "week";
  days: Date[];
  items: CalItem[];
  today: string;
  nowMinutes: number;
  work: { from: number; to: number };
  link: (o: { view?: "day" | "week"; date?: Date }) => string;
  prev: Date;
  next: Date;
  calendarConnected: boolean;
}) {
  const keys = days.map(isoDay);
  const shown = items.filter((i) => keys.includes(i.day));
  const before = shown.filter((i) => i.end <= work.from * 60);
  const after = shown.filter((i) => i.start >= work.to * 60);
  const off = (list: CalItem[], pick: (hours: number[]) => number) => (list.length ? { count: list.length, hour: pick(list.map((i) => i.start / 60)) } : null);
  const md = fmt({ month: "short", day: "numeric" });
  const title =
    view === "day"
      ? keys[0] === today
        ? `Today · ${fmt({ weekday: "short", month: "short", day: "numeric" }).format(days[0])}`
        : fmt({ weekday: "long", month: "short", day: "numeric" }).format(days[0])
      : `${md.format(days[0])} – ${md.format(days[6])}`;
  const cols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
  const seg = (on: boolean) => `rounded-lg px-3 py-1 ${on ? "bg-card shadow-surface" : "text-muted-foreground"}`;

  return (
    <section className="card @container flex min-w-0 flex-col gap-3 p-3" aria-label="Calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-1">
          <Link href={link({ date: prev })} className="btn btn-secondary btn-sm btn-icon" aria-label={view === "day" ? "Previous day" : "Previous week"}>
            <ChevronLeft />
          </Link>
          <Link href={link({ date: new Date() })} className="btn btn-secondary btn-sm">
            Today
          </Link>
          <Link href={link({ date: next })} className="btn btn-secondary btn-sm btn-icon" aria-label={view === "day" ? "Next day" : "Next week"}>
            <ChevronRight />
          </Link>
          <div className="ml-1.5 flex rounded-xl bg-muted p-0.5 text-xs font-medium">
            <Link href={link({ view: "day" })} className={seg(view === "day")} aria-current={view === "day" ? "page" : undefined}>
              Day
            </Link>
            <Link href={link({ view: "week" })} className={seg(view === "week")} aria-current={view === "week" ? "page" : undefined}>
              Week
            </Link>
          </div>
        </div>
      </div>

      {!calendarConnected && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-warning/50 px-3 py-2 text-xs text-muted-foreground">
          <span>Only recordings show here. Connect a calendar to see upcoming meetings and give recordings their names.</span>
          <Link href="/settings/calendars" className="btn btn-primary btn-sm">
            Connect
          </Link>
        </div>
      )}

      <div>
        <div className="grid grid-cols-[2.75rem_minmax(0,1fr)]">
          <span />
          <div className="grid" style={cols}>
            {days.map((d, i) => (
              <div key={keys[i]} className="pb-1.5 text-center text-[0.625rem] tracking-wide text-muted-foreground uppercase">
                {fmt({ weekday: "short" }).format(d)}
                <b className={`block text-[0.8125rem] tracking-normal ${keys[i] === today ? "text-primary" : "text-foreground"}`}>{fmt({ day: "numeric" }).format(d)}</b>
              </div>
            ))}
          </div>
        </div>
        <TimeWindow from={work.from} to={work.to} hourPx={HOUR_PX} earlier={off(before, (h) => Math.min(...h))} later={off(after, (h) => Math.min(...h))}>
          <div className="grid grid-cols-[2.75rem_minmax(0,1fr)]">
            <div>
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className="block -translate-y-[0.45em] pr-2 text-right font-mono text-[0.625rem] text-muted-foreground" style={{ height: HOUR_PX }}>
                  {h ? `${h % 12 || 12}${h < 12 ? "a" : "p"}` : ""}
                </span>
              ))}
            </div>
            <div className="grid border-l border-border" style={cols}>
              {keys.map((k) => (
                <div
                  key={k}
                  className={`relative border-r border-border ${k === today && view === "week" ? "bg-primary/[0.03]" : ""}`}
                  style={{ height: 24 * HOUR_PX, backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${HOUR_PX}px)` }}
                >
                  <div className="pointer-events-none absolute inset-x-0 top-0 bg-muted/50" style={{ height: work.from * HOUR_PX }} />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-muted/50" style={{ height: (24 - work.to) * HOUR_PX }} />
                  {shown
                    .filter((i) => i.day === k)
                    .map((i) => (
                      <Block key={i.key} item={i} compact={view === "week"} />
                    ))}
                  {k === today && (
                    <div className="absolute inset-x-0 z-[1] border-t-2 border-danger" style={{ top: (nowMinutes / 60) * HOUR_PX }}>
                      <span className="absolute -top-[5px] -left-1 size-2 rounded-full bg-danger" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </TimeWindow>
      </div>

      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <i className="h-2 w-3.5 rounded-sm border-l-[3px] border-l-primary bg-primary/20" />
          Recorded
        </span>
        <span className="flex items-center gap-1.5">
          <i className="h-2 w-3.5 rounded-sm border border-dashed border-primary" />
          Upcoming
        </span>
        <span className="flex items-center gap-1.5">
          <i className="h-2 w-3.5 rounded-sm border-l-[3px] border-l-primary bg-[repeating-linear-gradient(135deg,var(--primary-soft)_0_3px,transparent_3px_6px)]" />
          Transcribing
        </span>
        {calendarConnected && (
          <span className="flex items-center gap-1.5">
            <i className="h-2 w-3.5 rounded-sm border border-border" />
            Not recorded
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <i className="size-1.5 rounded-full bg-warning" />
          Needs cleanup
        </span>
        <Link href="/settings" className="ml-auto hover:text-foreground">
          Working hours {hourLabel(work.from)}–{hourLabel(work.to)}
        </Link>
      </div>
    </section>
  );
}

const hourLabel = (h: number) => (h % 24 === 0 ? "12 AM" : `${h % 12 || 12} ${h < 12 || h === 24 ? "AM" : "PM"}`);
