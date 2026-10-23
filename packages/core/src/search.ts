import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { meetingTitle } from "./meetings";

/** Highlight markers ts_headline puts around matched words; the UI turns them into <mark>. */
export const HL_START = "\u0002";
export const HL_END = "\u0003";

export type SearchOptions = {
  context?: string | null;
  from?: Date | null;
  to?: Date | null;
  limit?: number;
  /** Matching lines to show per meeting. */
  excerpts?: number;
};

export type SearchResult = {
  transcriptId: string;
  title: string;
  recordedAt: Date;
  durationSecs: number | null;
  eventTitle: string | null;
  context: string | null;
  rank: number;
  speakerNames: Record<string, string>;
  excerpts: { speaker: string | null; start: number | null; text: string }[];
};

/**
 * Full-text search over transcripts (web-search syntax: "exact phrase",
 * -exclude, or). Each hit carries the matching lines with their speaker and
 * time, matched words wrapped in HL_START / HL_END.
 */
export async function searchTranscripts(db: Db, query: string, o: SearchOptions = {}): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(o.limit ?? 25, 100);
  const excerpts = o.excerpts ?? 3;
  const opts = `StartSel=${HL_START}, StopSel=${HL_END}, MaxWords=40, MinWords=12, ShortWord=2, MaxFragments=1, FragmentDelimiter=" … "`;
  // A speaker turn is short: show all of it.
  const segOpts = `StartSel=${HL_START}, StopSel=${HL_END}, HighlightAll=true`;

  const res = await db.execute<{
    id: string;
    title: string | null;
    title_hint: string | null;
    recorded_at: string;
    duration_secs: number | null;
    event_title: string | null;
    context: string | null;
    rank: number;
    speaker_names: Record<string, string> | null;
    excerpts: { speaker: string | null; start: number | null; text: string }[] | null;
    fallback: string;
  }>(sql`
    with q as (select websearch_to_tsquery('english', ${q}) as query),
    pe as (
      select distinct on (te.transcript_id) te.transcript_id, te.event_id
      from transcript_events te
      order by te.transcript_id, te.manual desc, te.confidence desc
    ),
    hits as (
      select t.id, t.title, t.speaker_names, t.speaker_segments, t.content, r.title_hint, r.recorded_at, r.duration_secs,
             e.title as event_title, coalesce(c.context, d.context) as context, ts_rank_cd(t.search_vector, q.query) as rank
      from transcripts t
      cross join q
      join recordings r on r.id = t.recording_id
      left join pe on pe.transcript_id = t.id
      left join calendar_events e on e.id = pe.event_id
      left join calendars c on c.id = e.calendar_id
      left join devices d on d.name = r.device
      where t.search_vector @@ q.query
        and (${o.context ?? null}::text is null or coalesce(c.context, d.context) = ${o.context ?? null})
        and (${o.from?.toISOString() ?? null}::timestamptz is null or r.recorded_at >= ${o.from?.toISOString() ?? null})
        and (${o.to?.toISOString() ?? null}::timestamptz is null or r.recorded_at < ${o.to?.toISOString() ?? null})
      order by rank desc, r.recorded_at desc
      limit ${limit}
    )
    select h.id, h.title, h.speaker_names, h.title_hint, h.recorded_at, h.duration_secs, h.event_title, h.context, h.rank,
      (
        select jsonb_agg(x order by x.start) from (
          select seg->>'speaker' as speaker, (seg->>'start')::float as start,
                 ts_headline('english', seg->>'text', q.query, ${segOpts}) as text
          from jsonb_array_elements(coalesce(h.speaker_segments, '[]'::jsonb)) seg
          where to_tsvector('english', seg->>'text') @@ q.query
          order by (seg->>'start')::float
          limit ${excerpts}
        ) x
      ) as excerpts,
      ts_headline('english', h.content, q.query, ${opts}) as fallback
    from hits h cross join q
    order by h.rank desc, h.recorded_at desc
  `);

  return res.rows.map((r) => {
    const recordedAt = new Date(r.recorded_at);
    return {
      transcriptId: r.id,
      title: meetingTitle({ title: r.title, eventTitle: r.event_title, titleHint: r.title_hint, recordedAt }),
      recordedAt,
      durationSecs: r.duration_secs,
      eventTitle: r.event_title,
      context: r.context,
      rank: Number(r.rank),
      speakerNames: r.speaker_names ?? {},
      // A match only in the title or summary has no matching line: show the best passage instead.
      excerpts: r.excerpts?.length ? r.excerpts : [{ speaker: null, start: null, text: r.fallback }],
    };
  });
}

/** Splits highlighted text into plain and matched runs. */
export function highlightRuns(text: string) {
  const runs: { text: string; match: boolean }[] = [];
  const re = new RegExp(`${HL_START}([^${HL_END}]*)${HL_END}`, "g");
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), match: false });
    runs.push({ text: m[1], match: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), match: false });
  return runs;
}
