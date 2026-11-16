import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { GET as getSettings, PUT as putSettings } from "@/app/api/admin/settings/route";
import { POST as testSettings } from "@/app/api/admin/settings/test/route";
import { loadAiConfig } from "@/lib/agent/llm";
import type { Instrument } from "@/lib/agent/models";
import { braveSearch } from "@/lib/agent/search";
import { extractStatement, researchInstrument } from "@/lib/agent/services";
import { runBriefing } from "@/lib/agent/workflow";
import { saveAiSettings } from "@/lib/ai-settings";
import { OperationalStore } from "@/lib/db/store";
import { chatCompletion, CLEAN_AI_ENV, startJsonServer, type Route } from "./helpers/fake-servers";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-admin-"));
  for (const [name, value] of Object.entries({ ...CLEAN_AI_ENV, DATA_DIR: dataDir })) {
    vi.stubEnv(name, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const putJson = (values: Record<string, string | null>) =>
  putSettings(
    new NextRequest("http://localhost/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ values }),
      headers: { "content-type": "application/json" },
    })
  );

type SettingState = { key: string; source: string; envName: string | null; value: string | null; configured: boolean; error: string | null };
const byKey = (settings: SettingState[]) => Object.fromEntries(settings.map((s) => [s.key, s]));

describe("Admin Console settings", () => {
  it("reports where each value comes from and never returns secrets", async () => {
    vi.stubEnv("LLM_MODEL", "env-model");
    vi.stubEnv("OPENAI_API_KEY", "sk-env-secret-value");

    const res = await getSettings();
    const raw = await res.text();
    expect(raw).not.toContain("sk-env-secret-value");

    const settings = byKey(JSON.parse(raw).settings);
    expect(settings.LLM_MODEL).toMatchObject({ source: "env", envName: "LLM_MODEL", value: "env-model" });
    expect(settings.LLM_API_KEY).toMatchObject({ source: "env", envName: "OPENAI_API_KEY", value: null, configured: true });
    expect(settings.LLM_ANALYSIS_MODEL).toMatchObject({ source: "default", value: "" });
    expect(settings.WEB_SEARCH_PROVIDER).toMatchObject({ source: "default", value: "openai" });
  });

  it("saves overrides that win over .env, encrypting secrets at rest", async () => {
    vi.stubEnv("LLM_MODEL", "env-model");
    vi.stubEnv("OPENAI_API_KEY", "sk-env-secret-value");

    const res = await putJson({
      LLM_MODEL: "admin-model",
      LLM_API_KEY: "sk-admin-secret-value",
      WEB_SEARCH_PROVIDER: "brave",
      BRAVE_SEARCH_API_KEY: "brave-secret-value",
    });
    const raw = await res.text();
    expect(res.status).toBe(200);
    expect(raw).not.toMatch(/sk-admin-secret-value|brave-secret-value/);
    const settings = byKey(JSON.parse(raw).settings);
    expect(settings.LLM_MODEL).toMatchObject({ source: "admin", value: "admin-model" });
    expect(settings.LLM_API_KEY).toMatchObject({ source: "admin", configured: true, value: null });

    const stored = new OperationalStore(dataDir).listAppSettings();
    const apiKeyRow = stored.find((row) => row.key === "LLM_API_KEY");
    expect(apiKeyRow?.encrypted).toBe(true);
    expect(apiKeyRow?.value).not.toContain("sk-admin-secret-value");

    const config = loadAiConfig();
    expect(config.models.extraction).toBe("admin-model");
    expect(config.endpoint.apiKey).toBe("sk-admin-secret-value");
    expect(config.webSearch).toBe("brave");
    expect(config.brave.apiKey).toBe("brave-secret-value");

    const audit = new OperationalStore(dataDir)
      .summaryMetrics("usr_demo_owner")
      .audit_events.find((event) => event.event_type === "admin_settings_updated");
    expect(String(audit?.message)).toContain("LLM_API_KEY");
    expect(JSON.stringify(audit)).not.toContain("sk-admin-secret-value");

    // Clearing an override falls back to .env again.
    const cleared = byKey((await (await putJson({ LLM_MODEL: null })).json()).settings);
    expect(cleared.LLM_MODEL).toMatchObject({ source: "env", value: "env-model" });
  });

  it("rejects invalid values with a reason per key and saves nothing", async () => {
    const res = await putJson({
      LLM_BASE_URL: "ftp://gateway.example/v1",
      LLM_HEADERS: "[1,2]",
      LLM_MODEL: "bad model id",
      WEB_SEARCH_PROVIDER: "bing",
      BRAVE_SEARCH_COST_PER_1K: "-1",
      LLM_PRICING: "{not json",
      SOMETHING_ELSE: "x",
      LLM_RESEARCH_MODEL: "valid-model",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    for (const key of ["LLM_BASE_URL", "LLM_HEADERS", "LLM_MODEL", "WEB_SEARCH_PROVIDER", "BRAVE_SEARCH_COST_PER_1K", "LLM_PRICING", "SOMETHING_ELSE"]) {
      expect(body.issues.join("\n")).toContain(key);
    }
    expect(new OperationalStore(dataDir).listAppSettings()).toEqual([]);
  });

  it("refuses to store a secret in production without TOKEN_ENCRYPTION_KEY", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", undefined);
    const res = await putJson({ LLM_API_KEY: "sk-admin-secret-value", LLM_MODEL: "admin-model" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/TOKEN_ENCRYPTION_KEY is required in production/);
    expect(new OperationalStore(dataDir).listAppSettings()).toEqual([]);
  });

  it("flags a saved secret that no longer decrypts instead of silently using .env", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("OPENAI_API_KEY", "sk-env-fallback");
    saveAiSettings({ LLM_API_KEY: "sk-admin-secret-value" }, { userId: "usr_admin" });

    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "b".repeat(64));
    const state = await (await getSettings()).json();
    expect(byKey(state.settings).LLM_API_KEY.error).toMatch(/Enter it again/);
    expect(state.configError).toMatch(/cannot be decrypted/);
    expect(() => loadAiConfig()).toThrow(/Enter it again in the Admin Console/);
  });
});

// ---------------------------------------------------------------------------------------------
// Brave Search and Admin Console settings exercised end to end against fake servers.
// ---------------------------------------------------------------------------------------------

const NVDA: Instrument = {
  symbol: "NVDA",
  name: "NVIDIA CORP",
  exchange: "NASDAQ",
  asset_type: "stock",
  currency: "USD",
  holding_quantity: "250",
  activity: "",
  source_page: 1,
  evidence: "NVDA 250",
};
const WINDOW = ["2026-11-10T00:00:00.000Z", "2026-11-16T00:00:00.000Z"] as const;

const BRAVE_NEWS = {
  type: "news",
  results: [
    {
      title: "NVIDIA <strong>raises</strong> guidance &amp; outlook",
      url: "https://news.example.com/nvda-guidance",
      description: "NVIDIA lifted its <strong>revenue</strong> outlook.",
      page_age: "2026-11-12T14:00:00",
      meta_url: { hostname: "news.example.com" },
    },
    { title: "Duplicate", url: "https://news.example.com/nvda-guidance", description: "dup" },
    { title: "Script", url: "javascript:alert(1)", description: "not a web page" },
    {
      title: "Undated story",
      url: "https://blog.example.org/nvda",
      description: "No date given.",
      meta_url: { hostname: "blog.example.org" },
    },
  ],
};

/** Analysis stages of the fake gateway: one accepted fact citing Brave source 0. */
const analysisRoute: Route = (req) => {
  const schema = req.body.response_format?.json_schema?.name;
  if (schema === "evidence") {
    return {
      json: chatCompletion(
        JSON.stringify({
          news: [{ headline: "NVIDIA raises guidance", publication_date: "2026-11-12", summary: "BRAVE_ACCEPTED_FACT", source_ids: [0] }],
          limitations: [],
        })
      ),
    };
  }
  if (schema === "scenarios") {
    return { json: chatCompletion(JSON.stringify({ interpretation: "Brave interpretation", ideas: [] })) };
  }
  return { status: 500, json: { error: { message: "unexpected request" } } };
};

describe("Brave Search provider", () => {
  it("searches the briefing window with Brave and analyses only those results", async () => {
    const brave = await startJsonServer(() => ({ json: BRAVE_NEWS }));
    const gateway = await startJsonServer(analysisRoute);
    try {
      for (const [name, value] of Object.entries({
        LLM_BASE_URL: `${gateway.origin}/v1`,
        LLM_API_KEY: "gw-key",
        LLM_MODEL: "vendor/extraction-model",
        LLM_ANALYSIS_MODEL: "vendor/analysis-model",
        LLM_PRICING: JSON.stringify({ "vendor/analysis-model": { input: 10, output: 20 } }),
        WEB_SEARCH_PROVIDER: "brave",
        BRAVE_SEARCH_API_KEY: "brave-key",
        BRAVE_SEARCH_COST_PER_1K: "5",
        BRAVE_SEARCH_BASE_URL: `${brave.origin}/res/v1`,
      })) {
        vi.stubEnv(name, value);
      }

      const result = await researchInstrument(NVDA, WINDOW[0], WINDOW[1], "English");

      expect(brave.requests).toHaveLength(1);
      const search = new URL(brave.requests[0].path, brave.origin);
      expect(search.pathname).toBe("/res/v1/news/search");
      expect(search.searchParams.get("q")).toBe("NVIDIA CORP NVDA stock");
      expect(search.searchParams.get("freshness")).toBe("2026-11-10to2026-11-16");
      expect(search.searchParams.get("count")).toBe("10");
      expect(brave.requests[0].headers["x-subscription-token"]).toBe("brave-key");

      // Only the two analysis stages reach the model; no research-model call.
      expect(gateway.requests.map((r) => r.body.response_format?.json_schema?.name)).toEqual(["evidence", "scenarios"]);
      expect(gateway.requests.every((r) => r.body.model === "vendor/analysis-model")).toBe(true);
      const evidencePrompt = gateway.requests[0].body.messages?.[1]?.content ?? "";
      expect(evidencePrompt).toContain("[source 0] NVIDIA raises guidance & outlook (news.example.com, published 2026-11-12)");
      expect(evidencePrompt).toContain("[source 1] Undated story (blog.example.org, publication date not given)");
      expect(evidencePrompt).not.toContain("javascript:");

      expect(result.status).toBe("cited");
      expect(result.sources).toEqual([
        { title: "NVIDIA raises guidance & outlook", url: "https://news.example.com/nvda-guidance" },
        { title: "Undated story", url: "https://blog.example.org/nvda" },
      ]);
      expect(result.markdown).toContain("BRAVE_ACCEPTED_FACT");
      // $5 per 1k Brave requests + two analysis calls (200 in / 40 out at $10 / $20 per 1M).
      expect(result.cost_usd).toBeCloseTo(0.005 + 0.002 + 0.0008, 6);
    } finally {
      await brave.close();
      await gateway.close();
    }
  });

  it("merges news and web results from the web endpoint", async () => {
    const brave = await startJsonServer(() => ({
      json: {
        news: { results: [{ title: "News A", url: "https://a.example/1", description: "a", page_age: "2026-11-11T00:00:00" }] },
        web: {
          results: [
            { title: "Web B", url: "https://b.example/2", description: "b" },
            { title: "News A again", url: "https://a.example/1", description: "dup" },
          ],
        },
      },
    }));
    try {
      const results = await braveSearch({ query: "q", apiKey: "k", endpoint: "web", baseUrl: `${brave.origin}/res/v1`, count: 5 });
      const url = new URL(brave.requests[0].path, brave.origin);
      expect(url.pathname).toBe("/res/v1/web/search");
      expect(url.searchParams.get("result_filter")).toBe("news,web");
      expect(results.map((r) => [r.title, r.published])).toEqual([
        ["News A", "2026-11-11"],
        ["Web B", null],
      ]);
    } finally {
      await brave.close();
    }
  });

  it("reports a rejected Brave key in the briefing without failing the run", async () => {
    const brave = await startJsonServer(() => ({ status: 401, json: { error: { detail: "invalid token" } } }));
    try {
      vi.stubEnv("OPENAI_API_KEY", "sk-unused");
      vi.stubEnv("WEB_SEARCH_PROVIDER", "brave");
      vi.stubEnv("BRAVE_SEARCH_API_KEY", "wrong-key");
      vi.stubEnv("BRAVE_SEARCH_BASE_URL", `${brave.origin}/res/v1`);

      const result = await runBriefing({
        userId: "usr_brave",
        store: new OperationalStore(dataDir),
        statement: { kind: "holdings", as_of: "2026-11-13", period: "", instruments: [NVDA], warnings: [] },
        confirmed: true,
        maxInstruments: 1,
      });
      expect(result.research[0].status).toBe("failed");
      expect(result.research[0].markdown).toMatch(/Brave Search rejected the API key \(HTTP 401\)/);
      expect(result.markdown).toContain("Web search: Brave Search API (news)");
    } finally {
      await brave.close();
    }
  });

  it("explains a missing Brave key before any request is made", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-unused");
    vi.stubEnv("WEB_SEARCH_PROVIDER", "brave");
    await expect(researchInstrument(NVDA, WINDOW[0], WINDOW[1], "English")).rejects.toThrow(/no Brave API key is configured/);
  });
});

