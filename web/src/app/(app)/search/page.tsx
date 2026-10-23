import type { Metadata } from "next";
import Link from "next/link";
import { Search as SearchIcon } from "lucide-react";
import { listContexts, searchTranscripts } from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import { contextColor } from "@/lib/colors";
import { ContextBadge, EmptyState, Highlighted, PageHeader } from "@/components/ui";
import { clock, speakerLabel } from "@/lib/time";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; from?: string; to?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 300);
  const context = await currentContext();
  const from = sp.from ? new Date(sp.from) : null;
  const to = sp.to ? new Date(new Date(sp.to).getTime() + 86400_000) : null;
  const [results, contexts] = await Promise.all([
    q ? searchTranscripts(db(), q, { context, from, to, limit: 50 }) : Promise.resolve([]),
    listContexts(db()),
  ]);

  return (
    <div>
      <PageHeader title="Search" description={context ? `In ${context} meetings.` : "Across every transcript."} />
      <div className="space-y-5 px-4 pb-10 md:px-8">
        <form className="card flex flex-wrap items-end gap-3 p-3" role="search">
          <div className="relative min-w-60 flex-1">
            <SearchIcon className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <input
              name="q"
              defaultValue={q}
              className="input pl-9"
              placeholder='API timeline, "launch date", pricing -internal'
              autoFocus={!q}
              aria-label="Search transcripts"
            />
          </div>
          <div>
            <label className="label" htmlFor="from">
              From
            </label>
            <input id="from" name="from" type="date" defaultValue={sp.from} className="input w-auto" />
          </div>
          <div>
            <label className="label" htmlFor="to">
              To
            </label>
            <input id="to" name="to" type="date" defaultValue={sp.to} className="input w-auto" />
          </div>
          <button className="btn btn-primary">Search</button>
        </form>

        {q && (
          <p className="text-xs text-muted-foreground">
            {results.length === 50 ? "The top 50 meetings" : `${results.length} ${results.length === 1 ? "meeting" : "meetings"}`} matching{" "}
            <span className="text-foreground">{q}</span>
          </p>
        )}

        {q && results.length === 0 ? (
          <EmptyState icon={SearchIcon} title="Nothing matched" body="Try fewer words, or another way of saying it. Quotes match an exact phrase." />
        ) : (
          <div className="space-y-3">
            {results.map((r) => (
              <div key={r.transcriptId} className="card overflow-hidden">
                <Link href={`/meetings/${r.transcriptId}?q=${encodeURIComponent(q)}`} className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 hover:bg-accent/40">
                  <div className="min-w-0">
                    <p className="truncate text-[0.875rem] font-semibold tracking-tight">{r.title}</p>
                    <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                      {fmtDateTime(r.recordedAt)} · {fmtDuration(r.durationSecs)}
                      {r.eventTitle && r.eventTitle !== r.title ? ` · ${r.eventTitle}` : ""}
                    </p>
                  </div>
                  <ContextBadge context={r.context} color={contextColor(r.context, contexts)} />
                </Link>
                <ul className="divide-y divide-border">
                  {r.excerpts.map((x, i) => (
                    <li key={i}>
                      <Link
                        href={`/meetings/${r.transcriptId}?q=${encodeURIComponent(q)}${x.start != null ? `&t=${Math.floor(x.start)}` : ""}`}
                        className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 px-4 py-2 hover:bg-accent/40"
                      >
                        <span className="pt-0.5 text-right font-mono text-[0.6875rem] text-muted-foreground tabular-nums">{x.start != null ? clock(x.start) : ""}</span>
                        <span className="text-[0.8125rem] leading-relaxed">
                          {x.speaker && <span className="mr-1.5 text-xs font-semibold text-muted-foreground">{speakerLabel(r.speakerNames, x.speaker)}</span>}
                          <Highlighted text={x.text} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
