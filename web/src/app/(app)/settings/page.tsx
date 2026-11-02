import type { Metadata } from "next";
import Link from "next/link";
import { buildInfo, latestBuild, updateAvailable } from "@debrief/core";
import { AutoRefresh } from "@/components/auto-refresh";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { SERVICE_NAMES, serviceLine, settingsStatus, type SectionKey } from "@/lib/settings-status";
import { PageHead, StatusDot } from "./ui";

export const metadata: Metadata = { title: "Settings" };

const TILES: { key: Exclude<SectionKey, "overview">; name: string; href: string }[] = [
  { key: "ai", name: "AI summaries", href: "/settings/ai" },
  { key: "calendars", name: "Calendars", href: "/settings/calendars" },
  { key: "transcription", name: "Transcriber", href: "/settings/transcription" },
  { key: "devices", name: "Recorder", href: "/settings/devices" },
  { key: "storage", name: "Archive", href: "/settings/storage" },
  { key: "integrations", name: "Slack & tasks", href: "/settings/integrations" },
  { key: "account", name: "Sign-in", href: "/settings/account" },
];

export default async function Overview() {
  const { sections, services } = await settingsStatus();
  const build = buildInfo();
  const update = updateAvailable();
  const latest = latestBuild();
  // Problems first.
  const tiles = [...TILES].sort((a, b) => Number(sections[b.key].status === "need") - Number(sections[a.key].status === "need"));
  const busy = services.some((s) => s.detail === "transcribing");

  return (
    <div>
      <AutoRefresh active={busy} />
      <div className="mt-6 md:mt-0">
        <PageHead title="Overview">What&apos;s working, and what still needs you. Each tile opens its section. A value set in .env shows a lock.</PageHead>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-2">
        {tiles.map((t) => {
          const s = sections[t.key];
          return (
            <Link
              key={t.key}
              href={t.href}
              className={`grid content-start gap-1 rounded-xl border px-3 py-2.5 transition-colors hover:border-primary/40 ${s.status === "need" ? "border-warning/50 bg-warning/5" : "border-border bg-card"}`}
            >
              <span className="flex items-center gap-2 text-[0.8125rem] font-semibold">
                <StatusDot s={s.status} /> {t.name}
              </span>
              <span className="text-xs leading-snug text-muted-foreground">{s.detail}</span>
            </Link>
          );
        })}
      </div>

      <div className="mt-8 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-0.5">
          <h2 className="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">Version</h2>
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {build.version}
            {build.commit && ` · ${build.commit}`}
            {build.builtAt && ` · built ${fmtDateTime(new Date(build.builtAt))}`}
          </span>
        </div>
        <section className="card divide-y divide-border overflow-hidden">
          {services.map((s) => (
            <div key={s.service} className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5">
              <StatusDot s={s.state === "ok" ? "ok" : "need"} />
              <div className="min-w-0">
                <p className="text-[0.8125rem] font-medium">{SERVICE_NAMES[s.service]}</p>
                <p className="text-xs text-muted-foreground">{serviceLine(s, build.version)}</p>
              </div>
              <code className="font-mono text-[0.6875rem] text-muted-foreground">{s.version ?? "–"}</code>
            </div>
          ))}
          {update ? (
            <div className="flex flex-wrap items-center gap-2 bg-primary-soft px-4 py-2.5 text-xs">
              <span>
                <b className="font-semibold">{update.version} is available</b>, built {fmtAgo(update.builtAt)}. In Arcane or wherever you run it: pull the images, then redeploy.
              </span>
              <a href={update.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm ml-auto">
                What&apos;s new
              </a>
            </div>
          ) : (
            <p className="px-4 py-2.5 text-xs text-muted-foreground">
              {build.version === "dev" ? "A development build: not checking for updates." : latest ? "Up to date with the newest build on GitHub." : "Checking GitHub for newer builds about once an hour."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
