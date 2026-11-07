import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { integrationStatus, listTasks, meetingTitle, taskCounts } from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { EmptyState, PageHeader } from "@/components/ui";
import { TaskBoard } from "@/components/task-board";
import { TaskOverview } from "@/components/task-overview";
import { fmtDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Tasks" };

const TABS = [
  { key: "all", label: "All" },
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "pushed", label: "Sent" },
  { key: "dismissed", label: "Dismissed" },
] as const;

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const status = TABS.find((t) => t.key === sp.status)?.key ?? "all";
  const context = await currentContext();
  // All: everything but what was dismissed.
  const statuses = status === "all" ? (["pending", "approved", "pushed"] as const) : ([status] as const);
  const [rows, counts] = await Promise.all([listTasks(db(), { status: [...statuses], context, limit: status === "all" ? 500 : undefined }), taskCounts(db())]);
  const integrations = integrationStatus();
  const items = rows.map((r) => ({
    task: r.task,
    meetingTitle: meetingTitle({ title: r.transcriptTitle, eventTitle: r.eventTitle, titleHint: r.titleHint, recordedAt: r.recordedAt }),
    when: fmtDateTime(r.recordedAt),
  }));
  const count = (k: (typeof TABS)[number]["key"]) => (k === "all" ? (counts.pending ?? 0) + (counts.approved ?? 0) + (counts.pushed ?? 0) : counts[k]);

  return (
    <div>
      <PageHeader
        title="Tasks"
        description={
          status === "all"
            ? "Every action item from your recordings. Click one for its details."
            : "Action items from your recordings. Review them, then send them to Akiflow or Linear."
        }
        actions={
          <div className="flex rounded-xl bg-muted p-0.5 text-xs font-medium">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key === "all" ? "/tasks" : `/tasks?status=${t.key}`}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${status === t.key ? "bg-card shadow-surface" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t.label}
                {count(t.key) ? <span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">{count(t.key)}</span> : null}
              </Link>
            ))}
          </div>
        }
      />
      <div className="space-y-4 px-4 pb-10 md:px-8">
        {(!integrations.akiflow || !integrations.linear) && status !== "pushed" && (
          <p className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
            {!integrations.akiflow && !integrations.linear
              ? "Neither Akiflow nor Linear is set up yet, so tasks can be reviewed but not sent."
              : !integrations.akiflow
                ? "Akiflow isn't set up (AKIFLOW_WEBHOOK_URL), so only Linear tasks can be sent."
                : "Linear isn't set up (LINEAR_API_KEY), so only Akiflow tasks can be sent."}{" "}
            <Link href="/settings" className="text-primary hover:underline">
              Settings
            </Link>
          </p>
        )}
        {items.length && status === "all" ? (
          <TaskOverview items={items} integrations={integrations} />
        ) : items.length && status !== "all" ? (
          <TaskBoard items={items} status={status} integrations={integrations} />
        ) : (
          <EmptyState
            icon={ListChecks}
            title={status === "all" ? "No action items yet" : status === "pending" ? "Nothing to review" : `No ${TABS.find((t) => t.key === status)!.label.toLowerCase()} tasks`}
            body={status === "all" || status === "pending" ? "New action items appear here after a recording is summarized." : undefined}
          />
        )}
      </div>
    </div>
  );
}
