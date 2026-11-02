"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Copy, ExternalLink, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { addCalendars, checkCalendarAction, disconnectGoogle, removeCalendar, saveGoogleClient, saveGoogleKey, updateCalendar } from "@/actions/settings";
import { syncCalendarsNow } from "@/actions/meetings";
import { useAction } from "@/components/task-item";
import { contextColor } from "@/lib/colors";
import { SectionLabel } from "./settings-form";
import { Switch, Tiles } from "./ui";

export type Cal = {
  id: string;
  source: string;
  externalId: string;
  name: string;
  context: string;
  enabled: boolean;
  defaultDestination: "akiflow" | "linear";
  lastSynced: string | null;
  lastError: string | null;
  events: number;
};

export type GoogleState = {
  oauthReady: boolean;
  clientId: string;
  kind: "none" | "account" | "service";
  email: string | null;
  locked: boolean;
  redirectUri: string;
  found: { id: string; name: string; primary: boolean; added: "google" | "ics" | null }[] | null;
  listError: string | null;
};

type Source = "gme" | "gsa" | "ics";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm btn-icon shrink-0"
      title="Copy"
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check /> : <Copy />}
    </button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <span className="mt-1.5 flex items-start gap-1 rounded-lg bg-muted px-2.5 py-1.5">
      <code className="min-w-0 flex-1 font-mono text-[0.6875rem] break-all">{children}</code>
      <CopyButton value={children} />
    </span>
  );
}

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
    {children}
    <ExternalLink className="size-3" />
  </a>
);

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal space-y-2.5 pl-5 text-[0.8125rem] marker:font-semibold marker:text-muted-foreground">{children}</ol>;
}

// ── The list ────────────────────────────────────────────────────────────────

function CalendarRow({ c, contexts }: { c: Cal; contexts: string[] }) {
  const [pending, go] = useAction();
  const [editing, setEditing] = useState(false);
  const [ctx, setCtx] = useState(c.context);
  // Shown at once; the server catches up (and a failure puts it back).
  const [enabled, setEnabled] = useState(c.enabled);
  const where = c.source === "google" ? `Google · ${c.externalId}` : `ICS link · ${c.externalId.replace(/^https?:\/\/([^/]+).*/, "$1")}`;
  return (
    <div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
        <Switch
          checked={enabled}
          label={`Sync ${c.name}`}
          onChange={(v) => {
            setEnabled(v);
            go(async () => {
              const r = await updateCalendar(c.id, { enabled: v });
              if (!r.ok) setEnabled(!v);
              return r;
            });
          }}
        />
        <div className={`min-w-0 ${enabled ? "" : "opacity-60"}`}>
          <p className="flex min-w-0 items-center gap-2 text-[0.8125rem] font-medium">
            <span className="truncate">{c.name}</span>
            <span className="badge-device shrink-0" style={{ "--d": contextColor(c.context, contexts) } as React.CSSProperties}>
              {c.context}
            </span>
          </p>
          <p className={`text-[0.6875rem] ${c.lastError && enabled ? "text-danger" : "text-muted-foreground"}`}>
            {c.lastError && enabled ? c.lastError : [where, enabled ? (c.lastSynced ? `${c.events} events · synced ${c.lastSynced}` : "waiting for the first sync") : "off"].join(" · ")}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(!editing)} aria-expanded={editing}>
          {editing ? "Done" : "Edit"}
        </button>
      </div>
      {editing && (
        <div className="grid gap-3 border-t border-border bg-surface/40 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div>
            <label className="label" htmlFor={`ctx-${c.id}`}>
              Context
            </label>
            <input
              id={`ctx-${c.id}`}
              className="input h-8 text-xs"
              value={ctx}
              list="cal-contexts"
              onChange={(e) => setCtx(e.target.value)}
              onBlur={() => ctx !== c.context && go(() => updateCalendar(c.id, { context: ctx }))}
            />
          </div>
          <div>
            <label className="label" htmlFor={`dest-${c.id}`}>
              Tasks go to
            </label>
            <select
              id={`dest-${c.id}`}
              className="input h-8 text-xs"
              value={c.defaultDestination}
              disabled={pending}
              onChange={(e) => go(() => updateCalendar(c.id, { defaultDestination: e.target.value as Cal["defaultDestination"] }))}
            >
              <option value="akiflow">Akiflow</option>
              <option value="linear">Linear</option>
            </select>
          </div>
          <button
            type="button"
            className="btn btn-danger-outline btn-sm"
            disabled={pending}
            onClick={() => confirm(`Remove ${c.name} and its synced events?`) && go(() => removeCalendar(c.id))}
          >
            <Trash2 /> Remove
          </button>
        </div>
      )}
    </div>
  );
}

