import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { POST as postBriefing } from "@/app/api/briefings/route";
import { GET as gmailAuth } from "@/app/api/gmail/auth/route";
import { GET as gmailCallback } from "@/app/api/gmail/callback/route";
import { GET as getSchedule, PUT as putSchedule } from "@/app/api/schedules/route";
import { checkAccess, parseBasicAuth } from "@/lib/access";
import { createOAuthState, OAUTH_STATE_COOKIE, verifyOAuthState } from "@/lib/gmail/oauth-state";
import { decryptSecret, encryptSecret } from "@/lib/telemetry";
import { middleware } from "@/middleware";

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const jsonRequest = (url: string, method: string, body: unknown) =>
  new NextRequest(url, {
    method,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("access gate", () => {
  it("is open in development and locked in production until configured", () => {
    expect(checkAccess(null, { NODE_ENV: "development" })).toEqual({ allowed: true });
    expect(checkAccess(null, { NODE_ENV: "production" })).toMatchObject({ allowed: false, status: 503 });
    expect(checkAccess(null, { NODE_ENV: "production", APP_AUTH_DISABLED: "true" })).toEqual({ allowed: true });
  });

  it("requires matching Basic credentials once APP_PASSWORD is set", () => {
    const env = { NODE_ENV: "production", APP_PASSWORD: "s3cret:with-colon" };
    expect(checkAccess(null, env)).toMatchObject({ allowed: false, status: 401 });
    expect(checkAccess(basic("admin", "wrong"), env)).toMatchObject({ allowed: false, status: 401 });
    expect(checkAccess(basic("root", "s3cret:with-colon"), env)).toMatchObject({ allowed: false, status: 401 });
    expect(checkAccess("Bearer abc", env)).toMatchObject({ allowed: false, status: 401 });
    expect(checkAccess(basic("admin", "s3cret:with-colon"), env)).toEqual({ allowed: true });
    expect(checkAccess(basic("ops", "s3cret:with-colon"), { ...env, APP_USERNAME: "ops" })).toEqual({
      allowed: true,
    });
    // A configured password is enforced in development too.
    expect(checkAccess(null, { NODE_ENV: "development", APP_PASSWORD: "pw" })).toMatchObject({ status: 401 });
  });

  it("parses Basic headers defensively", () => {
    expect(parseBasicAuth(basic("a", "b:c"))).toEqual({ username: "a", password: "b:c" });
    expect(parseBasicAuth("Basic !!!")).toBeNull();
    expect(parseBasicAuth(`Basic ${Buffer.from("no-colon").toString("base64")}`)).toBeNull();
    expect(parseBasicAuth(undefined)).toBeNull();
  });

  it("middleware challenges unauthenticated requests but keeps /api/health public", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PASSWORD", "pw");

    const denied = middleware(new NextRequest("http://localhost/briefings"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");

    const allowed = middleware(
      new NextRequest("http://localhost/api/snapshots", { headers: { authorization: basic("admin", "pw") } })
    );
    expect(allowed.headers.get("x-middleware-next")).toBe("1");
    expect(middleware(new NextRequest("http://localhost/api/health")).headers.get("x-middleware-next")).toBe("1");

    vi.stubEnv("APP_PASSWORD", undefined);
    expect(middleware(new NextRequest("http://localhost/")).status).toBe(503);
  });
});

describe("Gmail OAuth state (CSRF protection)", () => {
  it("round-trips only with the matching cookie nonce", () => {
    const { state, nonce } = createOAuthState("usr_owner");
    expect(verifyOAuthState(state, nonce)).toBe("usr_owner");
    expect(verifyOAuthState(state, createOAuthState("usr_owner").nonce)).toBeNull();
    expect(verifyOAuthState(state, undefined)).toBeNull();
    expect(verifyOAuthState("not-base64-json", nonce)).toBeNull();
    const badUser = Buffer.from(JSON.stringify({ n: nonce, u: "../../etc/passwd" })).toString("base64url");
    expect(verifyOAuthState(badUser, nonce)).toBeNull();
  });

  it("auth route binds the state in the Google URL to an HttpOnly cookie", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "test-client.apps.googleusercontent.com");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "test-secret");

    const res = await gmailAuth(
      new NextRequest("http://localhost/api/gmail/auth", { headers: { "x-ledgerpulse-user": "usr_owner" } })
    );
    const { authUrl } = await res.json();
    const cookie = res.cookies.get(OAUTH_STATE_COOKIE);

    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(verifyOAuthState(new URL(authUrl).searchParams.get("state"), cookie?.value)).toBe("usr_owner");
  });

  it("callback redirects to the configured public origin behind Docker and Nginx", async () => {
    vi.stubEnv("GMAIL_REDIRECT_URI", "https://ledgerpulse.ai-dictionary.org/api/gmail/callback");
    const res = await gmailCallback(
      new NextRequest("https://0.0.0.0:3000/api/gmail/callback?error=access_denied")
    );
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe("https://ledgerpulse.ai-dictionary.org");
    expect(target.pathname).toBe("/automation");
    expect(target.searchParams.get("error")).toContain("access_denied");
    expect(res.cookies.get(OAUTH_STATE_COOKIE)?.maxAge).toBe(0);
  });

  it("callback rejects forged state and provider errors without contacting Google", async () => {
    const { state } = createOAuthState("usr_owner");
    const errorFrom = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("error");

    const noCookie = await gmailCallback(
      new NextRequest(`http://localhost/api/gmail/callback?code=attacker-code&state=${state}`)
    );
    expect(noCookie.status).toBe(307);
    expect(new URL(noCookie.headers.get("location")!).pathname).toBe("/automation");
    expect(errorFrom(noCookie)).toMatch(/state check failed/);

    const wrongCookie = await gmailCallback(
      new NextRequest(`http://localhost/api/gmail/callback?code=attacker-code&state=${state}`, {
        headers: { cookie: `${OAUTH_STATE_COOKIE}=someone-elses-nonce` },
      })
    );
    expect(errorFrom(wrongCookie)).toMatch(/state check failed/);

    const cancelled = await gmailCallback(new NextRequest("http://localhost/api/gmail/callback?error=access_denied"));
    expect(errorFrom(cancelled)).toMatch(/access_denied/);
  });
});

