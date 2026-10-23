"use client";

import { useMemo, useState } from "react";
import { Check, Send, X } from "lucide-react";
import { approveAndPush, setStatus } from "@/actions/tasks";
import { TaskItem, useAction, type TaskView } from "@/components/task-item";

/** The Tasks list with bulk approve, send and dismiss. */
export function TaskBoard({
  items,
  status,
  integrations,
}: {
  items: { task: TaskView; meetingTitle: string }[];
  status: TaskView["status"];
  integrations: { akiflow: boolean; linear: boolean };
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, go] = useAction();
  const selectable = status !== "pushed";
  const ids = useMemo(() => items.map((i) => i.task.id), [items]);
  const chosen = ids.filter((id) => selected.has(id));
  const all = chosen.length === ids.length && ids.length > 0;
  const clear = () => setSelected(new Set());

  // Meetings in order, each with its tasks.
  const groups = useMemo(() => {
    const out: { key: string; title: string; items: typeof items }[] = [];
    for (const i of items) {
      const last = out.at(-1);
      if (last?.key === i.task.transcriptId) last.items.push(i);
      else out.push({ key: i.task.transcriptId, title: i.meetingTitle, items: [i] });
    }
    return out;
  }, [items]);

  return (
    <div className="space-y-3">
      {selectable && (
        <div className="card sticky top-2 z-10 flex flex-wrap items-center gap-2 px-4 py-2">
          <input
            type="checkbox"
            className="checkbox"
            checked={all}
            onChange={(e) => setSelected(e.target.checked ? new Set(ids) : new Set())}
            aria-label="Select all"
          />
          <span className="text-xs text-muted-foreground">{chosen.length ? `${chosen.length} selected` : "Select tasks to act on several at once"}</span>
          {chosen.length > 0 && (
            <div className="ml-auto flex gap-1.5">
              {status !== "dismissed" && (
                <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => go(() => setStatus(chosen, "dismissed"), clear)}>
                  <X /> Dismiss
                </button>
              )}
              {status === "pending" && (
                <button className="btn btn-secondary btn-sm" disabled={pending} onClick={() => go(() => setStatus(chosen, "approved"), clear)}>
                  <Check /> Approve
                </button>
              )}
              {status === "dismissed" ? (
                <button className="btn btn-secondary btn-sm" disabled={pending} onClick={() => go(() => setStatus(chosen, "pending"), clear)}>
                  Restore
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" disabled={pending} onClick={() => go(() => approveAndPush(chosen), clear)}>
                  <Send /> Approve &amp; send
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {groups.map((g) => (
        <section key={g.key} className="card overflow-hidden">
          <p className="border-b border-border bg-surface/60 px-4 py-2 text-xs font-medium text-muted-foreground">{g.title}</p>
          <div className="divide-y divide-border">
            {g.items.map(({ task }) => (
              <TaskItem
                key={task.id}
                task={task}
                meetingTitle={g.title}
                selectable={selectable}
                selected={selected.has(task.id)}
                onSelect={(v) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (v) n.add(task.id);
                    else n.delete(task.id);
                    return n;
                  })
                }
                integrations={integrations}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
