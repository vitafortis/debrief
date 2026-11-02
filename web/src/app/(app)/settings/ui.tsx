"use client";

import { Check } from "lucide-react";

export function Switch({ id, checked, onChange, label, disabled }: { id?: string; checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-input"
      }`}
    >
      <span className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

export type TileOption = { value: string; title: string; detail?: string; mark?: React.ReactNode };

/** A few choices as cards, one picked: a radio group. */
export function Tiles({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (v: string) => void; options: TileOption[]; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9.5rem),1fr))] gap-2">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled && !on}
            onClick={() => !disabled && onChange(o.value)}
            className={`relative grid content-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
              on ? "border-primary bg-primary-soft ring-1 ring-primary" : "border-border bg-card hover:border-primary/40"
            }`}
          >
            {on && (
              <span className="absolute top-2 right-2 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-2.5" strokeWidth={3} />
              </span>
            )}
            {o.mark}
            <span className="pr-5 text-[0.8125rem] font-semibold">{o.title}</span>
            {o.detail && <span className="text-[0.6875rem] leading-snug text-muted-foreground">{o.detail}</span>}
          </button>
        );
      })}
    </div>
  );
}

export type Status = "ok" | "need" | "off";

export function StatusDot({ s, className = "" }: { s: Status; className?: string }) {
  return (
    <i
      className={`inline-block size-2 shrink-0 rounded-full ${s === "ok" ? "bg-success" : s === "need" ? "bg-warning" : "ring-[1.5px] ring-border ring-inset"} ${className}`}
      aria-label={s === "ok" ? "Working" : s === "need" ? "Needs you" : "Not set up"}
    />
  );
}

export function PageHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-semibold tracking-tight text-balance">{title}</h2>
      {children && <p className="mt-1 max-w-prose text-[0.8125rem] text-muted-foreground">{children}</p>}
    </div>
  );
}
