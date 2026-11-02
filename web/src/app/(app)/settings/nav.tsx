"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AudioLines, Box, CalendarDays, ChevronLeft, ChevronRight, Gauge, Mic, Plug, Sparkles, UserRound } from "lucide-react";
import type { SectionKey, SectionStatus } from "@/lib/settings-status";
import { StatusDot } from "./ui";

const GROUPS: { label?: string; items: { key: SectionKey; href: string; label: string; icon: React.ElementType }[] }[] = [
  { items: [{ key: "overview", href: "/settings", label: "Overview", icon: Gauge }] },
  { label: "You", items: [{ key: "account", href: "/settings/account", label: "Account", icon: UserRound }] },
  {
    label: "Capture",
    items: [
      { key: "devices", href: "/settings/devices", label: "Recorder & devices", icon: Mic },
      { key: "calendars", href: "/settings/calendars", label: "Calendars", icon: CalendarDays },
      { key: "transcription", href: "/settings/transcription", label: "Transcription", icon: AudioLines },
      { key: "storage", href: "/settings/storage", label: "Storage", icon: Box },
    ],
  },
  {
    label: "After the meeting",
    items: [
      { key: "ai", href: "/settings/ai", label: "AI summaries", icon: Sparkles },
      { key: "integrations", href: "/settings/integrations", label: "Slack & tasks", icon: Plug },
    ],
  },
];

/**
 * The settings sections, grouped, each with a dot: a side list on a wide
 * screen; on a phone, a list to tap into on /settings and a back link on
 * every other page.
 */
export function SettingsNav({ sections, needs }: { sections: Record<Exclude<SectionKey, "overview">, SectionStatus>; needs: number }) {
  const pathname = usePathname();
  const atIndex = pathname === "/settings";
  const status = (k: SectionKey) => (k === "overview" ? (needs ? "need" : "ok") : sections[k].status);
  const value = (k: SectionKey) => (k === "overview" ? (needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "All good") : sections[k].value);

  return (
    <>
      {/* Wide screens */}
      <nav aria-label="Settings sections" className="sticky top-0 hidden max-h-screen w-60 shrink-0 flex-col gap-0.5 self-start overflow-y-auto border-r border-border px-3 py-6 md:flex">
        <h1 className="mb-3 px-2 text-lg font-semibold tracking-tight">Settings</h1>
        {GROUPS.map((g, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            {g.label && <p className="mt-4 mb-1 px-2 text-[0.625rem] font-semibold tracking-widest text-muted-foreground uppercase">{g.label}</p>}
            {g.items.map((it) => {
              const active = pathname === it.href;
              return (
                <Link
                  key={it.key}
                  href={it.href}
                  aria-current={active ? "page" : undefined}
                  className={`grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.8125rem] transition-colors ${
                    active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  }`}
                >
                  <it.icon className="size-4" />
                  <span className="truncate">{it.label}</span>
                  <StatusDot s={status(it.key)} />
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Phones */}
      {atIndex ? (
        <nav aria-label="Settings sections" className="space-y-4 px-4 pt-5 md:hidden">
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          {GROUPS.slice(1).map((g) => (
            <div key={g.label} className="space-y-1.5">
              <p className="px-1 text-[0.625rem] font-semibold tracking-widest text-muted-foreground uppercase">{g.label}</p>
              <div className="card divide-y divide-border overflow-hidden">
                {g.items.map((it) => (
                  <Link key={it.key} href={it.href} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto_0.75rem] items-center gap-3 px-3 py-2.5 text-sm active:bg-accent">
                    <span className="grid size-7 place-items-center rounded-lg bg-muted">
                      <it.icon className="size-3.5" />
                    </span>
                    <span className="truncate">{it.label}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {status(it.key) === "need" && <StatusDot s="need" />}
                      <span className="max-w-32 truncate">{value(it.key)}</span>
                    </span>
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
      ) : (
        <div className="px-4 pt-3 md:hidden">
          <Link href="/settings" className="inline-flex items-center gap-0.5 text-sm font-medium text-primary">
            <ChevronLeft className="size-4" /> Settings
          </Link>
        </div>
      )}
    </>
  );
}
