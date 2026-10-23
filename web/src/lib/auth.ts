import crypto from "node:crypto";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";

/**
 * How people sign in. Debrief has one owner, so there are no accounts:
 * - "oidc": Authentik (or any OpenID Connect provider), optionally limited to ALLOWED_EMAILS.
 * - "password": one password, DEBRIEF_PASSWORD.
 * - "none": no sign-in at all, for when a proxy in front (Authentik forward auth) already guards it.
 * Unset, it's "oidc" when AUTH_OIDC_ISSUER is set, else "password".
 */
export function authMode(): "oidc" | "password" | "none" {
  const m = process.env.AUTH_MODE?.toLowerCase();
  if (m === "oidc" || m === "password" || m === "none") return m;
  return process.env.AUTH_OIDC_ISSUER ? "oidc" : "password";
}

export const oidcName = () => process.env.AUTH_OIDC_NAME || "Authentik";

const allowed = () =>
  (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

function safeEqual(a: string, b: string) {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function providers(): Provider[] {
  const list: Provider[] = [];
  if (process.env.AUTH_OIDC_ISSUER) {
    list.push({
      id: "oidc",
      name: oidcName(),
      type: "oidc",
      issuer: process.env.AUTH_OIDC_ISSUER,
      clientId: process.env.AUTH_OIDC_ID,
      clientSecret: process.env.AUTH_OIDC_SECRET,
      authorization: { params: { scope: "openid email profile" } },
    });
  }
  list.push(
    Credentials({
      id: "password",
      credentials: { password: { label: "Password", type: "password" } },
      authorize: async (c) => {
        const want = process.env.DEBRIEF_PASSWORD;
        const got = typeof c?.password === "string" ? c.password : "";
        if (authMode() !== "password" || !want || !got || !safeEqual(got, want)) return null;
        return { id: "owner", name: process.env.OWNER_NAME || "Owner", email: process.env.OWNER_EMAIL || null };
      },
    })
  );
  return list;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  // Self-hosted behind Traefik: build URLs from the forwarded host.
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
});

/** The signed-in person, or a stand-in when sign-in is handled upstream. */
export async function viewer() {
  if (authMode() === "none") return { name: process.env.OWNER_NAME || "Owner", email: process.env.OWNER_EMAIL || null };
  const s = await auth();
  return s?.user ? { name: s.user.name ?? null, email: s.user.email ?? null } : null;
}

/** For server actions and route handlers: throws unless signed in. */
export async function requireViewer() {
  const v = await viewer();
  if (!v) throw new Error("Sign in first.");
  return v;
}
