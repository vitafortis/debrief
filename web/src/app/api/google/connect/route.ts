import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { googleConnectUrl, googleOAuthReady } from "@debrief/core/calendar-sync";
import { refreshSettings } from "@debrief/core/settings";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";
import { appOrigin, googleRedirectUri } from "@/lib/origin";

/** "Connect Google": off to Google's consent screen, with a state cookie to check on the way back. */
export async function GET() {
  await requireViewer();
  await refreshSettings(db(), 0);
  const origin = await appOrigin();
  if (!googleOAuthReady()) return NextResponse.redirect(`${origin}/settings/calendars?add=google&google_error=${encodeURIComponent("Save the OAuth client ID and secret first.")}`);
  const state = crypto.randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(googleConnectUrl(await googleRedirectUri(), state));
  res.cookies.set("debrief_google_state", state, { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), maxAge: 600, path: "/api/google" });
  return res;
}
