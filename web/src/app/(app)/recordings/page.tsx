import type { Metadata } from "next";
import Link from "next/link";
import { AudioLines, Search, SearchX } from "lucide-react";
import { deviceBadges, listContexts, listMeetings, listQueue, listUnviewed, listUploading } from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { addDays, zonedMidnight } from "@/lib/format";
import { contextColor } from "@/lib/colors";
import { EmptyState, PageHeader } from "@/components/ui";
import { MeetingRow } from "@/components/meeting-row";
import { MeetingList } from "@/components/meeting-list";
import { InProgress } from "@/components/in-progress";
import { AutoRefresh } from "@/components/auto-refresh";

export const metadata: Metadata = { title: "Recordings" };

const PAGE = 30;
const FILTERS = ["q", "attendee", "device", "from", "to"] as const;
type Params = { page?: string; show?: string; unmatched?: string } & Partial<Record<(typeof FILTERS)[number], string>>;
/** Which recordings the list shows: all, not opened yet, opened, or with no calendar event. */
const SHOWS = ["all", "new", "reviewed", "unmatched"] as const;
type Show = (typeof SHOWS)[number];

/** Midnight at the start of a yyyy-mm-dd day in the owner's time zone. */
function day(s: string | undefined) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  return zonedMidnight(...(s.split("-").map(Number) as [number, number, number]));
}

export default async function RecordingsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  // ?unmatched=1 is the old address of "No event".
  const show: Show = sp.unmatched === "1" ? "unmatched" : SHOWS.includes(sp.show as Show) ? (sp.show as Show) : "all";
  const unmatched = show === "unmatched";
  const context = await currentContext();
  const from = day(sp.from);
  const to = day(sp.to);
  const filtering = FILTERS.some((k) => sp[k]?.trim());
  // What isn't transcribed yet shows above the list, on the first page of the plain list.
  const showQueue = page === 1 && !filtering && show === "all";
  const [rows, contexts, badges, queue, uploading, unviewed] = await Promise.all([
    listMeetings(db(), {
      context: unmatched ? "unmatched" : context,
      q: sp.q,
      attendee: sp.attendee,
      device: sp.device || null,
      review: show === "new" || show === "reviewed" ? show : null,
      from,
      to: to && addDays(to, 1),
      limit: PAGE + 1,
      offset: (page - 1) * PAGE,
    }),
    listContexts(db()),
    deviceBadges(db()),
    listQueue(db()),
    listUploading(db()),
    listUnviewed(db(), context, 0),
  ]);
  const more = rows.length > PAGE;
  const list = rows.slice(0, PAGE);
  const kept = Object.fromEntries(FILTERS.filter((k) => sp[k]?.trim()).map((k) => [k, sp[k]!.trim()]));
  const href = (p: number, to: Show = show) => `/recordings?${new URLSearchParams({ ...kept, ...(p > 1 ? { page: String(p) } : {}), ...(to !== "all" ? { show: to } : {}) })}`;
  // Where every recording is at, at a glance; each links to where it's listed.
  const counts = {
    recording: uploading.length,
    queued: queue.filter((q) => q.status === "pending").length,
    transcribing: queue.filter((q) => q.status === "processing").length,
    failed: queue.filter((q) => q.status === "error").length,
    new: unviewed.count,
  };

  return (
    <div>
      <AutoRefresh active={uploading.length > 0 || queue.some((q) => q.status !== "error")} />
      <PageHeader
        title="Recordings"
        description={
          {
            all: context ? `Recordings from ${context}, and those with no event, newest first.` : "Every recording, newest first.",
            new: "Transcribed, and not opened yet.",
            reviewed: "Transcribed and opened.",
            unmatched: "Recordings with no calendar event.",
          }[show]
        }
        actions={
          <div className="flex flex-wrap rounded-xl bg-muted p-0.5 text-xs font-medium">
            {(
              [
                ["all", "All"],
                ["new", "To review"],
                ["reviewed", "Reviewed"],
                ["unmatched", "No event"],
              ] as const
            ).map(([key, label]) => (
              <Link
                key={key}
                href={href(1, key)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${show === key ? "bg-card shadow-surface" : "text-muted-foreground"}`}
              >
                {label}
                {key === "new" && counts.new > 0 && <span className="badge badge-primary px-1.5 py-0 tabular-nums">{counts.new}</span>}
              </Link>
            ))}
          </div>
        }
      />
      <div className="space-y-4 px-4 pb-10 md:px-8">
        <nav aria-label="Where recordings are at" className="flex flex-wrap gap-2 text-xs">
          {(
            [
              ["Recording or uploading", counts.recording, "badge-danger", href(1, "all")],
              ["Queued", counts.queued, "badge-warning", href(1, "all")],
              ["Transcribing", counts.transcribing, "badge-primary", href(1, "all")],
              ["Failed", counts.failed, "badge-danger", href(1, "all")],
              ["To review", counts.new, "badge-success", href(1, "new")],
            ] as const
          ).map(([label, n, cls, to]) => (
            <Link key={label} href={to} className={`badge ${n ? cls : "opacity-60"} gap-1.5 hover:opacity-100`}>
              <span className="font-semibold tabular-nums">{n}</span> {label}
            </Link>
          ))}
        </nav>
        <form action="/recordings" className="card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto_auto_auto]">
          {show !== "all" && <input type="hidden" name="show" value={show} />}
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
              <Link href={show !== "all" ? `/recordings?show=${show}` : "/recordings"} className="btn btn-ghost">
                Clear
              </Link>
            )}
          </div>
        </form>

        {showQueue && (
          <InProgress
            uploading={uploading}
            queue={queue.map((q) => ({
              id: q.id,
              title: q.titleHint,
              device: q.device,
              recordedAt: q.recordedAt,
              status: q.status,
              progress: q.progress,
              error: q.error,
            }))}
            badges={badges}
          />
        )}

        {list.length ? (
          <MeetingList
            items={list.map((m) => ({
              id: m.recordingId,
              title: m.untitled ? "Untitled" : m.displayTitle,
              toReview: !m.viewedAt,
              row: <MeetingRow m={m} color={contextColor(m.context, contexts)} badge={m.device ? badges[m.device] : undefined} />,
            }))}
          />
        ) : filtering ? (
          <EmptyState
            icon={SearchX}
            title="No recordings match"
            body="Try fewer words, part of a name, or a wider date range."
            action={
              <Link href={show !== "all" ? `/recordings?show=${show}` : "/recordings"} className="btn btn-secondary">
                Clear the search
              </Link>
            }
          />
        ) : showQueue && (queue.length || uploading.length) ? null : (
          <EmptyState
            icon={AudioLines}
            title={
              {
                all: "No recordings yet",
                new: "Nothing left to review",
                reviewed: "None opened yet",
                unmatched: "Every recording has its calendar event",
              }[show]
            }
          />
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
