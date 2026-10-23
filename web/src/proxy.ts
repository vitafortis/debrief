import { NextResponse } from "next/server";
import { auth, authMode } from "@/lib/auth";

// /api/recorder checks its own API key.
const PUBLIC = ["/login", "/api/auth", "/api/health", "/api/recorder"];

export default auth((req) => {
  if (authMode() === "none") return NextResponse.next();
  const { pathname, search } = req.nextUrl;
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

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.svg|icon.svg|logo.svg).*)"],
};