// ── Adding one ──────────────────────────────────────────────────────────────

function GoogleAccountStep({ g, picked, setPicked }: { g: GoogleState; picked: Set<string>; setPicked: (s: Set<string>) => void }) {
  const [pending, go] = useAction();
  const [setup, setSetup] = useState(!g.oauthReady);
  const [client, setClient] = useState({ id: g.clientId, secret: "" });
  const insecure = g.redirectUri.startsWith("http:") && !/\/\/(localhost|127\.)/.test(g.redirectUri);

  if (g.kind === "account")
    return (
      <div className="space-y-3">
        <p className="text-[0.8125rem] text-success">
          ✓ Connected{g.email ? ` as ${g.email}` : ""}.{" "}
          {g.found?.length ? "Pick the calendars to sync." : ""}
        </p>
        {g.listError && <p className="text-xs text-danger">{g.listError}</p>}
        {g.found && g.found.length === 0 && <p className="text-xs text-muted-foreground">This account has no calendars Debrief can read.</p>}
        <div className="grid gap-1.5">
          {g.found?.map((c) => (
            <label key={c.id} className={`flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-[0.8125rem] ${c.added ? "opacity-60" : "cursor-pointer hover:bg-accent/50"}`}>
              <input
                type="checkbox"
                className="checkbox"
                disabled={!!c.added}
                checked={!!c.added || picked.has(c.id)}
                onChange={(e) => {
                  const s = new Set(picked);
                  if (e.target.checked) s.add(c.id);
                  else s.delete(c.id);
                  setPicked(s);
                }}
              />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-[0.6875rem] text-muted-foreground">{c.added === "ics" ? "already syncing by its ICS link" : c.added ? "already syncing" : c.primary ? "your main calendar" : ""}</span>
            </label>
          ))}
        </div>
        {!g.locked && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => confirm("Disconnect Google? Its calendars stop syncing until you connect again.") && go(() => disconnectGoogle())}>
            Disconnect Google
          </button>
        )}
      </div>
    );

  return (
    <div className="space-y-4">
      {setup ? (
        <>
          <p className="text-[0.8125rem] text-muted-foreground">
            Once only: Google needs to know about your Debrief. You make a small &ldquo;app&rdquo; in your own Google Cloud project, free, about five minutes. After
            that, connecting is one button.
          </p>
          <Steps>
            <li>
              <A href="https://console.cloud.google.com/projectcreate">Create a Google Cloud project</A>, named Debrief or anything you like, and make sure it&apos;s
              selected at the top of the page.
            </li>
            <li>
              <A href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Enable the Google Calendar API</A> for it.
            </li>
            <li>
              Open <A href="https://console.cloud.google.com/auth/overview">Google Auth Platform</A> → <b>Get started</b>. App name Debrief, your email for support and
              contact. For <b>Audience</b>:
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                <li>
                  <b className="text-foreground">Internal</b> if your account is a Google Workspace one (a company or own domain). Nothing more to do.
                </li>
                <li>
                  <b className="text-foreground">External</b> for a personal Gmail account. Then on the <b>Audience</b> page, choose <b>Publish app</b>: while an app is in
                  testing, Google signs it out every 7 days. Google will warn that the app isn&apos;t verified; that&apos;s expected for your own app.
                </li>
              </ul>
            </li>
            <li>
              Go to <A href="https://console.cloud.google.com/auth/clients">Clients</A> → <b>Create client</b> → <b>Web application</b>. Under{" "}
              <b>Authorized redirect URIs</b>, add exactly:
              <Code>{g.redirectUri}</Code>
              {insecure && (
                <span className="mt-1 block text-xs text-warning">
                  Google only accepts https:// addresses here. Open Debrief at its https:// address, or set it under Account → Advanced → Address.
                </span>
              )}
            </li>
            <li>Create it, then paste the client ID and secret it shows:</li>
          </Steps>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <input className="input h-8 font-mono text-xs" placeholder="Client ID: …apps.googleusercontent.com" aria-label="Client ID" value={client.id} onChange={(e) => setClient({ ...client, id: e.target.value })} />
            <input className="input h-8 font-mono text-xs" type="password" placeholder={g.oauthReady ? "Saved. Paste to replace" : "Client secret"} aria-label="Client secret" value={client.secret} onChange={(e) => setClient({ ...client, secret: e.target.value })} />
            <button type="button" className="btn btn-primary btn-sm" disabled={pending || !client.id || !client.secret} onClick={() => go(() => saveGoogleClient(client.id, client.secret), () => setSetup(false))}>
              Save
            </button>
          </div>
        </>
      ) : (
        <div className="grid justify-items-start gap-3">
          <p className="text-[0.8125rem] text-muted-foreground">Sign in with the Google account whose calendars you want. Debrief only asks to read them.</p>
          <a href="/api/google/connect" className="btn btn-primary">
            Connect Google
          </a>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSetup(true)}>
            Change the OAuth client
          </button>
        </div>
      )}
      <details className="group text-xs text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Or use the gcloud command line instead
        </summary>
        <div className="mt-2 space-y-2 pl-5">
          <p>On a computer with the Google Cloud CLI, run this and sign in:</p>
          <Code>gcloud auth application-default login --scopes=https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/cloud-platform</Code>
          <p>
            Then upload the file it saves, <code className="font-mono">application_default_credentials.json</code>, from <code className="font-mono">~/.config/gcloud/</code> (Mac)
            or <code className="font-mono">%APPDATA%\gcloud\</code> (Windows):
          </p>
          <KeyUpload />
        </div>
      </details>
    </div>
  );
}