describe("Admin Console values in real model calls", () => {
  it("routes extraction through the gateway, key and model saved in the Admin Console", async () => {
    const statement = JSON.stringify({ kind: "holdings", as_of: "2026-11-13", period: "", instruments: [NVDA], warnings: [] });
    const gateway = await startJsonServer(() => ({ json: chatCompletion(statement) }));
    try {
      vi.stubEnv("OPENAI_API_KEY", "sk-env-key");
      vi.stubEnv("OPENAI_MODEL", "env-model");
      saveAiSettings(
        { LLM_BASE_URL: `${gateway.origin}/v1`, LLM_API_KEY: "admin-key", LLM_MODEL: "admin-model" },
        { userId: "usr_admin" }
      );

      await extractStatement("[PAGE 1]\nOPEN POSITIONS\nNVDA NVIDIA CORP NASDAQ 250 USD");
      expect(gateway.requests[0].body.model).toBe("admin-model");
      expect(gateway.requests[0].headers.authorization).toBe("Bearer admin-key");
    } finally {
      await gateway.close();
    }
  });

  it("tests the saved configuration from the Admin Console", async () => {
    const brave = await startJsonServer(() => ({ json: BRAVE_NEWS }));
    const gateway = await startJsonServer((req) =>
      req.headers.authorization === "Bearer good-key"
        ? { json: chatCompletion("OK") }
        : { status: 401, json: { error: { message: "Invalid key" } } }
    );
    try {
      saveAiSettings(
        {
          LLM_BASE_URL: `${gateway.origin}/v1`,
          LLM_API_KEY: "good-key",
          LLM_MODEL: "vendor/extraction-model",
          LLM_ANALYSIS_MODEL: "vendor/analysis-model",
          WEB_SEARCH_PROVIDER: "brave",
          BRAVE_SEARCH_API_KEY: "brave-key",
        },
        { userId: "usr_admin" }
      );
      vi.stubEnv("BRAVE_SEARCH_BASE_URL", `${brave.origin}/res/v1`);

      const passing = (await (await testSettings()).json()).checks;
      expect(passing.map((c: { ok: boolean }) => c.ok)).toEqual([true, true, true]);
      expect(passing[2].name).toBe("Brave Search API (news)");
      expect(gateway.requests.map((r) => r.body.temperature)).toEqual([0, 0]); // same parameters as real runs

      saveAiSettings({ LLM_API_KEY: "bad-key" }, { userId: "usr_admin" });
      const failing = (await (await testSettings()).json()).checks;
      expect(failing[0].ok).toBe(false);
      expect(failing[0].detail).toMatch(/API authentication failed/);
    } finally {
      await brave.close();
      await gateway.close();
    }
  });
});
