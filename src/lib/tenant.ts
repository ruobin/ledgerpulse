import type { NextRequest } from "next/server";

const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;

export function isValidUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value);
}

/**
 * Resolve the tenant for a request.
 *
 * NOTE: `x-ledgerpulse-user` is a development/testing hook, not authentication: any caller
 * that passes the access gate (src/middleware.ts) can choose the tenant. Replace this with
 * the user id from a verified session (NextAuth, Clerk, Auth0, ...) before serving more
 * than one person from a deployment.
 */
export function resolveUserId(req?: NextRequest | Request): string {
  const headerUser = req?.headers.get("x-ledgerpulse-user")?.trim();
  if (headerUser && isValidUserId(headerUser)) {
    return headerUser;
  }
  return process.env.DEFAULT_USER_ID || "usr_demo_owner";
}
