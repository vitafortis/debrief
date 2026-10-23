import type { Metadata } from "next";
import { KeyRound } from "lucide-react";
import { ownerPasswordSet } from "@debrief/core/settings";
import { AuthCard } from "@/components/auth-card";
import { oidcEnabled, oidcName, viewer } from "@/lib/auth";
import { signInWithOidc } from "@/actions/session";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string; error?: string }> }) {
  const { callbackUrl = "/", error } = await searchParams;
  await viewer(); // loads the current settings
  const oidc = oidcEnabled();
  const password = ownerPasswordSet();
  return (
    <AuthCard title="Sign in to your meetings.">
      {oidc ? (
        <form action={signInWithOidc}>
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <button className="btn btn-primary w-full">
            <KeyRound />
            Continue with {oidcName()}
          </button>
          {error ? (
            <p className="mt-3 text-center text-xs text-danger">
              {error === "AccessDenied" ? "That account isn't on the allowed list." : "Sign-in didn't finish. Try again."}
            </p>
          ) : null}
        </form>
      ) : null}
      {oidc && password ? (
        <details className="mt-5 text-center">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Use the password instead</summary>
          <div className="mt-4 text-left">
            <PasswordForm callbackUrl={callbackUrl} autoFocus={false} />
          </div>
        </details>
      ) : password ? (
        <PasswordForm callbackUrl={callbackUrl} />
      ) : null}
    </AuthCard>
  );
}
