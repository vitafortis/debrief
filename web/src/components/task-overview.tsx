"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Circle, CircleDot, Pencil, Play, X } from "lucide-react";
import { TaskActions, TaskEditor, type TaskView } from "@/components/task-item";
import { clock } from "@/lib/time";
import { fmtDue } from "@/lib/due";

export const STATUS_LABEL: Record<TaskView["status"], string> = { pending: "To review", approved: "Approved", pushed: "Sent", dismissed: "Dismissed" };
const ORDER: Record<TaskView["status"], number> = { pending: 0, approved: 1, pushed: 2, dismissed: 3 };
const PRIORITY_DOT = { high: "bg-danger", medium: "bg-warning", low: "bg-muted-foreground/40" } as const;

function StatusIcon({ status }: { status: TaskView["status"] }) {
  if (status === "pushed") return <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Sent" />;
  if (status === "approved") return <CircleDot className="size-4 shrink-0 text-primary" aria-label="Approved" />;
  return <Circle className="size-4 shrink-0 text-muted-foreground" aria-label={STATUS_LABEL[status]} />;
}

/**
 * Every action item at a glance, one line each and grouped by recording,
 * open ones first within each. Clicking one opens its details beside the list.
 */
export function TaskOverview({
  items,
  integrations,
}: {
  items: { task: TaskView; meetingTitle: string; when: string }[];
  integrations: { akiflow: boolean; linear: boolean };
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = items.find((i) => i.task.id === openId) ?? null;

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  const groups = useMemo(() => {
    const out: { key: string; title: string; when: string; items: typeof items }[] = [];
    for (const i of items) {
      const last = out.at(-1);
      if (last?.key === i.task.transcriptId) last.items.push(i);
      else out.push({ key: i.task.transcriptId, title: i.meetingTitle, when: i.when, items: [i] });
    }
    for (const g of out) g.items.sort((a, b) => ORDER[a.task.status] - ORDER[b.task.status]);
    return out;
  }, [items]);

  return (
    <div className={open ? "lg:pr-[25rem]" : undefined}>
      <div className="space-y-3">
        {groups.map((g) => (
          <section key={g.key} className="card overflow-hidden">
            <Link
              href={`/recordings/${g.key}`}
              className="flex items-baseline justify-between gap-3 border-b border-border bg-surface/60 px-4 py-2 text-xs hover:text-foreground"
            >
              <span className="truncate font-medium">{g.title}</span>
              <span className="shrink-0 text-muted-foreground">{g.when}</span>
            </Link>
            <ul className="divide-y divide-border">
              {g.items.map(({ task }) => (
                <li key={task.id}>
                  <button
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent/40 ${openId === task.id ? "bg-accent/60" : ""}`}
                    onClick={() => setOpenId(openId === task.id ? null : task.id)}
                    aria-expanded={openId === task.id}
                  >
                    <StatusIcon status={task.status} />
                    <span className={`min-w-0 flex-1 truncate text-[0.8125rem] ${task.status === "pushed" ? "text-muted-foreground" : ""}`}>{task.description}</span>
                    <span className="hidden shrink-0 items-center gap-2 text-[0.6875rem] text-muted-foreground sm:flex">
                      {task.assignee && <span className="max-w-32 truncate">{task.assignee}</span>}
                      {task.dueDate && <span>{fmtDue(task.dueDate)}</span>}
                      {task.priority && <span className={`size-1.5 rounded-full ${PRIORITY_DOT[task.priority]}`} title={`${task.priority} priority`} />}
                      <span className="w-16 text-right">{STATUS_LABEL[task.status]}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {open && (
        <>
          {/* Narrow screens: the panel covers the list, so a tap outside closes it. */}
          <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpenId(null)} />
          <TaskPanel key={open.task.id} item={open} integrations={integrations} onClose={() => setOpenId(null)} />
        </>
      )}
    </div>
  );
}

function TaskPanel({
  item: { task, meetingTitle, when },
  integrations,
  onClose,
}: {
  item: { task: TaskView; meetingTitle: string; when: string };
  integrations: { akiflow: boolean; linear: boolean };
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const locked = task.status === "pushed";
  const at = task.sourceStart != null ? `?t=${Math.floor(task.sourceStart)}` : "";
  const fields: [string, React.ReactNode][] = [
    ["Status", STATUS_LABEL[task.status]],
    ["Owner", task.assignee ?? "—"],
    ["Due", task.dueDate ? fmtDue(task.dueDate) : "—"],
    ["Priority", task.priority ? <span className="capitalize">{task.priority}</span> : "—"],
    ["Send to", task.destination === "linear" ? "Linear" : "Akiflow"],
  ];

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-card shadow-surface-lg lg:w-[24rem]"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      aria-label="Action item"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <StatusIcon status={task.status} /> {STATUS_LABEL[task.status]}
        </span>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
          <X />
        </button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {editing ? (
          <TaskEditor task={task} onDone={() => setEditing(false)} />
        ) : (
          <div>
            <h2 className="text-base leading-snug font-semibold text-balance">{task.description}</h2>
            {task.details && <p className="mt-2 text-[0.8125rem] leading-relaxed whitespace-pre-line text-muted-foreground">{task.details}</p>}
            {!locked && (
              <button className="btn btn-ghost btn-sm mt-2 -ml-2" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </button>
            )}
          </div>
        )}

        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-xs">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        <div>
          <p className="label">From</p>
          <Link href={`/recordings/${task.transcriptId}${at}`} className="group flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs hover:border-primary/50">
            <Play className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium group-hover:text-foreground">{meetingTitle}</span>
              <span className="text-muted-foreground">
                {when}
                {task.sourceStart != null && <> · said at {clock(task.sourceStart)}</>}
              </span>
            </span>
          </Link>
        </div>

        {task.pushError && task.status !== "pushed" && <p className="text-xs text-danger">{task.pushError}</p>}
      </div>
      {!editing && (
        <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border px-4 py-3">
          <TaskActions task={task} integrations={integrations} />
        </div>
      )}
    </aside>
  );
}
