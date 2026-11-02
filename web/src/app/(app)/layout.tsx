import { redirect } from "next/navigation";
import { buildInfo, listContexts, serviceHealth, taskCounts, updateAvailable } from "@debrief/core";
import { db } from "@/lib/db";
import { authMode, viewer } from "@/lib/auth";
import { currentContext } from "@/lib/context";
import { Shell } from "@/components/shell";
import { Toaster } from "@/components/toaster";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { SERVICE_NAMES, serviceLine } from "@/lib/settings-status";
import type { BuildStatus } from "@/components/version-badge";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const v = await viewer();
  if (!v) redirect("/login");
  const [contexts, counts, context, services] = await Promise.all([listContexts(db()), taskCounts(db()), currentContext(), serviceHealth(db())]);
  const b = buildInfo();
  const update = updateAvailable();
  const build: BuildStatus = {
    version: b.version,
    commit: b.commit,
    builtAt: b.builtAt ? fmtDateTime(new Date(b.builtAt)) : null,
    state: services.some((s) => s.state !== "ok") ? "trouble" : update ? "update" : "ok",
    services: services.map((s) => ({ name: SERVICE_NAMES[s.service], version: s.version, line: serviceLine(s, b.version), ok: s.state === "ok" })),
    update: update ? { version: update.version, ago: fmtAgo(update.builtAt), url: update.url } : null,
  };
  return (
    <>
      <Shell
        viewer={v}
        canSignOut={authMode() !== "none"}
        contexts={contexts}
        context={context}
        pendingTasks={counts.pending ?? 0}
        build={build}
      >
        {children}
      </Shell>
      <Toaster />
    </>
  );
}
