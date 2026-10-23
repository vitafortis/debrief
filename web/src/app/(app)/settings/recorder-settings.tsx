"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, Laptop, Trash2 } from "lucide-react";
import { createKey, deleteKey, updateDevice } from "@/actions/settings";
import { useAction } from "@/components/task-item";

type Key = { id: string; name: string; prefix: string; created: string; lastUsed: string | null };

/** Keys for the desktop recorder and for Claude. Each is shown once, when it's made. */
export function ApiKeys({ keys, publicUrl }: { keys: Key[]; publicUrl: string }) {
  const [pending, go] = useAction();
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">API keys</h2>
        <p className="text-xs text-muted-foreground">
          For the Debrief Recorder on each computer, and for Claude (the MCP server). Give each device its own, so one can be revoked alone.
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2 border-b border-border px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          go(
            async () => {
              const r = await createKey(name);
              if (r.ok && r.key) setMade({ name, key: r.key });
              return r;
            },
            () => setName("")
          );
        }}
      >
        <input
          className="input h-8 min-w-0 flex-1 text-xs"
          placeholder="Work MacBook, Claude Desktop…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Key name"
        />
        <button className="btn btn-primary btn-sm" disabled={pending || !name.trim()}>
          <KeyRound /> Create key
        </button>
      </form>
      {made && (
        <div className="space-y-2 border-b border-border bg-primary/5 px-4 py-3">
          <p className="text-xs font-medium">
            Key for {made.name}. Copy it now; it isn&apos;t shown again.
          </p>
          <div className="flex gap-2">
            <code className="input flex h-8 min-w-0 flex-1 items-center overflow-x-auto font-mono text-[0.6875rem] whitespace-nowrap select-all">{made.key}</code>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(made.key);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">
            In the recorder: Settings → Server <code className="font-mono">{publicUrl}</code> and this key. For Claude, send it as the bearer token to{" "}
            <code className="font-mono">{publicUrl}/mcp</code>.
          </p>
        </div>
      )}
      {keys.length ? (
        <div className="divide-y divide-border">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-3 px-4 py-2.5">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] font-medium">{k.name}</p>
                <p className="font-mono text-[0.6875rem] text-muted-foreground">
                  {k.prefix}… · made {k.created} · {k.lastUsed ? `used ${k.lastUsed}` : "never used"}
                </p>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                title="Revoke"
                disabled={pending}
                onClick={() => confirm(`Revoke "${k.name}"? Whatever uses it stops working.`) && go(() => deleteKey(k.id))}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">No keys yet.</p>
      )}
    </section>
  );
}

type Device = { name: string; context: string | null; defaultDestination: "akiflow" | "linear" | null; recordings: number; lastActive: string | null };

function DeviceRow({ d, contexts }: { d: Device; contexts: string[] }) {
  const [pending, go] = useAction();
  const [ctx, setCtx] = useState(d.context ?? "");
  const options = [...new Set([...contexts, ...(d.context ? [d.context] : [])])];
  return (
    <div className="grid items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_10rem_8rem]">
      <div className="flex min-w-0 items-center gap-3">
        <Laptop className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate font-mono text-[0.8125rem]">{d.name}</p>
          <p className="text-[0.6875rem] text-muted-foreground">
            {d.recordings} recording{d.recordings === 1 ? "" : "s"}
            {d.lastActive ? ` · last ${d.lastActive}` : ""}
          </p>
        </div>
      </div>
      <div>
        <label className="label md:hidden">Context</label>
        <select
          className="input h-8 text-xs"
          value={ctx}
          disabled={pending}
          aria-label={`Context for ${d.name}`}
          onChange={(e) => {
            const v = e.target.value;
            setCtx(v);
            go(async () => {
              const r = await updateDevice(d.name, { context: v || null });
              if (!r.ok) setCtx(d.context ?? "");
              return r;
            });
          }}
        >
          <option value="">Don&apos;t tag</option>
          {options.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label md:hidden">Tasks go to</label>
        <select
          className="input h-8 text-xs"
          value={d.defaultDestination ?? ""}
          disabled={pending || !ctx}
          aria-label={`Tasks from ${d.name} go to`}
          onChange={(e) => go(() => updateDevice(d.name, { defaultDestination: (e.target.value || null) as Device["defaultDestination"] }))}
        >
          <option value="">Akiflow</option>
          <option value="linear">Linear</option>
        </select>
      </div>
    </div>
  );
}

/** Per-device tagging: off until a context is picked, and only used when a meeting has no calendar event. */
export function DeviceSettings({ devices, contexts }: { devices: Device[]; contexts: string[] }) {
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Devices</h2>
        <p className="text-xs text-muted-foreground">
          Computers recordings came from. Nothing is tagged by device unless you pick a context here, and a meeting&apos;s calendar event always wins; this
          covers calls with no event.
        </p>
      </div>
      {devices.length ? (
        <div className="divide-y divide-border">
          <div className="hidden grid-cols-[minmax(0,1fr)_10rem_8rem] gap-3 px-4 py-2 text-[0.6875rem] font-medium text-muted-foreground md:grid">
            <span className="pl-7">Device</span>
            <span>Context</span>
            <span>Tasks go to</span>
          </div>
          {devices.map((d) => (
            <DeviceRow key={d.name} d={d} contexts={contexts} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">Devices show up here after their first recording.</p>
      )}
    </section>
  );
}