describe("OAuth token encryption key handling", () => {
  it("rejects a malformed TOKEN_ENCRYPTION_KEY instead of silently falling back", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "not-a-64-char-hex-key");
    expect(() => encryptSecret("token")).toThrow(/64 hex characters/);
  });

  it("requires a key in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", undefined);
    expect(() => encryptSecret("token")).toThrow(/required in production/);
  });

  it("explains how to recover when the key changes", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    const cipher = encryptSecret("1//refresh-token");
    expect(decryptSecret(cipher)).toBe("1//refresh-token");

    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "b".repeat(64));
    expect(() => decryptSecret(cipher)).toThrow(/Reconnect Gmail/);
  });
});

describe("API input validation", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-api-"));
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    [{ timezone: "Not/AZone" }, "timezone"],
    [{ cron_expression: "0 25 * * *" }, "cron_expression"],
    [{ max_instruments: 999 }, "max_instruments"],
    [{ news_window_days: "abc" }, "news_window_days"],
    [{ language: "Klingon" }, "language"],
    [{ enabled: "false" }, "enabled"],
  ])("rejects an invalid schedule patch %j", async (patch, field) => {
    const res = await putSchedule(jsonRequest("http://localhost/api/schedules", "PUT", patch));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(field);
  });

  it("rejects a non-JSON schedule body", async () => {
    const res = await putSchedule(jsonRequest("http://localhost/api/schedules", "PUT", "{not json"));
    expect(res.status).toBe(400);
  });

  it("accepts the record the UI round-trips but ignores worker-owned fields", async () => {
    const { schedule } = await (await getSchedule(new NextRequest("http://localhost/api/schedules"))).json();
    const res = await putSchedule(
      jsonRequest("http://localhost/api/schedules", "PUT", {
        ...schedule,
        enabled: 0,
        timezone: "Europe/London",
        last_run_at: "2000-01-01T00:00:00.000Z",
        schedule_id: "sch_hijacked",
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).schedule).toMatchObject({
      enabled: 0,
      timezone: "Europe/London",
      last_run_at: null,
      schedule_id: schedule.schedule_id,
    });
  });

  it("validates briefing requests before any model call", async () => {
    const invalid = await postBriefing(
      jsonRequest("http://localhost/api/briefings", "POST", { snapshotId: "s1", days: "abc" })
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toContain("days");

    const unknown = await postBriefing(
      jsonRequest("http://localhost/api/briefings", "POST", { snapshotId: "does-not-exist" })
    );
    expect(unknown.status).toBe(404);
  });
});
