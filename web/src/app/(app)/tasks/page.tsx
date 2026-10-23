import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { integrationStatus, listTasks, meetingTitle, taskCounts } from "@debrief/core";
import { db } from "@/lib/db";
import { currentContext } from "@/lib/context";
import { EmptyState, PageHeader } from "@/components/ui";
import { TaskBoard } from "@/components/task-board";

export const metadata: Metadata = { title: "Tasks" };

const TABS = [
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "pushed", label: "Sent" },
  { key: "dismissed", label: "Dismissed" },
] as const;

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const status = TABS.find((t) => t.key === sp.status)?.key ?? "pending";
  const context = await currentContext();
  const [rows, counts] = await Promise.all([listTasks(db(), { status: [status], context }), taskCounts(db())]);
  const integrations = integrationStatus();
  const items = rows.map((r) => ({
    task: r.task,
    meetingTitle: meetingTitle({ title: r.transcriptTitle, eventTitle: r.eventTitle, titleHint: r.titleHint, recordedAt: r.recordedAt }),
  }));

  return (
    <div>
      <PageHeader
        title="Tasks"
        description="Action items from your meetings. Review them, then send them to Akiflow or Linear."
        actions={
          <div className="flex rounded-xl bg-muted p-0.5 text-xs font-medium">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key === "pending" ? "/tasks" : `/tasks?status=${t.key}`}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${status === t.key ? "bg-card shadow-surface" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t.label}
                {counts[t.key] ? <span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">{counts[t.key]}</span> : null}
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
        {items.length ? (
          <TaskBoard items={items} status={status} integrations={integrations} />
        ) : (
          <EmptyState
            icon={ListChecks}
            title={status === "pending" ? "Nothing to review" : `No ${TABS.find((t) => t.key === status)!.label.toLowerCase()} tasks`}
            body={status === "pending" ? "New action items appear here after Claude reads a meeting." : undefined}
          />
        )}
      </div>
    </div>
  );
}
