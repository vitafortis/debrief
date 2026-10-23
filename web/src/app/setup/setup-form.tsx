"use client";

import { useActionState } from "react";
import { LoaderCircle } from "lucide-react";
import { finishSetup } from "@/actions/session";

export function SetupForm({ address }: { address: string }) {
  const [state, action, pending] = useActionState(finishSetup, null);
  return (
    <form action={action} className="space-y-4">
      <div>
        <label className="label" htmlFor="name">
          Your name
        </label>
        <input id="name" name="name" className="input" autoComplete="name" autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="pw">
          Password
        </label>
        <input id="pw" name="password" className="input" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      <div>
        <label className="label" htmlFor="tz">
          Time zone
        </label>
        <input id="tz" name="tz" className="input" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} suppressHydrationWarning />
      </div>
      <input type="hidden" name="address" value={address} />
      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? <LoaderCircle className="animate-spin" /> : null}
        Start using Debrief
      </button>
      {state?.error ? <p className="text-center text-xs text-danger">{state.error}</p> : null}
    </form>
  );
}
