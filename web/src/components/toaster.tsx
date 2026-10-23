"use client";

import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

type Toast = { id: number; kind: "success" | "error" | "info"; title: string; body?: string };
let next = 1;

/** Shows a toast, bottom right. Errors stay longer. */
export function toast(kind: Toast["kind"], title: string, body?: string) {
  window.dispatchEvent(new CustomEvent("debrief-toast", { detail: { id: next++, kind, title, body } }));
}

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setList((l) => [...l, t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.kind === "error" ? 9000 : 4000);
    };
    window.addEventListener("debrief-toast", on);
    return () => window.removeEventListener("debrief-toast", on);
  }, []);
  return (
    <div className="pointer-events-none fixed right-4 bottom-20 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 md:bottom-4">
      {list.map((t) => (
        <div key={t.id} role="status" className="card pointer-events-auto flex items-start gap-3 p-3 shadow-surface-lg">
          {t.kind === "success" ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
          ) : t.kind === "error" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[0.8125rem] font-medium">{t.title}</p>
            {t.body && <p className="mt-0.5 text-xs break-words text-muted-foreground">{t.body}</p>}
          </div>
          <button className="text-muted-foreground hover:text-foreground" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))} aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
