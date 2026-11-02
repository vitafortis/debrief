import { eq } from "drizzle-orm";
import {
  calendars,
  deviceBadges,
  extractionAvailable,
  integrationStatus,
  listCleanup,
  listContexts,
  listEventsWithStatus,
  listMeetings,
  listQueue,
  listUnviewed,
  recordings,
  setting,
  settingNumber,
  slackConfigured,
} from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { addDays, fmtAgo, fmtDateTime, fmtDay, fmtTime, isoDay, minutesOfDay, startOfDay, zonedMidnight } from "@/lib/format";
import { contextColor } from "@/lib/colors";
import { PageHeader } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { DEVICE_SWATCH } from "@/components/device-badge";
import { CalendarPanel, type CalItem } from "@/components/home/calendar-panel";
import { MonthCard, type DayMarks } from "@/components/home/month-card";
import { CleanupList, ComingUp, SetupCard, TranscriptionsCard, type SetupStep } from "@/components/home/cards";

type Params = { date?: string; view?: string; month?: string };

/** A YYYY-MM-DD from the address as midnight in the owner's zone. */
function day(s: string | undefined) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return zonedMidnight(...(s.split("-").map(Number) as [number, number, number]));
}
/** Monday = 0. */
const weekday = (d: Date) => (new Date(`${isoDay(d)}T12:00:00Z`).getUTCDay() + 6) % 7;
const clampHour = (n: number, lo: number, hi: number, fallback: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback);

