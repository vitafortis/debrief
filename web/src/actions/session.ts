"use server";

import { signIn, signOut } from "@/lib/auth";
import { AuthError } from "next-auth";

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
