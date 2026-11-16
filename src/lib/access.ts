import crypto from "crypto";

/**
 * Deployment access gate (HTTP Basic auth), enforced for every page and API route by
 * src/middleware.ts. LedgerPulse holds brokerage positions and spends OpenAI budget, so a
 * production deployment refuses to serve anything until APP_PASSWORD is set, unless
 * APP_AUTH_DISABLED=true declares that an upstream proxy (Cloudflare Access, Tailscale,
 * oauth2-proxy, ...) already authenticates every request.
 */

export const DEFAULT_APP_USERNAME = "admin";

export interface AccessEnv {
  APP_USERNAME?: string;
  APP_PASSWORD?: string;
  APP_AUTH_DISABLED?: string;
  NODE_ENV?: string;
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 503; message: string };

export function parseBasicAuth(
  header: string | null | undefined
): { username: string; password: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(header ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Constant-time comparison that does not leak length (both sides are hashed first). */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export function checkAccess(
  authorization: string | null | undefined,
  env: AccessEnv = process.env
): AccessDecision {
  const password = env.APP_PASSWORD ?? "";
  if (!password.trim()) {
    if (env.APP_AUTH_DISABLED === "true" || env.NODE_ENV !== "production") {
      return { allowed: true };
    }
    return {
      allowed: false,
      status: 503,
      message:
        "LedgerPulse is locked: set APP_PASSWORD (and optionally APP_USERNAME) to enable sign-in, " +
        "or APP_AUTH_DISABLED=true if an upstream proxy already authenticates every request.",
    };
  }

  const credentials = parseBasicAuth(authorization);
  const expectedUser = env.APP_USERNAME || DEFAULT_APP_USERNAME;
  // Evaluate both comparisons so timing does not reveal which one failed.
  const userOk = safeEqual(credentials?.username ?? "", expectedUser);
  const passwordOk = safeEqual(credentials?.password ?? "", password);
  if (credentials && userOk && passwordOk) {
    return { allowed: true };
  }
  return { allowed: false, status: 401, message: "Authentication required." };
}
