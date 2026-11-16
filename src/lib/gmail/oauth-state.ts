import crypto from "crypto";
import { isValidUserId } from "../tenant";

/**
 * OAuth2 `state` handling for the Gmail connection flow (RFC 6749 §10.12).
 *
 * The state carries the tenant plus a random nonce that is also stored in an HttpOnly,
 * SameSite=Lax cookie scoped to /api/gmail. The callback only links a Gmail account when
 * both match, so a crafted callback URL (attacker's code + victim's user id) is rejected.
 */

export const OAUTH_STATE_COOKIE = "lp_gmail_oauth_state";
export const OAUTH_STATE_COOKIE_PATH = "/api/gmail";
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export function createOAuthState(userId: string): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const state = Buffer.from(JSON.stringify({ n: nonce, u: userId }), "utf8").toString("base64url");
  return { state, nonce };
}

/** Returns the user id encoded in `state` when it matches the cookie nonce, otherwise null. */
export function verifyOAuthState(
  state: string | null | undefined,
  cookieNonce: string | null | undefined
): string | null {
  if (!state || !cookieNonce) return null;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      n?: unknown;
      u?: unknown;
    };
    if (typeof parsed.n !== "string" || typeof parsed.u !== "string" || !isValidUserId(parsed.u)) {
      return null;
    }
    const expected = Buffer.from(cookieNonce, "utf8");
    const received = Buffer.from(parsed.n, "utf8");
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return null;
    }
    return parsed.u;
  } catch {
    return null;
  }
}
