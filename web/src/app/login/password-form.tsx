"use client";

import { useActionState } from "react";
import { LoaderCircle } from "lucide-react";
import { signInWithPassword } from "@/actions/session";

export function PasswordForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, action, pending] = useActionState(signInWithPassword, null);
  return (
    <form action={action}>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <label className="label" htmlFor="pw">
        Password
      </label>
      <input id="pw" name="password" className="input" type="password" autoComplete="current-password" autoFocus required />
      <button className="btn btn-primary mt-5 w-full" disabled={pending}>
        {pending ? <LoaderCircle className="animate-spin" /> : null}
        Sign in
      </button>
      {state?.error ? <p className="mt-3 text-center text-xs text-danger">{state.error}</p> : null}
    </form>
  );
}
