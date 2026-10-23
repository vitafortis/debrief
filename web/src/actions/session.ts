"use server";

import { AuthError } from "next-auth";
import { ownerPasswordSet, refreshSettings, saveSettings, setOwnerPassword } from "@debrief/core/settings";
import { authMode, signIn, signOut } from "@/lib/auth";
import { db } from "@/lib/db";

export async function signInWithPassword(_: { error?: string } | null, form: FormData) {
  try {
    await signIn("password", { password: form.get("password"), redirectTo: String(form.get("callbackUrl") || "/") });
    return null;
  } catch (err) {
    if (err instanceof AuthError) return { error: "That password isn't right." };
    throw err;
  }
}

export async function signInWithOidc(form: FormData) {
  await signIn("oidc", { redirectTo: String(form.get("callbackUrl") || "/") });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}

/** First run: sets the owner password (only while there's no way to sign in yet), then signs in. */
export async function finishSetup(_: { error?: string } | null, form: FormData) {
  const password = String(form.get("password") ?? "");
  try {
    await refreshSettings(db(), 0);
    if (authMode() !== "setup" || ownerPasswordSet()) return { error: "Debrief is already set up. Sign in instead." };
    const tz = String(form.get("tz") ?? "").trim();
    if (tz) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        return { error: `${tz} isn't a time zone (try America/New_York).` };
      }
    }
    await setOwnerPassword(db(), password);
    await saveSettings(db(), {
      OWNER_NAME: String(form.get("name") ?? "").trim() || null,
      TZ: tz || null,
      PUBLIC_URL: String(form.get("address") ?? "").trim() || null,
    });
  } catch (err) {
    return { error: (err as Error).message };
  }
  await signIn("password", { password, redirectTo: "/settings" });
  return null;
}
