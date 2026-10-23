import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { ensureAuthSecret, ownerPasswordSet, refreshSettings, setting, verifyOwnerPassword } from "@debrief/core/settings";
import { db } from "@/lib/db";

/**
 * How people sign in. Debrief has one owner, so there are no accounts:
 * - an OpenID Connect provider (Authentik, …), set in Settings → Sign-in, optionally limited to some emails;
 * - and/or the owner password, made on first run (or DEBRIEF_PASSWORD in the environment).
 * AUTH_MODE=none in the environment turns sign-in off, for when a proxy in front (forward auth) already guards Debrief.
 * With neither set up yet, Debrief asks for a password first ("setup").
 */
export function authMode(): "none" | "setup" | "signin" {
  if (process.env.AUTH_MODE?.toLowerCase() === "none") return "none";
  return oidcEnabled() || ownerPasswordSet() ? "signin" : "setup";
}

export const oidcEnabled = () => !!(setting("AUTH_OIDC_ISSUER") && setting("AUTH_OIDC_ID"));
export const oidcName = () => setting("AUTH_OIDC_NAME") || "Authentik";
export const ownerName = () => setting("OWNER_NAME") || "Owner";

const allowed = () =>
  setting("ALLOWED_EMAILS")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

function providers(): Provider[] {
  const list: Provider[] = [];
  if (oidcEnabled()) {
    list.push({
      id: "oidc",
      name: oidcName(),
      type: "oidc",
      issuer: setting("AUTH_OIDC_ISSUER"),
      clientId: setting("AUTH_OIDC_ID"),
      clientSecret: setting("AUTH_OIDC_SECRET"),
      authorization: { params: { scope: "openid email profile" } },
    });
  }
  list.push(
    Credentials({
      id: "password",
      credentials: { password: { label: "Password", type: "password" } },
      authorize: async (c) => {
        const got = typeof c?.password === "string" ? c.password : "";
        if (!verifyOwnerPassword(got)) return null;
        return { id: "owner", name: ownerName(), email: setting("OWNER_EMAIL") || null };
      },
    })
  );
  return list;
}

// Built on each request, so sign-in changes in Settings apply without a restart.
export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  await refreshSettings(db());
  return {
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? (await ensureAuthSecret(db())),
    // Self-hosted behind a proxy: build URLs from the forwarded host.
    trustHost: true,
    session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
    pages: { signIn: "/login" },
    providers: providers(),
    callbacks: {
      signIn({ account, user, profile }) {
        if (account?.provider !== "oidc") return true;
        const list = allowed();
        const email = (profile?.email ?? user.email ?? "").toLowerCase();
        return list.length === 0 || list.includes(email);
      },
    },
  };
});

/** The signed-in person, or a stand-in when sign-in is handled upstream. */
export async function viewer() {
  await refreshSettings(db());
  if (authMode() === "none") return { name: ownerName(), email: setting("OWNER_EMAIL") || null };
  const s = await auth();
  return s?.user ? { name: s.user.name ?? null, email: s.user.email ?? null } : null;
}

/** For server actions and route handlers: throws unless signed in. */
export async function requireViewer() {
  const v = await viewer();
  if (!v) throw new Error("Sign in first.");
  return v;
}
