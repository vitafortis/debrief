"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { changePassword } from "@/actions/settings";
import { useAction } from "@/components/task-item";

export function PasswordCard({ fromEnv }: { fromEnv: boolean }) {
  const [pending, go] = useAction();
  const [pw, setPw] = useState("");
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Password</h2>
        <p className="text-xs text-muted-foreground">The owner password. Only a hash of it is kept.</p>
      </div>
      {fromEnv ? (
        <p className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
          <Lock className="size-3.5" /> Set by DEBRIEF_PASSWORD in the environment. Remove it from .env to change it here.
        </p>
      ) : (
        <form
          className="flex flex-wrap gap-2 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            go(() => changePassword(pw), () => setPw(""));
          }}
        >
          <input
            className="input h-8 min-w-0 flex-1 text-xs"
            type="password"
            autoComplete="new-password"
            placeholder="New password (8 characters or more)"
            aria-label="New password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            minLength={8}
            required
          />
          <button className="btn btn-primary btn-sm" disabled={pending || pw.length < 8}>
            Change password
          </button>
        </form>
      )}
    </section>
  );
}
