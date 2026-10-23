import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { auth, authMode } from "@/lib/auth";

// /api/recorder checks its own API key.
const PUBLIC = ["/login", "/setup", "/api/auth", "/api/health", "/api/recorder"];

const guard = auth((req) => {
  const mode = authMode();
  if (mode === "none") return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  // Nothing to sign in with yet: everything goes to the first-run page.
  if (mode === "setup") {
    if (pathname === "/setup" || pathname.startsWith("/api/health") || pathname.startsWith("/_next")) return NextResponse.next();
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Finish setting up Debrief first." }, { status: 503 });
    return NextResponse.redirect(new URL("/setup", req.nextUrl));
  }
  if (pathname === "/setup") return NextResponse.redirect(new URL(req.auth ? "/" : "/login", req.nextUrl));
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!req.auth && !isPublic) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    const url = new URL("/login", req.nextUrl);
    url.searchParams.set("callbackUrl", pathname + search);
    return NextResponse.redirect(url);
  }
  if (req.auth && pathname === "/login") return NextResponse.redirect(new URL("/", req.nextUrl));
  return NextResponse.next();
});

// With its config built per request, next-auth hands back the wrapped proxy as a promise.
export default async function proxy(req: NextRequest, ev: NextFetchEvent) {
  return (await guard)(req, ev as never);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.svg|icon.svg|logo.svg).*)"],
};