export default async function Home({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const d = db();
  const context = await currentContext();
  const now = new Date();
  const today = startOfDay(now);
  const view = sp.view === "day" ? "day" : "week";
  const selected = day(sp.date) ?? today;
  const month = day(sp.month ? `${sp.month}-01` : undefined) ?? day(`${isoDay(selected).slice(0, 7)}-01`)!;

  // The days on screen, and the six weeks of the month card around them.
  const weekStart = addDays(selected, -weekday(selected));
  const days = view === "day" ? [selected] : Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const gridStart = addDays(month, -weekday(month));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const monthKey = isoDay(month).slice(0, 7);
  const grid = cells.slice(35).every((c) => isoDay(c).slice(0, 7) !== monthKey) ? cells.slice(0, 35) : cells;
  const from = new Date(Math.min(grid[0].getTime(), days[0].getTime()));
  const to = addDays(new Date(Math.max(grid.at(-1)!.getTime(), days.at(-1)!.getTime())), 1);

  const start = clampHour(settingNumber("WORK_DAY_START"), 0, 23, 8);
  const work = { from: start, to: clampHour(settingNumber("WORK_DAY_END"), start + 1, 24, 18) };

  const [events, meetings, upcoming, queue, unviewed, cleanup, contexts, badges, enabledCalendars, [anyRecording]] = await Promise.all([
    listEventsWithStatus(d, from, to, context),
    listMeetings(d, { context, from, to, limit: 1000 }),
    listEventsWithStatus(d, now, addDays(today, 15), context),
    listQueue(d),
    listUnviewed(d, context),
    listCleanup(d, context),
    listContexts(d),
    deviceBadges(d),
    d.select({ id: calendars.id }).from(calendars).where(eq(calendars.enabled, true)).limit(1),
    d.select({ id: recordings.id }).from(recordings).limit(1),
  ]);
  const calendarConnected = enabledCalendars.length > 0;
  const cleanupIds = new Set(cleanup.map((c) => c.id));
  const badge = (device: string | null) => (device ? badges[device] : undefined);

  // Everything on the calendar: events by their state, and recordings that never matched one.
  const items: CalItem[] = [
    ...events
      .filter((e) => !e.allDay)
      .map((e): CalItem => {
        const k = isoDay(e.startAt);
        const kind = e.status === "done" ? "recorded" : e.status === "error" ? "failed" : e.status === "none" ? (e.endAt < now ? "missed" : "upcoming") : "busy";
        return {
          key: e.id,
          day: k,
          start: minutesOfDay(e.startAt),
          end: isoDay(e.endAt) === k ? minutesOfDay(e.endAt) : 24 * 60,
          title: e.title,
          untitled: false,
          color: contextColor(e.context, contexts),
          kind,
          href: e.transcriptId ? `/meetings/${e.transcriptId}` : null,
          cleanup: !!e.transcriptId && cleanupIds.has(e.transcriptId),
          time: fmtTime(e.startAt),
        };
      }),
    ...meetings
      .filter((m) => !m.eventId)
      .map((m): CalItem => {
        const b = badge(m.device);
        const s = minutesOfDay(m.recordedAt);
        return {
          key: m.id,
          day: isoDay(m.recordedAt),
          start: s,
          end: Math.min(24 * 60, s + Math.max(15, Math.round((m.durationSecs ?? 0) / 60))),
          title: m.untitled ? `Untitled${b ? ` · ${b.label}` : ""}` : m.displayTitle,
          untitled: m.untitled,
          color: b ? DEVICE_SWATCH[b.color] : contextColor(m.context, contexts),
          kind: "recorded",
          href: `/meetings/${m.id}`,
          cleanup: cleanupIds.has(m.id),
          time: fmtTime(m.recordedAt),
        };
      }),
  ];

  const marks: Record<string, DayMarks> = {};
  for (const i of items) {
    const m = (marks[i.day] ??= {});
    if (i.kind === "recorded" || i.kind === "busy") m.recorded = true;
    if (i.kind === "upcoming") m.upcoming = true;
    if (i.cleanup) m.cleanup = true;
  }
  const inMonth = items.filter((i) => i.day.startsWith(monthKey));

  const link = (o: { view?: "day" | "week"; date?: Date; month?: Date }) => {
    const q = new URLSearchParams();
    const v = o.view ?? view;
    const dt = o.date ?? selected;
    if (v !== "week") q.set("view", v);
    if (isoDay(dt) !== isoDay(today)) q.set("date", isoDay(dt));
    if (o.month) q.set("month", isoDay(o.month).slice(0, 7));
    const s = q.toString();
    return s ? `/?${s}` : "/";
  };
  const step = view === "day" ? 1 : 7;
  const shiftMonth = (n: number) => {
    const [y, m] = monthKey.split("-").map(Number);
    return zonedMidnight(y, m + n, 1);
  };

  const steps: SetupStep[] = [
    { title: "Install the recorder", detail: "Records your calls and uploads them.", done: !!anyRecording, href: "/settings/devices#recorder", action: "Get it" },
    { title: "Connect a calendar", detail: "Names your meetings and shows what's coming up.", done: calendarConnected, href: "/settings/calendars", action: "Connect" },
    { title: "Add a Claude API key", detail: "Writes summaries and finds the action items.", done: extractionAvailable(), href: "/settings/claude", action: "Add key" },
    { title: "Speaker labels", detail: "Tells apart the people on a call.", done: !!setting("HF_TOKEN"), href: "/settings/transcription", action: "Set up", optional: true },
    {
      title: "Slack, Akiflow or Linear",
      detail: "Where summaries and tasks are sent.",
      done: slackConfigured() || integrationStatus().akiflow || integrationStatus().linear,
      href: "/settings/integrations",
      action: "Set up",
      optional: true,
    },
  ];

  const busy = queue.some((q) => q.status !== "error");
  return (
    <div>
      <AutoRefresh active={busy} />
      <PageHeader title="Today" description={fmtDay(now)} />
      <div className="@container space-y-4 px-4 pb-10 md:px-8">
        <SetupCard steps={steps} />
        <TranscriptionsCard
          queue={queue.map((q) => ({
            id: q.id,
            title: q.titleHint || (q.device ? `Recording from ${badge(q.device)?.label ?? q.device}` : "Recording"),
            status: q.status as "pending" | "processing" | "error",
            progress: q.progress,
            error: q.error,
            when: fmtAgo(q.recordedAt),
          }))}
          ready={unviewed.items.map((m) => ({ id: m.id, title: m.displayTitle, untitled: m.untitled, badge: badge(m.device), when: fmtDateTime(m.recordedAt) }))}
          readyCount={unviewed.count}
        />
        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_15rem]">
          <CalendarPanel
            view={view}
            days={days}
            items={items}
            today={isoDay(today)}
            nowMinutes={minutesOfDay(now)}
            work={work}
            link={link}
            prev={addDays(selected, -step)}
            next={addDays(selected, step)}
            calendarConnected={calendarConnected}
          />
          <div className="contents @3xl:flex @3xl:flex-col @3xl:gap-4">
            <div className="-order-1 @3xl:order-none">
              <MonthCard
                month={month}
                cells={grid}
                marks={marks}
                today={isoDay(today)}
                selected={isoDay(selected)}
                highlight={new Set(days.map(isoDay))}
                dayLink={(dt) => link({ date: dt })}
                prevMonth={link({ month: shiftMonth(-1) })}
                nextMonth={link({ month: shiftMonth(1) })}
                recorded={inMonth.filter((i) => i.kind === "recorded").length}
                upcoming={inMonth.filter((i) => i.kind === "upcoming").length}
                calendarConnected={calendarConnected}
              />
            </div>
            <div className="order-1 flex @3xl:order-none @3xl:flex-1">
              <ComingUp
                now={now}
                calendarConnected={calendarConnected}
                events={upcoming
                  .filter((e) => !e.allDay && e.startAt > now && e.status === "none")
                  .slice(0, 5)
                  .map((e) => ({ id: e.id, title: e.title, startAt: e.startAt, color: contextColor(e.context, contexts), conferenceUrl: e.conferenceUrl }))}
              />
            </div>
          </div>
        </div>
        <CleanupList
          canSummarize={extractionAvailable()}
          rows={cleanup.map((c) => ({
            id: c.id,
            title: c.displayTitle,
            untitled: c.untitled,
            recordedAt: c.recordedAt,
            durationSecs: c.durationSecs,
            badge: badge(c.device),
            issues: c.issues,
            pendingTasks: c.pendingTasks,
          }))}
        />
      </div>
    </div>
  );
}
