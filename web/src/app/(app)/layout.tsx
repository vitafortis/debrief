import { redirect } from "next/navigation";
import { listContexts, taskCounts } from "@debrief/core";
import { db } from "@/lib/db";
import { authMode, viewer } from "@/lib/auth";
import { currentContext } from "@/lib/context";
import { Shell } from "@/components/shell";
import { Toaster } from "@/components/toaster";
import pkg from "../../../package.json";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const v = await viewer();
  if (!v) redirect("/login");
  const [contexts, counts, context] = await Promise.all([listContexts(db()), taskCounts(db()), currentContext()]);
  return (
    <>
      <Shell
        viewer={v}
        canSignOut={authMode() !== "none"}
        contexts={contexts}
        context={context}
        pendingTasks={counts.pending ?? 0}
        version={pkg.version}
      >
        {children}
      </Shell>
      <Toaster />
    </>
  );
}
