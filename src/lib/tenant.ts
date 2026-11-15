import { NextRequest } from "next/server";

export function resolveUserId(req?: NextRequest | Request): string {
  const headerUser = req?.headers.get("x-ledgerpulse-user")?.trim();
  if (headerUser && /^[a-zA-Z0-9_-]{3,64}$/.test(headerUser)) {
    return headerUser;
  }
  return process.env.DEFAULT_USER_ID || "usr_demo_owner";
}
