"use client";

import { useState } from "react";
import { CalendarPlus, RefreshCw, Trash2 } from "lucide-react";
import { addCalendar, removeCalendar, updateCalendar } from "@/actions/settings";
import { syncCalendarsNow } from "@/actions/meetings";
import { useAction } from "@/components/task-item";

type Cal = {
  id: string;
  source: string;
  externalId: string;
  name: string;
  context: string;
  enabled: boolean;
  defaultDestination: "akiflow" | "linear";
  lastSynced: string | null;
  lastError: string | null;
};

function CalendarRow({ c }: { c: Cal }) {
  const [pending, go] = useAction();
  const [ctx, setCtx] = useState(c.context);
  // Shown at once; the server catches up (and a failure puts it back).
  const [enabled, setEnabled] = useState(c.enabled);
  return (
    <div className={`grid items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_9rem_8rem_auto] ${enabled ? "" : "opacity-60"}`}>
      <div className="flex min-w-0 items-start gap-3">
        <input
          type="checkbox"
          className="checkbox mt-0.5"
          checked={enabled}
          onChange={(e) => {
            const v = e.target.checked;
            setEnabled(v);
            go(async () => {
              const r = await updateCalendar(c.id, { enabled: v });
              if (!r.ok) setEnabled(!v);
              return r;
            });
          }}
          aria-label={`Sync ${c.name}`}
        />
        <div className="min-w-0">
          <p className="truncate text-[0.8125rem] font-medium">{c.name}</p>
          <p className="truncate font-mono text-[0.6875rem] text-muted-foreground" title={c.externalId}>
            {c.source === "google" ? "Google · " : "ICS · "}
            {c.source === "ics" ? c.externalId.replace(/^https?:\/\/([^/]+).*/, "$1/…") : c.externalId}
          </p>
          <p className={`text-[0.6875rem] ${c.lastError ? "text-danger" : "text-muted-foreground"}`}>
            {c.lastError ?? (!enabled ? "Off" : c.lastSynced ? `Synced ${c.lastSynced}` : "Not synced yet")}
          </p>
        </div>
      </div>
      <div>
        <label className="label md:hidden">Context</label>
        <input
          className="input h-8 text-xs"
          value={ctx}
          onChange={(e) => setCtx(e.target.value)}
          onBlur={() => ctx !== c.context && go(() => updateCalendar(c.id, { context: ctx }))}
          aria-label="Context"
        />
      </div>
      <div>
        <label className="label md:hidden">Tasks go to</label>
        <select
          className="input h-8 text-xs"
          value={c.defaultDestination}
          disabled={pending}
          onChange={(e) => go(() => updateCalendar(c.id, { defaultDestination: e.target.value as Cal["defaultDestination"] }))}
          aria-label="Tasks go to"
        >
          <option value="akiflow">Akiflow</option>
          <option value="linear">Linear</option>
        </select>
      </div>
      <button
        className="btn btn-ghost btn-icon btn-sm justify-self-end"
        title="Remove"
        disabled={pending}
        onClick={() => confirm(`Remove ${c.name} and its synced events?`) && go(() => removeCalendar(c.id))}
      >
        <Trash2 />
      </button>
    </div>
  );
}

export function CalendarSettings({ calendars }: { calendars: Cal[] }) {
  const [pending, go] = useAction();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ source: "google", externalId: "", name: "", context: "" });
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Calendars</h2>
          <p className="text-xs text-muted-foreground">
            Each has a context (acme, lumen) that filters the app and routes its meetings&apos; tasks.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary btn-sm" disabled={pending} onClick={() => go(() => syncCalendarsNow())}>
            <RefreshCw className={pending ? "animate-spin" : ""} /> Sync now
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(!adding)}>
            <CalendarPlus /> Add
          </button>
        </div>
      </div>
      {adding && (
        <form
          className="grid gap-3 border-b border-border bg-surface/50 px-4 py-4 md:grid-cols-[8rem_minmax(0,1fr)_10rem_10rem_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            go(() => addCalendar(draft), () => {
              setDraft({ source: "google", externalId: "", name: "", context: "" });
              setAdding(false);
            });
          }}
        >
          <div>
            <label className="label" htmlFor="cal-source">
              Type
            </label>
            <select id="cal-source" className="input h-8 text-xs" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })}>
              <option value="google">Google</option>
              <option value="ics">ICS feed</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="cal-id">
              {draft.source === "google" ? "Calendar ID" : "Feed URL"}
            </label>
            <input
              id="cal-id"
              className="input h-8 text-xs"
              placeholder={draft.source === "google" ? "you@company.com, or primary" : "https://outlook.office365.com/owa/calendar/…/calendar.ics"}
              value={draft.externalId}
              onChange={(e) => setDraft({ ...draft, externalId: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="cal-name">
              Name
            </label>
            <input id="cal-name" className="input h-8 text-xs" placeholder="Work" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="cal-ctx">
              Context
            </label>
            <input id="cal-ctx" className="input h-8 text-xs" placeholder="acme" value={draft.context} onChange={(e) => setDraft({ ...draft, context: e.target.value })} required />
          </div>
          <button className="btn btn-primary btn-sm" disabled={pending}>
            Add calendar
          </button>
          {draft.source === "google" && (
            <p className="text-[0.6875rem] text-muted-foreground md:col-span-5">
              With a service account, share the calendar with its address first (Google Calendar → Settings → Share with specific people).
            </p>
          )}
        </form>
      )}
      {calendars.length ? (
        <div className="divide-y divide-border">
          <div className="hidden grid-cols-[minmax(0,1fr)_9rem_8rem_auto] gap-3 px-4 py-2 text-[0.6875rem] font-medium text-muted-foreground md:grid">
            <span className="pl-7">Calendar</span>
            <span>Context</span>
            <span>Tasks go to</span>
            <span className="w-7" />
          </div>
          {calendars.map((c) => (
            <CalendarRow key={c.id} c={c} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">
          No calendars yet. Add one here, or set GOOGLE_CALENDARS / ICS_CALENDARS on calendar-sync.
        </p>
      )}
    </section>
  );
}