function KeyUpload({ label = "Upload the .json file" }: { label?: string }) {
  const [pending, go] = useAction();
  return (
    <label className={`flex cursor-pointer items-center gap-2.5 rounded-xl border-[1.5px] border-dashed border-border px-4 py-3 text-xs text-muted-foreground hover:border-primary/50 ${pending ? "opacity-60" : ""}`}>
      <Upload className="size-4" />
      <b className="font-medium text-foreground">{label}</b>
      <input
        type="file"
        accept=".json,application/json"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) {
            const text = await file.text();
            go(() => saveGoogleKey(text));
          }
          e.target.value = "";
        }}
      />
    </label>
  );
}

function ServiceAccountStep({ g, id, setId, onChecked }: { g: GoogleState; id: string; setId: (v: string) => void; onChecked: (name: string | null) => void }) {
  return (
    <div className="space-y-4">
      <Steps>
        <li>
          In <A href="https://console.cloud.google.com/projectcreate">Google Cloud</A>, create a project (or pick one) and{" "}
          <A href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">enable the Google Calendar API</A>.
        </li>
        <li>
          Under <A href="https://console.cloud.google.com/iam-admin/serviceaccounts">Service accounts</A>, create one. It needs no roles. Open it →{" "}
          <b>Keys → Add key → Create new key → JSON</b>, and upload the file:
          <div className="mt-2">
            {g.kind === "service" ? (
              <p className="text-xs text-success">✓ Key uploaded for {g.email}.</p>
            ) : g.locked ? (
              <p className="text-xs text-muted-foreground">The Google credentials are set in the environment.</p>
            ) : (
              <KeyUpload label={g.kind === "account" ? "Upload a key (replaces the connected Google account)" : "Upload the key .json"} />
            )}
          </div>
        </li>
        <li>
          In Google Calendar on a computer, open the calendar&apos;s <b>Settings and sharing → Share with specific people</b>, and add{" "}
          {g.kind === "service" && g.email ? <Code>{g.email}</Code> : "the service account's address"} with <b>See all event details</b>.
        </li>
        <li>
          On the same page under <b>Integrate calendar</b>, copy the <b>Calendar ID</b> (for your main calendar it&apos;s your email address):
        </li>
      </Steps>
      <CheckInput source="google" value={id} setValue={setId} placeholder="you@company.com" onChecked={onChecked} disabled={g.kind !== "service"} />
    </div>
  );
}

function CheckInput({ source, value, setValue, placeholder, onChecked, disabled }: { source: "google" | "ics"; value: string; setValue: (v: string) => void; placeholder: string; onChecked: (name: string | null) => void; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <input
          className="input h-8 min-w-0 flex-1 font-mono text-xs"
          placeholder={placeholder}
          value={value}
          aria-label={source === "ics" ? "ICS link" : "Calendar ID"}
          onChange={(e) => {
            setValue(e.target.value);
            setResult(null);
          }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending || !value.trim() || disabled}
          onClick={() =>
            start(async () => {
              const r = await checkCalendarAction(source, value);
              setResult(r.ok ? { ok: true, text: r.message ?? "Can read it." } : { ok: false, text: r.error });
              if (r.ok) onChecked(r.name ?? null);
            })
          }
        >
          {pending ? "Checking…" : "Check"}
        </button>
      </div>
      {result && (
        <p className={`text-xs ${result.ok ? "text-success" : "text-danger"}`} role="status">
          {result.ok ? "✓ " : ""}
          {result.text}
        </p>
      )}
    </div>
  );
}

