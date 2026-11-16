import { NextRequest, NextResponse } from "next/server";
import { getGmailAuthUrl, isGmailConfigured } from "@/lib/gmail/client";
import {
  createOAuthState,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  OAUTH_STATE_MAX_AGE_SECONDS,
} from "@/lib/gmail/oauth-state";
import { resolveUserId } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  if (!isGmailConfigured()) {
    return NextResponse.json({
      configured: false,
      authUrl: null,
      message: "Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env to enable live Google OAuth2.",
    });
  }

  const { state, nonce } = createOAuthState(userId);
  const res = NextResponse.json({ configured: true, authUrl: getGmailAuthUrl(state) });
  res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return res;
}
