import type { LucideIcon } from "lucide-react";
import { HL_END, HL_START, highlightRuns } from "@debrief/core/search";

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="relative">
      <div className="glow-top pointer-events-none absolute inset-x-0 -top-10 h-64" />
      <header className="relative flex flex-wrap items-end justify-between gap-4 px-4 pt-6 pb-5 md:px-8 md:pt-8 md:pb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: LucideIcon; title: string; body?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-xl border border-border bg-surface text-primary">
        <Icon className="size-5" />
      </span>
      <p className="mt-4 text-[0.9375rem] font-medium">{title}</p>
      {body && <p className="mt-1 max-w-md text-[0.8125rem] text-muted-foreground">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon: Icon }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon: LucideIcon }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        {label}
        <Icon className="size-4" />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const STATUS = {
  none: { label: "No recording", cls: "badge", dot: "bg-muted-foreground/50" },
  pending: { label: "Queued", cls: "badge badge-warning", dot: "bg-warning" },
  processing: { label: "Transcribing", cls: "badge badge-primary", dot: "dot-busy" },
  done: { label: "Ready", cls: "badge badge-success", dot: "bg-success" },
  error: { label: "Failed", cls: "badge badge-danger", dot: "bg-danger" },
} as const;

export function StatusBadge({ status, progress }: { status: keyof typeof STATUS; progress?: number | null }) {
  const s = STATUS[status];
  return (
    <span className={s.cls}>
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
      {status === "processing" && progress != null && <span className="font-mono tabular-nums">{Math.round(progress * 100)}%</span>}
    </span>
  );
}

export function StatusDot({ status }: { status: keyof typeof STATUS }) {
  return <span title={STATUS[status].label} className={`inline-block size-2 shrink-0 rounded-full ${STATUS[status].dot}`} />;
}

export function ContextBadge({ context, color }: { context: string | null | undefined; color: string }) {
  if (!context) return null;
  return (
    <span className="badge capitalize">
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {context}
    </span>
  );
}

/** Text with ts_headline's markers shown as <mark>. */
export function Highlighted({ text }: { text: string }) {
  if (!text.includes(HL_START) && !text.includes(HL_END)) return <>{text}</>;
  return (
    <>
      {highlightRuns(text).map((r, i) => (r.match ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
    </>
  );
}
