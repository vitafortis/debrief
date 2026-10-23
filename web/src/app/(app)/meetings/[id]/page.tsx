import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, gte, lte } from "drizzle-orm";
import { ArrowLeft, Download, Video } from "lucide-react";
import { calendarEvents, extractionAvailable, getMeeting, integrationStatus, listContexts, slackConfigured } from "@debrief/core";
import { db } from "@/lib/db";
import { fmtDateTime, fmtDay, fmtDuration, fmtTime } from "@/lib/format";
import { contextColor } from "@/lib/colors";
import { ContextBadge, StatusBadge } from "@/components/ui";
import { MeetingPlayer } from "@/components/meeting-player";
import { EventPicker, MeetingTasks, RetryButton, SlackButton, SpeakerEditor, SummaryEditor, TitleEditor } from "@/components/meeting-panels";
import { AutoRefresh } from "@/components/auto-refresh";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string; q?: string }> };

const load = async (id: string) => (/^[0-9a-f-]{36}$/i.test(id) ? getMeeting(db(), id) : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const m = await load((await params).id);
  return { title: m?.displayTitle ?? "Meeting" };
}

export default async function MeetingPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const m = await load(id);
  if (!m) notFound();

  const at = m.recording.recordedAt;
  const [candidates, contexts] = await Promise.all([
    db()
      .select({ id: calendarEvents.id, title: calendarEvents.title, startAt: calendarEvents.startAt })
      .from(calendarEvents)
      .where(and(gte(calendarEvents.startAt, new Date(at.getTime() - 12 * 3600_000)), lte(calendarEvents.startAt, new Date(at.getTime() + 12 * 3600_000))))
      .orderBy(asc(calendarEvents.startAt))
      .limit(60),
    listContexts(db()),
  ]);
  const segments = m.transcript.speakerSegments ?? [];
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))] as string[];
  const integrations = integrationStatus();
  const busy = m.recording.status === "pending" || m.recording.status === "processing";

  return (
    <div className="flex min-h-full flex-col">
      <AutoRefresh active={busy} />
      <div className="relative">
        <div className="glow-top pointer-events-none absolute inset-x-0 -top-10 h-64" />
        <header className="relative px-4 pt-5 pb-5 md:px-8 md:pt-6">
          <Link href="/meetings" className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3" /> Meetings
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <TitleEditor transcriptId={m.transcript.id} title={m.displayTitle} custom={m.transcript.title} />
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {fmtDateTime(at)} · {fmtDuration(m.recording.durationSecs)}
                <ContextBadge context={m.context} color={contextColor(m.context, contexts)} />
                {busy && <StatusBadge status={m.recording.status} progress={m.recording.progress} />}
              </p>
            </div>
            <div className="flex gap-2">
              <a href={`/api/meetings/${m.transcript.id}/export?format=md`} className="btn btn-secondary btn-sm">
                <Download /> Markdown
              </a>
              <a href={`/api/meetings/${m.transcript.id}/export?format=txt`} className="btn btn-ghost btn-sm">
                Text
              </a>
              {slackConfigured() && <SlackButton transcriptId={m.transcript.id} sentAt={m.transcript.notifiedAt?.toISOString() ?? null} />}
            </div>
          </div>
        </header>
      </div>

      <div className="grid flex-1 gap-5 px-4 pb-8 md:px-8 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-5 lg:order-1">
          <section className="card space-y-4 p-4">
            {m.event ? (
              <div>
                <p className="text-[0.8125rem] font-medium">{m.event.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {fmtDay(m.event.startAt)}, {fmtTime(m.event.startAt)}–{fmtTime(m.event.endAt)} · {m.event.calendarName}
                </p>
                {m.event.conferenceUrl && (
                  <a href={m.event.conferenceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <Video className="size-3" /> Call link
                  </a>
                )}
              </div>
            ) : null}
            <EventPicker
              transcriptId={m.transcript.id}
              current={m.event?.id ?? null}
              manual={!!m.event?.manual}
              confidence={m.event?.confidence ?? null}
              candidates={candidates.map((c) => ({ id: c.id, title: c.title, when: `${fmtDay(c.startAt)} ${fmtTime(c.startAt)}` }))}
            />
            {m.attendees.length > 0 && (
              <div>
                <p className="label">Attendees</p>
                <ul className="space-y-1">
                  {m.attendees.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-xs">
                      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[0.625rem] font-semibold uppercase">
                        {(a.name ?? a.email).slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={a.email}>
                        {a.name ?? a.email}
                      </span>
                      {a.rsvpStatus && a.rsvpStatus !== "accepted" && <span className="text-[0.625rem] text-muted-foreground">{a.rsvpStatus === "needsAction" ? "no reply" : a.rsvpStatus}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="card p-4">
            <p className="label">Summary</p>
            <SummaryEditor transcriptId={m.transcript.id} summary={m.transcript.summary} />
          </section>

          <MeetingTasks
            transcriptId={m.transcript.id}
            title={m.displayTitle}
            tasks={m.tasks}
            canExtract={extractionAvailable()}
            extractedAt={m.transcript.tasksExtractedAt?.toISOString() ?? null}
            integrations={integrations}
          />

          <section className="card p-4">
            <p className="label">Speakers</p>
            <SpeakerEditor transcriptId={m.transcript.id} speakers={speakers} names={m.transcript.speakerNames} />
          </section>

          <section className="card space-y-1.5 p-4 text-xs text-muted-foreground">
            <p className="label">Recording</p>
            <p className="font-mono text-[0.6875rem] break-all">{m.recording.filePath}</p>
            <p>
              {m.recording.device ? `${m.recording.device} · ` : ""}
              {m.transcript.modelVersion ?? "whisper"} · {m.transcript.language ?? "en"}
            </p>
            {!busy && (
              <div className="pt-2">
                <RetryButton recordingId={m.recording.id} />
              </div>
            )}
          </section>
        </div>

        <div className="lg:sticky lg:top-4 lg:order-2 lg:h-[calc(100dvh-2rem)] lg:self-start">
          <MeetingPlayer
            recordingId={m.recording.id}
            segments={segments}
            speakerNames={m.transcript.speakerNames}
            durationSecs={m.recording.durationSecs}
            waveform={m.recording.waveform}
            initialTime={sp.t ? Number(sp.t) || 0 : undefined}
            initialQuery={sp.q}
          />
        </div>
      </div>
    </div>
  );
}
