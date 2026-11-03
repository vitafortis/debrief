"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Pencil, Plus, RotateCcw, Send, Sparkles, Trash2 } from "lucide-react";
import { deleteMeeting, extractTasks, renameMeeting, renameSpeakers, retranscribe, saveSummary, sendToSlack, setMeetingEvent } from "@/actions/meetings";
import { addTaskToMeeting } from "@/actions/tasks";
import { TaskItem, useAction, type TaskView } from "@/components/task-item";
import { speakerLabel } from "@/lib/time";

export function TitleEditor({ transcriptId, title, custom }: { transcriptId: string; title: string; custom: string | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(custom ?? title);
  const [pending, go] = useAction();
  if (!editing)
    return (
      <button className="group flex items-start gap-2 text-left" onClick={() => setEditing(true)} title="Rename">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <Pencil className="mt-2.5 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
      </button>
    );
  return (
    <form
      className="flex w-full max-w-xl items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        go(() => renameMeeting(transcriptId, value), () => setEditing(false));
      }}
    >
      <input className="input h-10 text-lg font-semibold" value={value} onChange={(e) => setValue(e.target.value)} autoFocus placeholder="Use the calendar event's title" />
      <button className="btn btn-primary" disabled={pending}>
        Save
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

type Candidate = { id: string; title: string; when: string };

/** Which calendar event this meeting is, matched by time or chosen by hand. */
export function EventPicker({
  transcriptId,
  current,
  manual,
  confidence,
  candidates,
}: {
  transcriptId: string;
  current: string | null;
  manual: boolean;
  confidence: number | null;
  candidates: Candidate[];
}) {
  const [pending, go] = useAction();
  return (
    <div>
      <label className="label" htmlFor="event-pick">
        Calendar event
      </label>
      <select
        id="event-pick"
        className="input h-8 text-xs"
        value={current ?? ""}
        disabled={pending}
        onChange={(e) => go(() => setMeetingEvent(transcriptId, e.target.value || null))}
      >
        <option value="">{current ? "Match automatically" : "None — match automatically"}</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.when} · {c.title}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[0.6875rem] text-muted-foreground">
        {current
          ? manual
            ? "Chosen by hand."
            : `Matched by time (${Math.round((confidence ?? 0) * 100)}% overlap).`
          : "No event overlapped this recording enough to match."}
      </p>
    </div>
  );
}

export function SpeakerEditor({ transcriptId, speakers, names }: { transcriptId: string; speakers: string[]; names: Record<string, string> }) {
  const [draft, setDraft] = useState(names);
  const [pending, go] = useAction();
  if (!speakers.length) return <p className="text-xs text-muted-foreground">Speaker labels are off for this recording (set HF_TOKEN on the transcriber).</p>;
  const dirty = speakers.some((s) => (draft[s] ?? "") !== (names[s] ?? ""));
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        go(() => renameSpeakers(transcriptId, draft));
      }}
    >
      {speakers.map((s) => (
        <div key={s} className="flex items-center gap-2">
          <span className="w-20 shrink-0 truncate font-mono text-[0.6875rem] text-muted-foreground">{speakerLabel({}, s)}</span>
          <input
            className="input h-8 text-xs"
            placeholder="Name"
            value={draft[s] ?? ""}
            onChange={(e) => setDraft({ ...draft, [s]: e.target.value })}
            aria-label={`Name for ${speakerLabel({}, s)}`}
          />
        </div>
      ))}
      {dirty && (
        <button className="btn btn-secondary btn-sm" disabled={pending}>
          <Check /> Save names
        </button>
      )}
    </form>
  );
}

