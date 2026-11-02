import "server-only";
import { headers } from "next/headers";
import { publicUrl } from "@debrief/core";

/** Where Debrief is opened from: PUBLIC_URL, else the address this request came in on (behind a proxy too). */
export async function appOrigin() {
  const set = publicUrl();
  if (set) return set;
  const h = await headers();
  const host = h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

export const googleRedirectUri = async () => `${await appOrigin()}/api/google/callback`;
