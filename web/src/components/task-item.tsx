"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle, Pencil, Send, Undo2, X } from "lucide-react";
import { editTask, pushOne, setStatus } from "@/actions/tasks";
import { toast } from "@/components/toaster";
import { clock } from "@/lib/time";
import { fmtDue } from "@/lib/due";

export type TaskView = {
  id: string;
  transcriptId: string;
  description: string;
  details: string | null;
  assignee: string | null;
  dueDate: string | null;
  priority: "high" | "medium" | "low" | null;
  destination: "akiflow" | "linear" | null;
  status: "pending" | "approved" | "pushed" | "dismissed";
  sourceStart: number | null;
  externalId: string | null;
  externalUrl: string | null;
  pushError: string | null;
  context: string | null;
};

const PRIORITY = { high: "badge-danger", medium: "badge-warning", low: "" } as const;

export function useAction() {
  const [pending, start] = useTransition();
  const go = (fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        if (r.message) toast("success", r.message);
        after?.();
      } else toast("error", "That didn't work", r.error);
    });
  return [pending, go] as const;
}

/**
 * One action item: what, who, when, where it goes. Click the text to edit;
 * approve, dismiss or send it from the buttons on the right.
 */
export function TaskItem({
  task,
  meetingTitle,
  selectable,
  selected,
  onSelect,
  integrations,
}: {
  task: TaskView;
  /** Shown on the Tasks page, with a link to the moment in the meeting. */
  meetingTitle?: string;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
  integrations: { akiflow: boolean; linear: boolean };
}) {
  const [editing, setEditing] = useState(false);
  const [pending, go] = useAction();
  const [draft, setDraft] = useState({
    description: task.description,
    assignee: task.assignee ?? "",
    dueDate: task.dueDate ?? "",
    priority: task.priority ?? "medium",
    destination: task.destination ?? "akiflow",
  });
  const locked = task.status === "pushed";
  const dest = task.destination ?? "akiflow";
  const canPush = integrations[dest];

  const save = () =>
    go(
      () =>
        editTask(task.id, {
          description: draft.description,
          assignee: draft.assignee || null,
          dueDate: draft.dueDate || null,
          priority: draft.priority,
          destination: draft.destination,
        }),
      () => setEditing(false)
    );

  return (
    // Actions sit beside the text when there's room (Tasks page), under it in the narrow meeting sidebar.
    <div className={`@container px-4 py-3 ${task.status === "dismissed" ? "opacity-55" : ""}`}>
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 @xl:flex-nowrap">
      {selectable && (
        <input
          type="checkbox"
          className="checkbox mt-1"
          checked={!!selected}
          disabled={locked}
          onChange={(e) => onSelect?.(e.target.checked)}
          aria-label="Select task"
        />
      )}
      <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] @xl:basis-auto">
        {editing ? (
          <div className="space-y-2">
            <textarea
              className="input h-auto min-h-16 py-2"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              autoFocus
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <input className="input h-8 text-xs" placeholder="Owner" value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })} />
              <input className="input h-8 text-xs" type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} aria-label="Due date" />
              <select className="input h-8 text-xs" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as typeof draft.priority })} aria-label="Priority">
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <select className="input h-8 text-xs" value={draft.destination} onChange={(e) => setDraft({ ...draft, destination: e.target.value as typeof draft.destination })} aria-label="Send to">
                <option value="akiflow">Akiflow</option>
                <option value="linear">Linear</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary btn-sm" onClick={save} disabled={pending || !draft.description.trim()}>
                Save
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              className="group text-left text-[0.8125rem] leading-snug disabled:cursor-default"
              onClick={() => setEditing(true)}
              disabled={locked}
              title={locked ? undefined : "Edit"}
            >
              {task.description}
              {!locked && <Pencil className="ml-1.5 inline size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />}
            </button>
            {task.details && <p className="mt-0.5 text-xs text-muted-foreground">{task.details}</p>}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
              {task.priority && <span className={`badge ${PRIORITY[task.priority]} capitalize`}>{task.priority}</span>}
              <span className="badge">{dest === "linear" ? "Linear" : "Akiflow"}</span>
              {task.assignee && <span>{task.assignee}</span>}
              {task.dueDate && <span>· due {fmtDue(task.dueDate)}</span>}
              {meetingTitle && (
                <Link
                  href={`/meetings/${task.transcriptId}${task.sourceStart != null ? `?t=${Math.floor(task.sourceStart)}` : ""}`}
                  className="truncate hover:text-foreground"
                >
                  · {meetingTitle}
                  {task.sourceStart != null ? ` @ ${clock(task.sourceStart)}` : ""}
                </Link>
              )}
              {!meetingTitle && task.sourceStart != null && (
                <a href={`?t=${Math.floor(task.sourceStart)}`} className="font-mono hover:text-foreground">
                  @ {clock(task.sourceStart)}
                </a>
              )}
            </div>
            {task.pushError && task.status !== "pushed" && <p className="mt-1 text-[0.6875rem] text-danger">{task.pushError}</p>}
          </>
        )}
      </div>
      {!editing && (
        <div className={`flex shrink-0 items-center gap-1 ${selectable ? "ml-7" : ""} @xl:ml-0`}>
          {pending && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
          {task.status === "pushed" ? (
            task.externalUrl ? (
              <a href={task.externalUrl} target="_blank" rel="noreferrer" className="badge badge-success hover:underline">
                {task.externalId} <ExternalLink />
              </a>
            ) : (
              <span className="badge badge-success">
                <Check /> In Akiflow
              </span>
            )
          ) : task.status === "dismissed" ? (
            <button className="btn btn-ghost btn-sm" onClick={() => go(() => setStatus([task.id], "pending"))} disabled={pending}>
              <Undo2 /> Restore
            </button>
          ) : (
            <>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                title="Dismiss"
                onClick={() => go(() => setStatus([task.id], "dismissed"))}
                disabled={pending}
              >
                <X />
              </button>
              {task.status === "pending" && (
                <button className="btn btn-secondary btn-sm" onClick={() => go(() => setStatus([task.id], "approved"))} disabled={pending} title="Approve without sending yet">
                  <Check /> Approve
                </button>
              )}
              <button
                className="btn btn-primary btn-sm"
                onClick={() => go(() => pushOne(task.id))}
                disabled={pending || !canPush}
                title={canPush ? `Send to ${dest === "linear" ? "Linear" : "Akiflow"}` : `${dest === "linear" ? "Linear" : "Akiflow"} isn't set up (Settings)`}
              >
                <Send /> Send
              </button>
            </>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
