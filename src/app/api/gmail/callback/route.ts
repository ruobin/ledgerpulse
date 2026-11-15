import { NextRequest, NextResponse } from "next/server";
import { handleGmailCallback } from "@/lib/gmail/client";
import { resolveUserId } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateUser = url.searchParams.get("state") || resolveUserId(req);

  if (!code) {
    return NextResponse.redirect(new URL("/automation?error=missing_code", req.url));
  }

  try {
    await handleGmailCallback(code, stateUser);
    return NextResponse.redirect(new URL("/automation?connected=1", req.url));
  } catch (err) {
    const msg = encodeURIComponent(err instanceof Error ? err.message : "OAuth failed");
    return NextResponse.redirect(new URL(`/automation?error=${msg}`, req.url));
  }
}
