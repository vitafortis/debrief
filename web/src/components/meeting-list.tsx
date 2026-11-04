"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { deleteMeetings } from "@/actions/meetings";
import { useAction } from "@/components/task-item";

/** The recordings on this page, each with a checkbox, and deleting the chosen ones at once. */
export function MeetingList({ items }: { items: { id: string; title: string; toReview?: boolean; row: ReactNode }[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, go] = useAction();
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const chosen = ids.filter((id) => selected.has(id));
  const all = chosen.length === ids.length && ids.length > 0;
  const clear = () => setSelected(new Set());
  const remove = () => {
    const names = items.filter((i) => selected.has(i.id)).map((i) => `• ${i.title}`);
    const list = names.length > 8 ? [...names.slice(0, 8), `…and ${names.length - 8} more`] : names;
    if (
      confirm(
        `Delete ${chosen.length === 1 ? "this recording" : `these ${chosen.length} recordings`}?\n\n${list.join("\n")}\n\nTheir transcripts, summaries, action items, audio and shared screens are deleted everywhere Debrief keeps them. This can't be undone.`,
      )
    )
      go(() => deleteMeetings(chosen), clear);
  };

  return (
    <div className="space-y-2">
      <div className="card flex flex-wrap items-center gap-2 px-4 py-2">
        <input
          type="checkbox"
          className="checkbox"
          checked={all}
          onChange={(e) => setSelected(e.target.checked ? new Set(ids) : new Set())}
          aria-label="Select all recordings on this page"
        />
        <span className="text-xs text-muted-foreground">{chosen.length ? `${chosen.length} selected` : "Select recordings to delete several at once"}</span>
        {chosen.length > 0 && (
          <div className="ml-auto flex gap-1.5">
            <button className="btn btn-ghost btn-sm" disabled={pending} onClick={clear}>
              Clear
            </button>
            <button className="btn btn-danger-outline btn-sm" disabled={pending} onClick={remove}>
              <Trash2 /> Delete {chosen.length}
            </button>
          </div>
        )}
      </div>
      {items.map((i) => (
        <div key={i.id} className="flex items-center gap-3">
          <input
            type="checkbox"
            className="checkbox shrink-0"
            checked={selected.has(i.id)}
            onChange={(e) =>
              setSelected((s) => {
                const n = new Set(s);
                if (e.target.checked) n.add(i.id);
                else n.delete(i.id);
                return n;
              })
            }
            aria-label={`Select ${i.title}`}
          />
          <div className="relative min-w-0 flex-1">
            {i.row}
            {/* Transcribed and not opened yet. */}
            {i.toReview && <span className="badge badge-success pointer-events-none absolute top-2 right-10 text-[0.625rem]">To review</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
