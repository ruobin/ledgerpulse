import { NextRequest, NextResponse } from "next/server";
import { getGmailAuthUrl, isGmailConfigured } from "@/lib/gmail/client";
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
  return NextResponse.json({
    configured: true,
    authUrl: getGmailAuthUrl(userId),
  });
}
