import { NextRequest, NextResponse } from "next/server";
import { safeError } from "@/lib/agent/services";
import { handleGmailCallback } from "@/lib/gmail/client";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  verifyOAuthState,
} from "@/lib/gmail/oauth-state";

function backToAutomation(req: NextRequest, params: Record<string, string>): NextResponse {
  // Standalone Next.js can expose the Docker bind address in req.url behind a proxy.
  // Use the server-configured OAuth origin, not untrusted incoming host headers.
  const origin = process.env.GMAIL_REDIRECT_URI?.trim() || req.url;
  const target = new URL("/automation", origin);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  const res = NextResponse.redirect(target);
  // The nonce is single-use.
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: OAUTH_STATE_COOKIE_PATH, maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const providerError = params.get("error");
  if (providerError) {
    return backToAutomation(req, {
      error: `Google OAuth was not completed (${providerError.slice(0, 64)}).`,
    });
  }

  const code = params.get("code");
  if (!code) {
    return backToAutomation(req, { error: "Google did not return an authorization code." });
  }

  const userId = verifyOAuthState(params.get("state"), req.cookies.get(OAUTH_STATE_COOKIE)?.value);
  if (!userId) {
    return backToAutomation(req, {
      error: "OAuth state check failed. Start the Gmail connection again from this page.",
    });
  }

  try {
    await handleGmailCallback(code, userId);
    return backToAutomation(req, { connected: "1" });
  } catch (err) {
    return backToAutomation(req, { error: safeError(err) });
  }
}
