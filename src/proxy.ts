import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/** Paths reachable without a session. */
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/health"]);

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const cfg = appConfig();
  if (cfg.authDisabled) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(cfg.sessionSecret, token)) {
    return NextResponse.next();
  }

  // Unauthenticated: 401 for API, redirect to login for pages.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Run on everything except Next internals and static assets.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon|manifest.webmanifest).*)"],
};
