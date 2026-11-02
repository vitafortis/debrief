import type { Metadata } from "next";
import Link from "next/link";
import { AudioLines, Search, SearchX } from "lucide-react";
import { deviceBadges, listContexts, listMeetings } from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { addDays, zonedMidnight } from "@/lib/format";
import { contextColor } from "@/lib/colors";
import { EmptyState, PageHeader } from "@/components/ui";
import { MeetingRow } from "@/components/meeting-row";

export const metadata: Metadata = { title: "Meetings" };

const PAGE = 30;
const FILTERS = ["q", "attendee", "device", "from", "to"] as const;
type Params = { page?: string; unmatched?: string } & Partial<Record<(typeof FILTERS)[number], string>>;

/** Midnight at the start of a yyyy-mm-dd day in the owner's time zone. */
function day(s: string | undefined) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  return zonedMidnight(...(s.split("-").map(Number) as [number, number, number]));
}

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const unmatched = sp.unmatched === "1";
  const context = await currentContext();
  const from = day(sp.from);
  const to = day(sp.to);
  const filtering = FILTERS.some((k) => sp[k]?.trim());
  const [rows, contexts, badges] = await Promise.all([
    listMeetings(db(), {
      context: unmatched ? "unmatched" : context,
      q: sp.q,
      attendee: sp.attendee,
      device: sp.device || null,
      from,
      to: to && addDays(to, 1),
      limit: PAGE + 1,
      offset: (page - 1) * PAGE,
    }),
    listContexts(db()),
    deviceBadges(db()),
  ]);
  const more = rows.length > PAGE;
  const list = rows.slice(0, PAGE);
  const kept = Object.fromEntries(FILTERS.filter((k) => sp[k]?.trim()).map((k) => [k, sp[k]!.trim()]));
  const href = (p: number, only?: boolean) =>
    `/meetings?${new URLSearchParams({ ...kept, ...(p > 1 ? { page: String(p) } : {}), ...((only ?? unmatched) ? { unmatched: "1" } : {}) })}`;

  return (
    <div>
      <PageHeader
        title="Meetings"
        description={unmatched ? "Transcripts with no calendar event." : context ? `Transcripts from ${context} calendars.` : "Every transcript, newest first."}
        actions={
          <div className="flex rounded-xl bg-muted p-0.5 text-xs font-medium">
            <Link href={href(1, false)} className={`rounded-lg px-3 py-1.5 ${!unmatched ? "bg-card shadow-surface" : "text-muted-foreground"}`}>
              All
            </Link>
            <Link href={href(1, true)} className={`rounded-lg px-3 py-1.5 ${unmatched ? "bg-card shadow-surface" : "text-muted-foreground"}`}>
              No event
            </Link>
          </div>
        }
      />
      <div className="space-y-4 px-4 pb-10 md:px-8">
        <form action="/meetings" className="card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto_auto_auto]">
          {unmatched && <input type="hidden" name="unmatched" value="1" />}
          <label className="relative sm:col-span-2 lg:col-span-1">
            <span className="sr-only">Title or words said</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input id="q" name="q" className="input pl-9" placeholder="Title or words said" defaultValue={sp.q} />
          </label>
          <label>
            <span className="sr-only">Attendee</span>
            <input id="attendee" name="attendee" className="input" placeholder="Attendee name or email" defaultValue={sp.attendee} />
          </label>
          <label>
            <span className="sr-only">Device</span>
            <select id="device" name="device" className="input" defaultValue={sp.device ?? ""}>
              <option value="">Any device</option>
              {Object.entries(badges).map(([name, b]) => (
                <option key={name} value={name}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            From
            <input id="from" name="from" type="date" className="input" defaultValue={sp.from} />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            To
            <input id="to" name="to" type="date" className="input" defaultValue={sp.to} />
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1 lg:flex-none">Search</button>
            {filtering && (
              <Link href={unmatched ? "/meetings?unmatched=1" : "/meetings"} className="btn btn-ghost">
                Clear
              </Link>
            )}
          </div>
        </form>

        {list.length ? (
          <div className="grid gap-2">
            {list.map((m) => (
              <MeetingRow key={m.id} m={m} color={contextColor(m.context, contexts)} badge={m.device ? badges[m.device] : undefined} />
            ))}
          </div>
        ) : filtering ? (
          <EmptyState
            icon={SearchX}
            title="No meetings match"
            body="Try fewer words, part of a name, or a wider date range."
            action={
              <Link href={unmatched ? "/meetings?unmatched=1" : "/meetings"} className="btn btn-secondary">
                Clear the search
              </Link>
            }
          />
        ) : (
          <EmptyState icon={AudioLines} title={unmatched ? "Every transcript has its meeting" : "No transcripts yet"} />
        )}
        {(page > 1 || more) && (
          <div className="flex justify-between">
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
