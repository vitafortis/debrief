"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { changePassword } from "@/actions/settings";
import { useAction } from "@/components/task-item";
import { SectionLabel } from "./settings-form";

export function PasswordCard({ fromEnv }: { fromEnv: boolean }) {
  const [pending, go] = useAction();
  const [pw, setPw] = useState("");
  return (
    <div className="space-y-2 pb-4">
      <SectionLabel name="Sign-in" />
      <section className="card grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] md:items-center md:gap-6">
        <div>
          <p className="text-[0.8125rem] font-medium">Password</p>
          <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">The owner password. Only a hash of it is kept.</p>
        </div>
        {fromEnv ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lock className="size-3.5" /> Set by DEBRIEF_PASSWORD in the environment.
          </p>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              go(() => changePassword(pw), () => setPw(""));
            }}
          >
            <input
              className="input h-8 min-w-0 flex-1 text-xs"
              type="password"
              autoComplete="new-password"
              placeholder="New password, 8+ characters"
              aria-label="New password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              minLength={8}
              required
            />
            <button className="btn btn-secondary btn-sm" disabled={pending || pw.length < 8}>
              Change
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
