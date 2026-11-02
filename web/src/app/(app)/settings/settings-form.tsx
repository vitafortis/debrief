"use client";

import { useState } from "react";
import { ChevronRight, Lock, Upload } from "lucide-react";
import type { SettingDef } from "@debrief/core/settings";
import { saveSettingsAction } from "@/actions/settings";
import { useAction } from "@/components/task-item";
import { Switch, Tiles } from "./ui";

export type Field = SettingDef & { value: string; isSet: boolean; source: "env" | "saved" | "default" };

/** What a page adds around one section: a note above, controls inside the card's foot, a card after. */
export type Slot = { note?: React.ReactNode; badge?: React.ReactNode; footer?: React.ReactNode; after?: React.ReactNode; before?: React.ReactNode };

const truthy = (v: string) => /^(1|true|yes|on)$/i.test(v);
const hourLabel = (h: number) => (h % 24 === 0 ? (h ? "Midnight" : "12 AM") : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`);

/**
 * A page of settings from the registry, grouped by section, with anything
 * marked advanced folded away and one save bar that shows when something
 * changed. Secrets are write-only: blank keeps what's saved.
 */
export function SettingsForm({
  fields,
  slots = {},
  connect = [],
}: {
  fields: Field[];
  slots?: Record<string, Slot>;
  /** Sections shown as one line with Connect until opened or set: Slack, Akiflow, Linear. */
  connect?: string[];
}) {
  const [pending, go] = useAction();
  const initial = Object.fromEntries(fields.map((f) => [f.key, f.type === "secret" || f.type === "textarea" ? "" : f.value]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const set = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));
  const current = (key: string) => values[key] ?? fields.find((f) => f.key === key)?.value ?? "";
  const shown = fields.filter((f) => !f.when || f.when.is.includes(current(f.when.key)));
  const dirty = fields.some((f) => values[f.key] !== initial[f.key]) || cleared.size > 0;

  const sections: { name: string; fields: Field[] }[] = [];
  for (const f of shown.filter((f) => !f.advanced)) {
    const name = f.section ?? "";
    const s = sections.find((x) => x.name === name) ?? sections[sections.push({ name, fields: [] }) - 1];
    s.fields.push(f);
  }
  const advanced = shown.filter((f) => f.advanced);

  const save = () => {
    const out: Record<string, string | null> = {};
    for (const f of fields) {
      if (f.source === "env") continue;
      if (cleared.has(f.key)) out[f.key] = null;
      else if (values[f.key] !== initial[f.key]) out[f.key] = values[f.key];
    }
    go(() => saveSettingsAction(out), () => setCleared(new Set()));
  };
  const discard = () => {
    setValues(initial);
    setCleared(new Set());
  };

  const rows = (list: Field[]) => {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const props = (x: Field) => ({ f: x, value: values[x.key] ?? "", cleared: cleared.has(x.key), onChange: (v: string) => set(x.key, v), onClear: () => setCleared((s) => new Set(s).add(x.key)) });
      // Two hours in a row (working hours) share one line: "8 AM to 6 PM".
      if (f.display === "hour" && list[i + 1]?.display === "hour") {
        out.push(<HourPair key={f.key} a={props(f)} b={props(list[i + 1])} />);
        i++;
      } else out.push(<FieldRow key={f.key} {...props(f)} />);
    }
    return out;
  };

  return (
    <div className="space-y-6">
      {sections.map((s) => {
        const slot = slots[s.name] ?? {};
        const tiles = s.fields.length === 1 && s.fields[0].display === "tiles" ? s.fields[0] : null;
        const isConnect = connect.includes(s.name);
        const connected = s.fields.some((f) => f.isSet && (f.type === "secret" || f.source !== "default"));
        const open = !isConnect || connected || opened.has(s.name);
        return (
          <div key={s.name || "main"} className="space-y-2">
            {slot.before}
            {isConnect ? (
              <section className="card overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  {slot.badge}
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.8125rem] font-semibold">{s.name}</p>
                    {slot.note && <p className="text-xs text-muted-foreground">{slot.note}</p>}
                  </div>
                  {connected ? (
                    <span className="badge badge-success">Connected</span>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpened((o) => (o.has(s.name) ? new Set([...o].filter((x) => x !== s.name)) : new Set(o).add(s.name)))}>
                      {open ? "Cancel" : "Connect"}
                    </button>
                  )}
                </div>
                {open && <div className="divide-y divide-border border-t border-border">{rows(s.fields)}</div>}
                {open && slot.footer && <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">{slot.footer}</div>}
              </section>
            ) : (
              <>
                {(s.name || slot.note) && <SectionLabel name={s.name} note={slot.note} />}
                {tiles ? (
                  <TileField f={tiles} value={values[tiles.key] ?? ""} onChange={(v) => set(tiles.key, v)} />
                ) : (
                  <section className="card overflow-hidden">
                    <div className="divide-y divide-border">{rows(s.fields)}</div>
                    {slot.footer && <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">{slot.footer}</div>}
                  </section>
                )}
              </>
            )}
            {slot.after}
          </div>
        );
      })}

      {advanced.length > 0 && (
        <details className="group card overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Advanced
          </summary>
          <div className="divide-y divide-border border-t border-border bg-surface/40">{rows(advanced)}</div>
        </details>
      )}

      <div
        className={`sticky bottom-16 z-20 flex items-center gap-2 rounded-xl border border-border bg-card/95 px-4 py-2.5 shadow-lg backdrop-blur transition md:bottom-4 ${
          dirty ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
        }`}
        aria-hidden={!dirty}
      >
        <span className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
          <i className="size-1.5 rounded-full bg-warning" /> Unsaved changes
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={pending || !dirty}>
          Discard
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={pending || !dirty}>
          Save
        </button>
      </div>
    </div>
  );
}

export function SectionLabel({ name, note }: { name?: string; note?: React.ReactNode }) {
  return (
    <div className="px-0.5">
      {name && <h2 className="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">{name}</h2>}
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

type RowProps = { f: Field; value: string; cleared: boolean; onChange: (v: string) => void; onClear: () => void };

function Label({ f, id, label }: { f: Field; id: string; label?: string }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-[0.8125rem] font-medium">
        {label ?? f.label}
      </label>
      {f.help && <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{f.help}</p>}
    </div>
  );
}

function Locked({ f }: { f: Field }) {
  const secret = f.type === "secret" || f.type === "textarea";
  const shown = f.type === "select" ? (f.options?.find((o) => o.value === f.value)?.label ?? f.value) : f.value;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="input flex h-8 min-w-0 flex-1 items-center truncate text-xs text-muted-foreground">{secret ? "••••••••" : shown}</span>
      <span className="badge shrink-0" title={`Set by ${f.key} in the environment. Remove it from .env to change it here.`}>
        <Lock /> .env
      </span>
    </div>
  );
}

function FieldRow({ f, value, cleared, onChange, onClear }: RowProps) {
  const id = `s-${f.key}`;
  const locked = f.source === "env";
  if (f.type === "bool" && !locked)
    return (
      <div className="flex items-center gap-4 px-4 py-3">
        <div className="flex-1">
          <Label f={f} id={id} />
        </div>
        <Switch id={id} checked={truthy(value)} onChange={(on) => onChange(on ? "true" : "false")} label={f.label} />
      </div>
    );
  return (
    <div className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] md:items-center md:gap-6">
      <Label f={f} id={id} />
      <div className="min-w-0">
        {locked ? <Locked f={f} /> : <Control f={f} id={id} value={value} cleared={cleared} onChange={onChange} onClear={onClear} />}
        {cleared && <p className="mt-1 text-[0.6875rem] text-warning">Removed when you save.</p>}
      </div>
    </div>
  );
}

function HourPair({ a, b }: { a: RowProps; b: RowProps }) {
  const id = `s-${a.f.key}`;
  const select = (p: RowProps, from: number, to: number, label: string) =>
    p.f.source === "env" ? (
      <Locked f={p.f} />
    ) : (
      <select id={`s-${p.f.key}`} className="input h-8 min-w-0 flex-1 text-xs" value={p.value} onChange={(e) => p.onChange(e.target.value)} aria-label={label}>
        {Array.from({ length: to - from + 1 }, (_, i) => from + i).map((h) => (
          <option key={h} value={String(h)}>
            {hourLabel(h)}
          </option>
        ))}
      </select>
    );
  return (
    <div className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] md:items-center md:gap-6">
      <Label f={a.f} id={id} label={a.f.label.replace(/ start$/, "")} />
      <div className="flex items-center gap-2">
        {select(a, 0, 23, "Start")}
        <span className="text-xs text-muted-foreground">to</span>
        {select(b, 1, 24, "End")}
      </div>
    </div>
  );
}

let zones: string[] | null = null;
function timeZones() {
  try {
    zones ??= Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return zones;
}

function Control({ f, id, value, cleared, onChange, onClear }: { f: Field; id: string; value: string; cleared: boolean; onChange: (v: string) => void; onClear: () => void }) {
  const secret = f.type === "secret" || f.type === "textarea";
  const placeholder = secret && f.isSet && !cleared ? "Saved. Type to replace it." : (f.placeholder ?? f.default ?? "");
  if (f.type === "select") {
    const options = f.options ?? [];
    return (
      <select id={id} className="input h-8 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
        {!options.some((o) => o.value === value) && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (f.type === "textarea")
    return (
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
    );
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        className={`input h-8 min-w-0 flex-1 text-xs ${f.type === "secret" || /URL|BASE|MODEL/.test(f.key) ? "font-mono" : ""}`}
        type={f.type === "secret" ? "password" : f.type === "number" ? "number" : "text"}
        step={f.type === "number" ? "any" : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        list={f.key === "TZ" ? "time-zones" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {f.key === "TZ" && (
        <datalist id="time-zones">
          {timeZones().map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      )}
      {f.type === "secret" && f.isSet && !cleared && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
          Remove
        </button>
      )}
    </div>
  );
}

function TileField({ f, value, onChange }: { f: Field; value: string; onChange: (v: string) => void }) {
  const options = f.options ?? [];
  // A value from .env or an older version that isn't one of the tiles still shows, as its own tile.
  const all = options.some((o) => o.value === value) ? options : [...options, { value, label: value, detail: "Set by name" }];
  return (
    <div className="space-y-1.5">
      <Tiles label={f.label} value={value} onChange={onChange} disabled={f.source === "env"} options={all.map((o) => ({ value: o.value, title: o.label, detail: o.detail }))} />
      {f.source === "env" && (
        <p className="flex items-center gap-1.5 px-0.5 text-[0.6875rem] text-muted-foreground">
          <Lock className="size-3" /> Set by {f.key} in the environment.
        </p>
      )}
      {f.help && f.source !== "env" && <p className="px-0.5 text-[0.6875rem] text-muted-foreground">{f.help}</p>}
    </div>
  );
}
