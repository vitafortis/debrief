"use client";

import { useEffect, useRef, useState } from "react";

type Off = { count: number; hour: number } | null;

/**
 * A fixed-height window onto a 24-hour grid that opens on working hours. When
 * meetings fall outside it, a marker says how many and scrolls to them.
 */
export function TimeWindow({ from, to, hourPx, earlier, later, children }: { from: number; to: number; hourPx: number; earlier: Off; later: Off; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: from, bottom: to });

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = from * hourPx;
  }, [from, hourPx]);

  const go = (hour: number) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollTo({ top: Math.max(0, hour) * hourPx, behavior: reduce ? "auto" : "smooth" });
  };
  const span = to - from;
  const marker = "absolute left-1/2 z-10 -translate-x-1/2 rounded-full border border-primary/40 bg-card px-2.5 py-0.5 text-[0.6875rem] font-semibold text-primary shadow-surface";

  return (
    <div className="relative">
      {earlier && earlier.hour < view.top && (
        <button type="button" className={`${marker} top-1.5`} onClick={() => go(earlier.hour - 0.5)}>
          ↑ {earlier.count} earlier
        </button>
      )}
      <div
        ref={ref}
        className="overflow-y-auto overscroll-contain border-y border-border [scrollbar-width:thin]"
        style={{ height: span * hourPx }}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop / hourPx;
          setView({ top, bottom: top + span });
        }}
      >
        {children}
      </div>
      {later && later.hour >= view.bottom && (
        <button type="button" className={`${marker} bottom-1.5`} onClick={() => go(later.hour - span + 1.5)}>
          ↓ {later.count} later
        </button>
      )}
    </div>
  );
}
