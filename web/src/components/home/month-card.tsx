import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { fmt, isoDay } from "@/lib/format";

export type DayMarks = { recorded?: boolean; upcoming?: boolean; cleanup?: boolean };

/** The month at a glance: what was recorded, what's coming and what needs cleanup, each day a link into the calendar. */
export function MonthCard({
  month,
  cells,
  marks,
  today,
  selected,
  highlight,
  dayLink,
  prevMonth,
  nextMonth,
  recorded,
  upcoming,
  calendarConnected,
}: {
  month: Date;
  cells: Date[];
  marks: Record<string, DayMarks>;
  today: string;
  selected: string;
  highlight: Set<string>;
  dayLink: (d: Date) => string;
  prevMonth: string;
  nextMonth: string;
  recorded: number;
  upcoming: number;
  calendarConnected: boolean;
}) {
  const mm = isoDay(month).slice(0, 7);
  return (
    <section className="card flex flex-col gap-2 p-3" aria-label="Month">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{fmt({ month: "long", year: "numeric" }).format(month)}</h2>
        <div className="flex gap-1">
          <Link href={prevMonth} className="btn btn-secondary btn-sm btn-icon" aria-label="Previous month">
            <ChevronLeft />
          </Link>
          <Link href={nextMonth} className="btn btn-secondary btn-sm btn-icon" aria-label="Next month">
            <ChevronRight />
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i} className="pb-0.5 text-[0.625rem] text-muted-foreground">
            {d}
          </span>
        ))}
        {cells.map((d) => {
          const k = isoDay(d);
          const m = marks[k] ?? {};
          return (
            <Link
              key={k}
              href={dayLink(d)}
              aria-label={fmt({ weekday: "long", month: "long", day: "numeric" }).format(d)}
              aria-current={k === selected ? "date" : undefined}
              className={`grid justify-items-center gap-0.5 rounded-md pt-1 pb-1.5 text-xs tabular-nums hover:bg-accent ${k.slice(0, 7) !== mm ? "text-muted-foreground/50" : ""} ${highlight.has(k) ? "bg-muted" : ""} ${k === selected ? "ring-[1.5px] ring-primary ring-inset" : ""}`}
            >
              <span className={k === today ? "grid size-5 place-items-center rounded-full bg-primary font-semibold text-primary-foreground" : ""}>{Number(k.slice(8))}</span>
              <span className="flex h-1.5 gap-0.5">
                {m.recorded && <i className="size-1.5 rounded-full bg-success" />}
                {m.upcoming && <i className="size-1.5 rounded-full border border-primary" />}
                {m.cleanup && <i className="size-1.5 rounded-full bg-warning" />}
              </span>
            </Link>
          );
        })}
      </div>
      <div className="space-y-1 border-t border-border pt-2 text-[0.6875rem] text-muted-foreground">
        <p>
          <b className="text-foreground tabular-nums">{recorded}</b> recorded this month
          {calendarConnected && (
            <>
              {" "}
              · <b className="text-foreground tabular-nums">{upcoming}</b> coming up
            </>
          )}
        </p>
        <p className="flex flex-wrap gap-x-2.5">
          <span className="flex items-center gap-1">
            <i className="size-1.5 rounded-full bg-success" /> recorded
          </span>
          {calendarConnected && (
            <span className="flex items-center gap-1">
              <i className="size-1.5 rounded-full border border-primary" /> upcoming
            </span>
          )}
          <span className="flex items-center gap-1">
            <i className="size-1.5 rounded-full bg-warning" /> cleanup
          </span>
        </p>
      </div>
    </section>
  );
}
