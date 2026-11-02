"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type BuildStatus = {
  version: string;
  commit: string | null;
  builtAt: string | null;
  /** ok: all running this build; trouble: a service is down or on another build; update: a newer build is out. */
  state: "ok" | "trouble" | "update";
  services: { name: string; version: string | null; line: string; ok: boolean }[];
  update: { version: string; ago: string; url: string } | null;
};

/** The build in the sidebar's foot, with a dot; click for each service and whether there's an update. */
export function VersionBadge({ build, collapsed }: { build: BuildStatus; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const dot = build.state === "ok" ? "bg-success" : build.state === "update" ? "bg-primary" : "bg-warning";
  const title = build.state === "ok" ? "Up to date, all running" : build.state === "update" ? `${build.update?.version} is available` : "A service needs a look";

  return (
    <div ref={box} className={`relative ${collapsed ? "" : "min-w-0"}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={title}
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 font-mono text-[0.6875rem] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <i className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        {!collapsed && <span className="truncate">{build.version === "dev" ? "dev" : `v${build.version}`}</span>}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-card text-xs shadow-lg">
          <div className="border-b border-border px-3.5 py-2.5">
            <p className="text-[0.8125rem] font-semibold">
              Debrief {build.version} {build.commit && <code className="font-mono text-[0.6875rem] font-normal text-muted-foreground">{build.commit}</code>}
            </p>
            {build.builtAt && <p className="text-[0.6875rem] text-muted-foreground">Built {build.builtAt}</p>}
          </div>
          <div className="divide-y divide-border">
            {build.services.map((s) => (
              <div key={s.name} className="grid grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-2.5 px-3.5 py-2">
                <i className={`size-1.5 rounded-full ${s.ok ? "bg-success" : "bg-warning"}`} />
                <div className="min-w-0">
                  <p className="font-medium">{s.name}</p>
                  <p className="text-[0.6875rem] leading-snug text-muted-foreground">{s.line}</p>
                </div>
                <code className="font-mono text-[0.6875rem] text-muted-foreground">{s.version ?? "–"}</code>
              </div>
            ))}
          </div>
          {build.update && (
            <div className="border-t border-border bg-primary-soft px-3.5 py-2.5">
              <p className="font-semibold">{build.update.version} is available</p>
              <p className="text-[0.6875rem] text-muted-foreground">Built {build.update.ago}. Pull the images, then redeploy (in Arcane: the stack → Pull, then Redeploy).</p>
            </div>
          )}
          <Link href="/settings" onClick={() => setOpen(false)} className="block border-t border-border px-3.5 py-2 text-[0.6875rem] text-muted-foreground hover:text-foreground">
            Settings → Overview
          </Link>
        </div>
      )}
    </div>
  );
}
