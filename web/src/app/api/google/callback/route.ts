import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { googleConnect } from "@debrief/core/calendar-sync";
import { refreshSettings } from "@debrief/core/settings";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";
import { appOrigin, googleRedirectUri } from "@/lib/origin";

/** Google sends you back here with a code, traded for a refresh token kept as the Google credentials. */
export async function GET(req: NextRequest) {
  await requireViewer();
  const origin = await appOrigin();
  const back = (q: Record<string, string>) => {
    const res = NextResponse.redirect(`${origin}/settings/calendars?${new URLSearchParams({ add: "google", ...q })}`);
    res.cookies.delete({ name: "debrief_google_state", path: "/api/google" });
    return res;
  };
  const p = req.nextUrl.searchParams;
  if (p.get("error")) return back({ google_error: p.get("error") === "access_denied" ? "You didn't allow access, so nothing changed." : `Google said: ${p.get("error")}` });
  const code = p.get("code");
  if (!code || !p.get("state") || p.get("state") !== req.cookies.get("debrief_google_state")?.value)
    return back({ google_error: "That sign-in expired or came from somewhere else. Try Connect Google again." });
  try {
    await refreshSettings(db(), 0);
    const account = await googleConnect(db(), code, await googleRedirectUri());
    revalidatePath("/", "layout");
    return back({ google: account ?? "connected" });
  } catch (err) {
    const msg = (err as Error).message;
    return back({
      google_error: /invalid_client|unauthorized_client/.test(msg)
        ? "Google didn't accept the OAuth client. Check the client ID and secret you saved."
        : /redirect_uri_mismatch/.test(msg)
          ? "The redirect URI in Google Cloud doesn't match. Copy it again from the steps below."
          : /invalid_grant/.test(msg)
            ? "That sign-in had already been used or expired. Try Connect Google again."
            : msg,
    });
  }
}
