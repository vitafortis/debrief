import type { Metadata } from "next";
import { KeyRound } from "lucide-react";
import { Logo } from "@/components/logo";
import { authMode, oidcName } from "@/lib/auth";
import { signInWithOidc } from "@/actions/session";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string; error?: string }> }) {
  const { callbackUrl = "/", error } = await searchParams;
  const mode = authMode();
  const passwordSet = !!process.env.DEBRIEF_PASSWORD;
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
      <div className="dot-grid mask-fade pointer-events-none absolute inset-0 opacity-70" />
      <div className="glow-top pointer-events-none absolute inset-x-0 top-0 h-[480px]" />
      <div className="card relative w-full max-w-sm p-7 shadow-surface-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={44} />
          <h1 className="mt-4 text-lg font-semibold tracking-tight">Debrief</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">Sign in to your meetings.</p>
        </div>
        {mode === "oidc" ? (
          <form action={signInWithOidc}>
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <button className="btn btn-primary w-full">
              <KeyRound />
              Continue with {oidcName()}
            </button>
            {error ? (
              <p className="mt-3 text-center text-xs text-danger">
                {error === "AccessDenied" ? "That account isn't allowed in (ALLOWED_EMAILS)." : "Sign-in didn't finish. Try again."}
              </p>
            ) : null}
          </form>
        ) : passwordSet ? (
          <PasswordForm callbackUrl={callbackUrl} />
        ) : (
          <p className="rounded-lg bg-surface px-3 py-2.5 text-center text-xs text-muted-foreground">
            No sign-in is set up. Set <code className="font-mono">AUTH_OIDC_ISSUER</code> for Authentik, or{" "}
            <code className="font-mono">DEBRIEF_PASSWORD</code>, and restart.
          </p>
        )}
      </div>
    </div>
  );
}