const ICS_HELP = {
  outlook: [
    <>In Outlook on the web: <b>Settings → Calendar → Shared calendars → Publish a calendar</b>.</>,
    <>Pick the calendar and <b>Can view all details</b>, then <b>Publish</b>.</>,
    <>Copy the <b>ICS</b> link (not the HTML one).</>,
  ],
  google: [
    <>In Google Calendar on a computer, open the calendar&apos;s <b>Settings and sharing</b>.</>,
    <>Under <b>Integrate calendar</b>, copy <b>Secret address in iCal format</b>.</>,
  ],
  icloud: [
    <>In the Calendar app, right-click the calendar → <b>Share Calendar…</b> → tick <b>Public Calendar</b>.</>,
    <>Copy the link. Debrief turns <code className="font-mono">webcal://</code> into https:// for you. Anyone with the link can read the calendar, so keep it to yourself.</>,
  ],
};

function IcsStep({ url, setUrl, onChecked }: { url: string; setUrl: (v: string) => void; onChecked: (name: string | null) => void }) {
  const [tab, setTab] = useState<keyof typeof ICS_HELP>("outlook");
  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-border" role="tablist">
        {(["outlook", "google", "icloud"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium ${tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t === "outlook" ? "Outlook" : t === "google" ? "Google" : "iCloud"}
          </button>
        ))}
      </div>
      <Steps>
        {ICS_HELP[tab].map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </Steps>
      <CheckInput source="ics" value={url} setValue={setUrl} placeholder="https://…/calendar.ics" onChecked={onChecked} />
      <p className="text-[0.6875rem] text-muted-foreground">ICS links update less often than a Google connection: Outlook&apos;s can lag by a few hours.</p>
    </div>
  );
}