export function SummaryEditor({ transcriptId, summary }: { transcriptId: string; summary: string | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(summary ?? "");
  const [pending, go] = useAction();
  if (!editing)
    return summary ? (
      <button className="group max-h-48 w-full overflow-y-auto text-left text-[0.8125rem] leading-relaxed text-muted-foreground hover:text-foreground" onClick={() => setEditing(true)}>
        {summary}
      </button>
    ) : (
      <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setEditing(true)}>
        + Write a summary
      </button>
    );
  return (
    <div className="space-y-2">
      <textarea className="input h-auto min-h-28 py-2 text-[0.8125rem]" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" disabled={pending} onClick={() => go(() => saveSummary(transcriptId, value), () => setEditing(false))}>
          Save
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function RetryButton({ recordingId, label = "Transcribe again", ghost }: { recordingId: string; label?: string; ghost?: boolean }) {
  const [pending, go] = useAction();
  return (
    <button className={`btn btn-sm ${ghost ? "btn-ghost" : "btn-secondary"}`} disabled={pending} onClick={() => go(() => retranscribe(recordingId))}>
      <RotateCcw /> {label}
    </button>
  );
}

/** Deletes the recording, its transcript, notes, action items and audio, after asking; `then` is where to go next. */
export function DeleteButton({ recordingId, title, then, compact }: { recordingId: string; title: string; then?: string; compact?: boolean }) {
  const [pending, go] = useAction();
  const router = useRouter();
  return (
    <button
      type="button"
      className={`btn btn-sm ${compact ? "btn-ghost" : "btn-danger-outline"}`}
      disabled={pending}
      aria-label={`Delete ${title}`}
      title="Delete"
      onClick={() =>
        confirm(`Delete "${title}"?\n\nThe transcript, summary, action items and audio are deleted everywhere Debrief keeps them (the server, the NAS folder or S3, and exports). This can't be undone.`) &&
        go(
          () => deleteMeeting(recordingId),
          () => then && router.replace(then)
        )
      }
    >
      <Trash2 />
      {!compact && " Delete"}
    </button>
  );
}

/** This meeting's action items, with extraction by the AI provider and adding by hand. */
export function MeetingTasks({
  transcriptId,
  title,
  tasks,
  canExtract,
  extractedAt,
  integrations,
}: {
  transcriptId: string;
  title: string;
  tasks: TaskView[];
  canExtract: boolean;
  extractedAt: string | null;
  integrations: { akiflow: boolean; linear: boolean };
}) {
  const [pending, go] = useAction();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const prompt = `Extract the action items from my Debrief meeting "${title}" and save them.`;
  return (
    <section id="tasks" className="card scroll-mt-4 overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          Action items{tasks.length > 0 && <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{tasks.length}</span>}
        </h2>
        <div className="flex gap-1.5">
          <button className="btn btn-ghost btn-sm" onClick={() => setAdding(!adding)}>
            <Plus /> Add
          </button>
          {canExtract && (
            <button className="btn btn-secondary btn-sm" disabled={pending} onClick={() => go(() => extractTasks(transcriptId))}>
              {pending ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              {extractedAt ? "Summarize again" : "Summarize"}
            </button>
          )}
        </div>
      </div>
      {adding && (
        <form
          className="flex gap-2 border-b border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            go(() => addTaskToMeeting(transcriptId, { description: text }), () => {
              setText("");
              setAdding(false);
            });
          }}
        >
          <input className="input h-8 text-xs" placeholder="What needs doing?" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <button className="btn btn-primary btn-sm" disabled={pending || !text.trim()}>
            Add
          </button>
        </form>
      )}
      {tasks.length ? (
        <div className="max-h-[26rem] divide-y divide-border overflow-y-auto">
          {tasks.map((t) => (
            <TaskItem key={t.id} task={t} integrations={integrations} />
          ))}
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          {extractedAt ? (
            "No action items in this meeting."
          ) : canExtract ? (
            "Not summarized yet."
          ) : (
            <>
              <p>Connect an AI provider in Settings, or ask your assistant through the Debrief MCP server:</p>
              <button
                className="mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-left font-mono text-[0.6875rem] hover:border-primary/50 hover:text-foreground"
                onClick={() => {
                  navigator.clipboard?.writeText(prompt);
                  setCopied(true);
                }}
                title="Copy"
              >
                {prompt}
              </button>
              {copied && <p className="mt-1 text-primary">Copied.</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Posts the summary and action items to Slack (again). */
export function SlackButton({ transcriptId, sentAt }: { transcriptId: string; sentAt: string | null }) {
  const [pending, go] = useAction();
  return (
    <button
      className="btn btn-ghost btn-sm"
      disabled={pending}
      title={sentAt ? `Sent to Slack ${new Date(sentAt).toLocaleString()}` : "Post the summary and action items to Slack"}
      onClick={() => go(() => sendToSlack(transcriptId))}
    >
      {pending ? <LoaderCircle className="animate-spin" /> : <Send />} {sentAt ? "Send again" : "Slack"}
    </button>
  );
}
