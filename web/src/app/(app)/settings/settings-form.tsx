"use client";

import { useState } from "react";
import { Lock, Upload } from "lucide-react";
import type { SettingDef } from "@debrief/core/settings";
import { saveSettingsAction } from "@/actions/settings";
import { useAction } from "@/components/task-item";

export type Field = SettingDef & { value: string; isSet: boolean; source: "env" | "saved" | "default" };

/** A card of settings from the registry. Secrets are write-only: blank keeps what's saved. */
export function SettingsForm({ title, description, fields, footer }: { title: string; description?: React.ReactNode; fields: Field[]; footer?: React.ReactNode }) {
  const [pending, go] = useAction();
  const initial = Object.fromEntries(fields.map((f) => [f.key, f.type === "secret" || f.type === "textarea" ? "" : f.value]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const set = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));
  const current = (key: string) => values[key] ?? fields.find((f) => f.key === key)?.value ?? "";
  const shown = fields.filter((f) => !f.when || f.when.is.includes(current(f.when.key)));
  const dirty = fields.some((f) => values[f.key] !== initial[f.key]) || cleared.size > 0;

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <form
        className="divide-y divide-border"
        onSubmit={(e) => {
          e.preventDefault();
          const out: Record<string, string | null> = {};
          for (const f of fields) {
            if (f.source === "env") continue;
            if (cleared.has(f.key)) out[f.key] = null;
            else if (values[f.key] !== initial[f.key]) out[f.key] = values[f.key];
          }
          go(() => saveSettingsAction(out), () => setCleared(new Set()));
        }}
      >
        {shown.map((f) => (
          <FieldRow
            key={f.key}
            f={f}
            value={values[f.key] ?? ""}
            cleared={cleared.has(f.key)}
            onChange={(v) => set(f.key, v)}
            onClear={() => setCleared((s) => new Set(s).add(f.key))}
          />
        ))}
        <div className="flex flex-wrap items-center justify-end gap-2 bg-surface/50 px-4 py-3">
          {footer}
          <button className="btn btn-primary btn-sm" disabled={pending || !dirty}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}

function FieldRow({ f, value, cleared, onChange, onClear }: { f: Field; value: string; cleared: boolean; onChange: (v: string) => void; onClear: () => void }) {
  const id = `s-${f.key}`;
  const locked = f.source === "env";
  const secret = f.type === "secret" || f.type === "textarea";
  const placeholder = secret && f.isSet && !cleared ? "Saved. Type to replace it." : f.placeholder ?? f.default ?? "";
  return (
    <div className="grid gap-2 px-4 py-3 md:grid-cols-[16rem_minmax(0,1fr)] md:gap-6">
      <div>
        <label htmlFor={id} className="text-[0.8125rem] font-medium">
          {f.label}
        </label>
        {f.help && <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{f.help}</p>}
      </div>
      <div className="min-w-0">
        {locked ? (
          <div className="flex items-center gap-2">
            <span className="input flex h-8 min-w-0 flex-1 items-center truncate text-xs text-muted-foreground">{secret ? "••••••••" : f.value}</span>
            <span className="badge shrink-0" title={`Set by ${f.key} in the environment. Remove it from .env to change it here.`}>
              <Lock /> .env
            </span>
          </div>
        ) : f.type === "bool" ? (
          <label className="flex h-8 items-center gap-2 text-xs">
            <input id={id} type="checkbox" className="checkbox" checked={/^(1|true|yes|on)$/i.test(value)} onChange={(e) => onChange(e.target.checked ? "true" : "false")} />
            {/^(1|true|yes|on)$/i.test(value) ? "On" : "Off"}
          </label>
        ) : f.type === "select" ? (
          <select id={id} className="input h-8 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : f.type === "textarea" ? (
          <div className="space-y-2">
            <textarea id={id} className="input min-h-24 py-2 font-mono text-[0.6875rem]" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
            <div className="flex items-center gap-2">
              <label className="btn btn-secondary btn-sm cursor-pointer">
                <Upload /> Choose file
                <input
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) onChange(await file.text());
                  }}
                />
              </label>
              {f.isSet && !cleared && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              id={id}
              className="input h-8 min-w-0 flex-1 text-xs"
              type={f.type === "secret" ? "password" : f.type === "number" ? "number" : "text"}
              step={f.type === "number" ? "any" : undefined}
              autoComplete="off"
              placeholder={placeholder}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
            {f.type === "secret" && f.isSet && !cleared && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
                Remove
              </button>
            )}
          </div>
        )}
        {cleared && <p className="mt-1 text-[0.6875rem] text-warning">Removed when you save.</p>}
      </div>
    </div>
  );
}