function AddCalendar({
  g,
  contexts,
  initial,
  first,
  onClose,
  onDone,
}: {
  g: GoogleState;
  contexts: string[];
  initial: { step: 1 | 2; source: Source };
  first: boolean;
  onClose?: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, go] = useAction();
  const [step, setStep] = useState<1 | 2 | 3>(initial.step);
  const [source, setSource] = useState<Source>(initial.source);
  // Tick your main calendar only for a first calendar: after that, you pick what to add.
  const [picked, setPicked] = useState<Set<string>>(() => new Set(first ? (g.found?.filter((c) => c.primary && !c.added).map((c) => c.id) ?? []) : []));
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [ctx, setCtx] = useState(contexts[0] ?? "work");
  const [dest, setDest] = useState("akiflow");

  const list =
    source === "gme"
      ? (g.found ?? []).filter((c) => picked.has(c.id) && !c.added).map((c) => ({ source: "google" as const, externalId: c.id, name: c.name }))
      : [{ source: source === "ics" ? ("ics" as const) : ("google" as const), externalId: id.trim(), name: name.trim() }];
  const ready = source === "gme" ? g.kind === "account" && list.length > 0 : !!id.trim() && (source === "ics" || g.kind === "service");
  const labels = ["Where it lives", "Connect", "Name it"];

  return (
    <section className="card overflow-hidden">
      <ol className="flex border-b border-border bg-surface/50">
        {labels.map((l, i) => {
          const n = i + 1;
          return (
            <li key={l} className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-xs font-medium sm:px-4 ${n === step ? "text-foreground" : "text-muted-foreground"}`}>
              <span
                className={`grid size-5 shrink-0 place-items-center rounded-full text-[0.625rem] ${
                  n < step ? "bg-success text-white" : n === step ? "bg-primary text-primary-foreground" : "ring-[1.5px] ring-border ring-inset"
                }`}
              >
                {n < step ? <Check className="size-3" strokeWidth={3} /> : n}
              </span>
              <span className="truncate">{l}</span>
            </li>
          );
        })}
      </ol>
      <div className="space-y-4 p-4">
        {step === 1 && (
          <>
            <p className="text-sm font-semibold">Which calendar do you want to add?</p>
            <Tiles
              label="Calendar type"
              value={source}
              onChange={(v) => setSource(v as Source)}
              options={[
                { value: "gme", title: "Google, sign in", detail: g.oauthReady ? "One click. Sees every calendar you can." : "One click after a five-minute setup. Sees every calendar you can." },
                { value: "gsa", title: "Google, service account", detail: "For calendars you share with it, one at a time." },
                { value: "ics", title: "Outlook, iCloud or other", detail: "Any calendar with a private ICS link. Nothing to set up." },
              ]}
            />
          </>
        )}
        {step === 2 && (
          <>
            <p className="text-sm font-semibold">{source === "gme" ? "Connect your Google account" : source === "gsa" ? "Connect with a service account" : "Paste the calendar's private link"}</p>
            {source === "gme" && <GoogleAccountStep g={g} picked={picked} setPicked={setPicked} />}
            {source === "gsa" && <ServiceAccountStep g={g} id={id} setId={setId} onChecked={(n) => n && !name && setName(n)} />}
            {source === "ics" && <IcsStep url={id} setUrl={setId} onChecked={(n) => n && !name && setName(n)} />}
          </>
        )}
        {step === 3 && (
          <>
            <p className="text-sm font-semibold">{list.length > 1 ? `Name them: ${list.length} calendars` : "Name it, and say where its tasks go"}</p>
            <div className="card divide-y divide-border overflow-hidden">
              {list.length === 1 && (
                <Row label="Name">
                  <input className="input h-8 text-xs" value={list[0].name || name} placeholder={source === "ics" ? "Client calendar" : list[0].externalId} onChange={(e) => setName(e.target.value)} />
                </Row>
              )}
              <Row label="Context" help="A short word like work or side. Meetings from it get its color, and the sidebar can show just them.">
                <input className="input h-8 text-xs" value={ctx} list="cal-contexts" onChange={(e) => setCtx(e.target.value)} />
              </Row>
              <Row label="Tasks go to" help="The default for its meetings' action items. You can change any task.">
                <select className="input h-8 text-xs" value={dest} onChange={(e) => setDest(e.target.value)}>
                  <option value="akiflow">Akiflow</option>
                  <option value="linear">Linear</option>
                </select>
              </Row>
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {step === 1 && <span className="mr-auto text-xs text-muted-foreground">Not sure? An ICS link works for Google too, and takes a minute.</span>}
          {step === 3 && <span className="mr-auto text-xs text-muted-foreground">The first sync starts straight away and takes about a minute.</span>}
          {onClose && step === 1 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
          )}
          {step > 1 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep((step - 1) as 1 | 2)}>
              Back
            </button>
          )}
          {step < 3 ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={step === 2 && !ready} onClick={() => setStep((step + 1) as 2 | 3)}>
              Next
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending}
              onClick={() =>
                go(
                  () => addCalendars(list.length === 1 ? [{ ...list[0], name: list[0].name || name }] : list, ctx, dest),
                  () => {
                    // Close even when this was the first calendar (no Cancel then), so the list and "Add a calendar" show.
                    onDone();
                    router.replace("/settings/calendars");
                  }
                )
              }
            >
              Add and sync
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] md:items-center md:gap-6">
      <div>
        <p className="text-[0.8125rem] font-medium">{label}</p>
        {help && <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{help}</p>}
      </div>
      {children}
    </div>
  );
}

export function CalendarSettings({ calendars, contexts, google, flash }: { calendars: Cal[]; contexts: string[]; google: GoogleState; flash: { add: boolean; connected: string | null; error: string | null } }) {
  const [pending, go] = useAction();
  const [adding, setAdding] = useState(flash.add || calendars.length === 0);
  const on = calendars.filter((c) => c.enabled).length;
  return (
    <div className="space-y-6">
      <datalist id="cal-contexts">
        {contexts.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {flash.error && <p className="rounded-xl border border-danger/40 bg-danger/5 px-4 py-3 text-xs text-danger">{flash.error}</p>}

      {calendars.length > 0 && (
        <div className="space-y-2">
          <SectionLabel name="Your calendars" note={on ? `${on} syncing, checked every few minutes. Turn one off to hide its meetings.` : "None are syncing."} />
          <section className="card divide-y divide-border overflow-hidden">
            {calendars.map((c) => (
              <CalendarRow key={c.id} c={c} contexts={contexts} />
            ))}
          </section>
          {!adding && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
                <Plus /> Add a calendar
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => go(() => syncCalendarsNow())}>
                <RefreshCw className={pending ? "animate-spin" : ""} /> Sync now
              </button>
            </div>
          )}
        </div>
      )}

      {adding && (
        <div className="space-y-2">
          <SectionLabel name="Add a calendar" />
          <AddCalendar
            g={google}
            contexts={contexts}
            initial={flash.add && (flash.connected || flash.error) ? { step: 2, source: "gme" } : { step: 1, source: "gme" }}
            onClose={calendars.length ? () => setAdding(false) : undefined}
            first={calendars.length === 0}
            onDone={() => setAdding(false)}
          />
        </div>
      )}
    </div>
  );
}
