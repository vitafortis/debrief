import type { DeviceBadge as Badge, RecordingStatus } from "@debrief/core";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { StatusBadge } from "@/components/ui";
import { DeviceBadge } from "@/components/device-badge";
import { DeleteButton, RetryButton } from "@/components/meeting-panels";

export type Uploading = { id: string; title: string | null; device: string; startedAt: Date; updatedAt: Date };
export type Queued = { id: string; title: string | null; device: string | null; recordedAt: Date; status: RecordingStatus; progress: number | null; error: string | null };

// The recorder sends every 10–20 s while recording; quieter than this, it was cut off or is catching up.
const LIVE_MS = 2 * 60_000;

/** Recordings that aren't transcribed yet: still coming from a recorder, waiting for the transcriber, transcribing, or failed. */
export function InProgress({ uploading, queue, badges, now = new Date() }: { uploading: Uploading[]; queue: Queued[]; badges: Record<string, Badge>; now?: Date }) {
  if (!uploading.length && !queue.length) return null;
  const name = (title: string | null, device: string | null) => title?.trim() || `Recording from ${(device && badges[device]?.label) || device || "a recorder"}`;
  return (
    <section className="card grid gap-0 px-3.5 py-2" aria-label="In progress">
      <h2 className="pt-1 pb-1.5 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">In progress</h2>
      {uploading.map((u) => {
        const live = now.getTime() - u.updatedAt.getTime() < LIVE_MS;
        return (
          <div key={u.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2 text-[0.8125rem]">
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{name(u.title, u.device)}</span>
                <DeviceBadge badge={badges[u.device]} />
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {live ? `Started ${fmtAgo(u.startedAt, now)}` : `Started ${fmtDateTime(u.startedAt)} · last heard from ${fmtAgo(u.updatedAt, now)}. It's transcribed as far as it got if the rest doesn't come.`}
              </span>
            </span>
            <span className={`badge ${live ? "badge-danger" : ""}`}>
              <span className={`size-1.5 rounded-full ${live ? "animate-pulse bg-danger" : "bg-muted-foreground/50"}`} />
              {live ? "Recording" : "Waiting for the rest"}
            </span>
          </div>
        );
      })}
      {queue.map((q) => (
        <div key={q.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2 text-[0.8125rem]">
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{name(q.title, q.device)}</span>
              <DeviceBadge badge={q.device ? badges[q.device] : undefined} />
            </span>
            <span className="block truncate text-xs text-muted-foreground" title={q.error ?? undefined}>
              {fmtDateTime(q.recordedAt)}
              {q.error ? ` · ${q.error}` : ""}
            </span>
            {q.status === "processing" && (
              <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${(q.progress ?? 0) * 100}%` }} />
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5">
            <StatusBadge status={q.status} progress={q.progress} />
            {q.status === "error" && <RetryButton recordingId={q.id} label="Retry" />}
            <DeleteButton recordingId={q.id} title={name(q.title, q.device)} compact />
          </span>
        </div>
      ))}
    </section>
  );
}
