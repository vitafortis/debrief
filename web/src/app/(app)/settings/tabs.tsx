"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const TABS = [
  { href: "/settings", label: "General" },
  { href: "/settings/sign-in", label: "Sign-in" },
  { href: "/settings/calendars", label: "Calendars" },
  { href: "/settings/recordings", label: "Recordings" },
  { href: "/settings/transcription", label: "Transcription" },
  { href: "/settings/claude", label: "Claude" },
  { href: "/settings/integrations", label: "Slack & tasks" },
  { href: "/settings/devices", label: "Devices & keys" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  const nav = useRef<HTMLElement>(null);
  // On a phone the tabs scroll sideways: keep the open one in view.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);
  return (
    <nav ref={nav} className="-mb-px flex gap-1 overflow-x-auto border-b border-border px-4 md:px-8" aria-label="Settings sections">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 border-b-2 px-3 py-2 text-[0.8125rem] font-medium whitespace-nowrap transition-colors ${
              active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
