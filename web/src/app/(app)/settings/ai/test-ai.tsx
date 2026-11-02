"use client";

import { useState, useTransition } from "react";
import { Check, Copy } from "lucide-react";
import { testAiAction } from "@/actions/settings";

/** Sends a one-line prompt with what's saved, and says how it went. */
export function TestAi() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setResult(null);
            const r = await testAiAction();
            setResult(r.ok ? { ok: true, text: r.message ?? "Connected." } : { ok: false, text: r.error });
          })
        }
      >
        {pending ? "Testing…" : "Test connection"}
      </button>
      <span className={`min-w-0 text-xs ${result ? (result.ok ? "text-success" : "text-danger") : "text-muted-foreground"}`} role="status">
        {result ? result.text : "Sends a one-line prompt with what's saved."}
      </span>
    </>
  );
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <input className="input h-8 min-w-0 flex-1 font-mono text-xs text-muted-foreground" value={value} readOnly onFocus={(e) => e.target.select()} aria-label="Address" />
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
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
    </div>
  );
}
