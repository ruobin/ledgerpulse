import { NextResponse, type NextRequest } from "next/server";
import { checkAccess } from "@/lib/access";

/** Paths that must stay reachable without credentials (container health checks). */
const PUBLIC_PATHS = new Set(["/api/health"]);

export function middleware(req: NextRequest) {
  if (PUBLIC_PATHS.has(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const decision = checkAccess(req.headers.get("authorization"));
  if (decision.allowed) {
    return NextResponse.next();
  }

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (decision.status === 401) {
    headers["WWW-Authenticate"] = 'Basic realm="LedgerPulse", charset="UTF-8"';
  }
  return new NextResponse(decision.message, { status: decision.status, headers });
}

export const config = {
  // Node.js runtime so APP_PASSWORD is read from the runtime environment (not inlined at
  // build time) and node:crypto is available.
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
