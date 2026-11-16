import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  APIConnectionTimeoutError,
  AuthenticationError,
  LengthFinishReasonError,
  NotFoundError,
  RateLimitError,
} from "openai/error";
import {
  describeLlmEndpoint,
  llmModel,
  parseWebSearchProvider,
  resolveAiConfig,
  resolveLlmEndpoint,
} from "@/lib/agent/llm-config";
import type { Instrument } from "@/lib/agent/models";
import { errorKind, extractStatement, researchInstrument, safeError } from "@/lib/agent/services";
import { runBriefing } from "@/lib/agent/workflow";
import { OperationalStore } from "@/lib/db/store";
import { estimateCostUsd } from "@/lib/telemetry";
import { chatCompletion, CLEAN_AI_ENV, startJsonServer, type Route } from "./helpers/fake-servers";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("LLM endpoint configuration", () => {
  it("defaults to OpenAI and requires a key there", () => {
    expect(() => resolveLlmEndpoint({})).toThrow(/No API key configured/);
    expect(resolveLlmEndpoint({ OPENAI_API_KEY: "sk-test" })).toEqual({
      baseURL: null,
      apiKey: "sk-test",
      headers: {},
      query: {},
      organization: null,
      project: null,
    });
    expect(llmModel("extraction", {})).toBe("gpt-4.1-mini");
    expect(llmModel("research", {})).toBe("gpt-4.1-mini");
    expect(llmModel("analysis", {})).toBe("gpt-4.1-mini");
    expect(parseWebSearchProvider(undefined)).toBe("openai");
    expect(describeLlmEndpoint({})).toBe("OpenAI API");
  });

  it("prefers LLM_* settings and still honours the legacy OPENAI_* names", () => {
    const env = {
      LLM_BASE_URL: "https://openrouter.ai/api/v1/",
      OPENAI_BASE_URL: "https://legacy.example/v1",
      LLM_API_KEY: "gw-key",
      OPENAI_API_KEY: "sk-legacy",
      LLM_MODEL: "openai/gpt-4.1-mini",
      OPENAI_MODEL: "gpt-4o",
      OPENAI_RESEARCH_MODEL: "gpt-4o-mini",
    };
    expect(resolveLlmEndpoint(env)).toMatchObject({ baseURL: "https://openrouter.ai/api/v1", apiKey: "gw-key" });
    expect(llmModel("extraction", env)).toBe("openai/gpt-4.1-mini");
    expect(llmModel("research", env)).toBe("gpt-4o-mini");
    expect(describeLlmEndpoint(env)).toBe("openrouter.ai");
  });

  it("defaults the analysis model to the extraction model", () => {
    expect(llmModel("analysis", { LLM_MODEL: "gpt-4.1" })).toBe("gpt-4.1");
    expect(llmModel("analysis", { LLM_MODEL: "gpt-4.1", LLM_ANALYSIS_MODEL: "vendor/strong" })).toBe("vendor/strong");
  });

  it("allows a gateway without a key and keeps its query parameters", () => {
    expect(resolveLlmEndpoint({ LLM_BASE_URL: "http://litellm:4000/v1?api-version=2026-01-01" })).toEqual({
      baseURL: "http://litellm:4000/v1",
      apiKey: "not-required",
      headers: {},
      query: { "api-version": "2026-01-01" },
      organization: null,
      project: null,
    });
  });

  it.each([
    ["ftp://gateway.example/v1", /http or https/],
    ["not a url", /absolute http\(s\) URL/],
    ["https://user:secret@gateway.example/v1", /must not embed credentials/],
    ["https://gateway.example/v1#section", /fragment/],
  ])("rejects LLM_BASE_URL %s without echoing it", (url, message) => {
    expect(() => resolveLlmEndpoint({ LLM_BASE_URL: url })).toThrow(message);
    expect(() => resolveLlmEndpoint({ LLM_BASE_URL: url })).not.toThrow(/secret/);
  });

  it("parses LLM_HEADERS and never echoes header values in errors", () => {
    expect(
      resolveLlmEndpoint({
        LLM_API_KEY: "k",
        LLM_HEADERS: '{"cf-aig-authorization":"Bearer abc","X-Title":"LedgerPulse"}',
      }).headers
    ).toEqual({ "cf-aig-authorization": "Bearer abc", "X-Title": "LedgerPulse" });

    for (const raw of ["not json", "[1,2]", '{"X-Num": 5}', '{"Bad Header": "x"}', '{"X-Leak": "top-secret\\r\\nX-Evil: 1"}']) {
      expect(() => resolveLlmEndpoint({ LLM_API_KEY: "k", LLM_HEADERS: raw })).toThrow(/LLM_HEADERS/);
      expect(() => resolveLlmEndpoint({ LLM_API_KEY: "k", LLM_HEADERS: raw })).not.toThrow(/top-secret/);
    }
  });

  it("fails before any request on an unknown search provider, Brave setting or malformed pricing", () => {
    expect(() => parseWebSearchProvider("browser")).toThrow(/"openai", "model" or "brave"/);
    expect(() => resolveAiConfig({ LLM_API_KEY: "k", WEB_SEARCH_PROVIDER: "browser" })).toThrow(/WEB_SEARCH_PROVIDER/);
    expect(() => resolveAiConfig({ LLM_API_KEY: "k", BRAVE_SEARCH_ENDPOINT: "images" })).toThrow(/BRAVE_SEARCH_ENDPOINT/);
    expect(() => resolveAiConfig({ LLM_API_KEY: "k", BRAVE_SEARCH_COST_PER_1K: "-5" })).toThrow(/BRAVE_SEARCH_COST_PER_1K/);
    expect(() => resolveAiConfig({ LLM_API_KEY: "k", LLM_PRICING: "{not json" })).toThrow(/LLM_PRICING/);
    expect(() => resolveAiConfig({ LLM_API_KEY: "k", LLM_PRICING: '{"m":{"input":-1,"output":0}}' })).toThrow(
      /LLM_PRICING/
    );
  });
});

describe("cost estimation for gateway model ids", () => {
  it("prices vendor-prefixed, variant and snapshot ids like the base model", () => {
    const base = estimateCostUsd("gpt-4.1-mini", 1_000_000, 1_000_000, 10);
    expect(estimateCostUsd("openai/gpt-4.1-mini:online", 1_000_000, 1_000_000, 10)).toBe(base);
    expect(estimateCostUsd("gpt-4.1-mini-2025-04-14", 1_000_000, 1_000_000, 10)).toBe(base);
    expect(estimateCostUsd("openai/gpt-4o", 1_000_000, 0)).toBe(2.5);
  });

  it("uses LLM_PRICING for models the built-in table does not know", () => {
    vi.stubEnv(
      "LLM_PRICING",
      '{"anthropic/claude-sonnet-4":{"input":3,"output":15},"llama3.1:8b":{"input":0,"output":0,"searchPer1k":0}}'
    );
    expect(estimateCostUsd("anthropic/claude-sonnet-4", 1_000_000, 1_000_000)).toBe(18);
    expect(estimateCostUsd("anthropic/claude-sonnet-4", 0, 0, 1_000)).toBe(10); // default search fee
    expect(estimateCostUsd("llama3.1:8b", 5_000_000, 5_000_000, 3)).toBe(0);

    vi.stubEnv("LLM_PRICING", "{not json");
    expect(estimateCostUsd("gpt-4.1-mini", 1_000_000, 0)).toBe(0.4); // never fails a run
  });
});

describe("provider error handling", () => {
  it("recognises the SDK's error classes even though their name is 'Error'", () => {
    const truncated = new LengthFinishReasonError();
    expect(truncated.name).toBe("Error");
    expect(errorKind(truncated)).toBe("LengthFinishReasonError");

    const auth = new AuthenticationError(401, { message: "Incorrect API key provided: sk-proj-abc" }, undefined, {});
    expect(safeError(auth)).toMatch(/LLM_API_KEY/);
    expect(safeError(auth)).not.toContain("sk-proj");

    const quota = new RateLimitError(429, { code: "insufficient_quota" }, "quota", {});
    expect(safeError(quota)).toMatch(/spend quota exhausted/);
    expect(safeError(new APIConnectionTimeoutError())).toMatch(/timed out/);

    const notFound = safeError(new NotFoundError(404, { message: "The model `foo` does not exist" }, undefined, {}));
    expect(notFound).toMatch(/API base URL and model ids/);
    expect(notFound).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end through a fake OpenAI-compatible gateway, using the real SDK.
// ---------------------------------------------------------------------------------------------

type GatewayRoute = Route;

async function startGateway(route: GatewayRoute) {
  const server = await startJsonServer(route);
  return { ...server, baseUrl: `${server.origin}/v1` };
}

function useGateway(baseUrl: string, overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...CLEAN_AI_ENV,
    LLM_BASE_URL: baseUrl,
    LLM_API_KEY: "gw-key-123",
    LLM_HEADERS: '{"x-gateway-tag":"ledgerpulse"}',
    LLM_MODEL: "vendor/extraction-model",
    LLM_RESEARCH_MODEL: "vendor/research-model:online",
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
}

const RESEARCH_TEXT = "NVIDIA raised its guidance (news.example.com).";
const CITATION = {
  url: "https://news.example.com/nvda",
  title: "Example News",
  start_index: RESEARCH_TEXT.indexOf("("),
  end_index: RESEARCH_TEXT.length - 1,
};
const EVIDENCE_JSON = JSON.stringify({
  news: [
    {
      headline: "NVIDIA raises guidance",
      publication_date: "2026-11-12",
      summary: "GATEWAY_ACCEPTED_FACT",
      source_ids: [0],
    },
  ],
  limitations: [],
});
const SCENARIOS_JSON = JSON.stringify({ interpretation: "Gateway interpretation", ideas: [] });

/** Answers research (chat or Responses API) plus the two synthesis stages. */
function researchGateway(withCitations: boolean): GatewayRoute {
  return (req) => {
    if (req.path.startsWith("/v1/responses")) {
      return {
        json: {
          id: "resp_test",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gateway-model",
          output: [
            { type: "web_search_call", id: "ws_1", status: "completed" },
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: RESEARCH_TEXT,
                  annotations: withCitations ? [{ type: "url_citation", ...CITATION }] : [],
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      };
    }
    const schema = req.body.response_format?.json_schema?.name;
    if (schema === "evidence") return { json: chatCompletion(EVIDENCE_JSON) };
    if (schema === "scenarios") return { json: chatCompletion(SCENARIOS_JSON) };
    return {
      json: chatCompletion(RESEARCH_TEXT, {
        annotations: withCitations ? [{ type: "url_citation", url_citation: CITATION }] : [],
      }),
    };
  };
}

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

describe("model calls through a custom API gateway", () => {
  it("routes extraction with the gateway key, headers and query, and retries a truncated response", async () => {
    const statementJson = JSON.stringify({
      kind: "holdings",
      as_of: "2026-11-13",
      period: "",
      instruments: [NVDA],
      warnings: [],
    });
    const gateway = await startGateway((req) =>
      req.body.max_tokens === 5000
        ? { json: chatCompletion("{", { finishReason: "length" }) } // truncated at the first budget
        : { json: chatCompletion(statementJson) }
    );
    try {
      useGateway(`${gateway.baseUrl}?api-version=2026-01-01`);
      const statement = await extractStatement("[PAGE 1]\nOPEN POSITIONS\nNVDA NVIDIA CORP NASDAQ 250 USD");

      expect(gateway.requests.map((r) => r.body.max_tokens)).toEqual([5000, 16000]);
      const [first] = gateway.requests;
      expect(first.path).toBe("/v1/chat/completions?api-version=2026-01-01");
      expect(first.headers.authorization).toBe("Bearer gw-key-123");
      expect(first.headers["x-gateway-tag"]).toBe("ledgerpulse");
      expect(first.body.model).toBe("vendor/extraction-model");
      expect(first.body.response_format?.json_schema?.name).toBe("statement");
      expect(statement.instruments[0].symbol).toBe("NVDA");
    } finally {
      await gateway.close();
    }
  });

  it("researches with the model's built-in search, then analyses with the analysis model", async () => {
    const gateway = await startGateway(researchGateway(true));
    try {
      useGateway(gateway.baseUrl, {
        WEB_SEARCH_PROVIDER: "model",
        LLM_ANALYSIS_MODEL: "vendor/analysis-model",
        LLM_PRICING: JSON.stringify({
          "vendor/research-model": { input: 1, output: 2, searchPer1k: 20 },
          "vendor/analysis-model": { input: 10, output: 20 },
        }),
      });
      const result = await researchInstrument(NVDA, WINDOW[0], WINDOW[1], "English");

      expect(gateway.requests.map((r) => r.path)).toEqual(Array(3).fill("/v1/chat/completions"));
      const [search, evidence, scenarios] = gateway.requests;
      expect(search.body.model).toBe("vendor/research-model:online");
      expect(search.body.web_search_options).toEqual({ search_context_size: "low" });
      expect(search.body.tools).toBeUndefined();
      expect(evidence.body.model).toBe("vendor/analysis-model");
      expect(evidence.body.response_format?.json_schema?.name).toBe("evidence");
      expect(scenarios.body.model).toBe("vendor/analysis-model");
      expect(scenarios.body.response_format?.json_schema?.name).toBe("scenarios");

      expect(result.status).toBe("cited");
      expect(result.sources).toEqual([{ title: "Example News", url: "https://news.example.com/nvda" }]);
      expect(result.markdown).toContain("GATEWAY_ACCEPTED_FACT");
      expect(result.search_calls).toBe(1);
      // Research (100 in / 20 out + 1 search) and both analysis stages (2 x 100 in / 20 out),
      // each priced at its own model's rate.
      expect(result.usage).toEqual({ input_tokens: 300, output_tokens: 60, total_tokens: 360 });
      expect(result.cost_usd).toBeCloseTo(0.0001 + 0.00004 + 0.02 + 0.002 + 0.0008, 6);
    } finally {
      await gateway.close();
    }
  });

  it("withholds gateway research that comes back without citations", async () => {
    const gateway = await startGateway(researchGateway(false));
    try {
      useGateway(gateway.baseUrl, { WEB_SEARCH_PROVIDER: "model" });
      const result = await researchInstrument(NVDA, WINDOW[0], WINDOW[1], "English");

      expect(result.status).toBe("unverified");
      expect(result.sources).toEqual([]);
      expect(gateway.requests).toHaveLength(1); // no synthesis on uncited output
    } finally {
      await gateway.close();
    }
  });

  it("uses the Responses API through pass-through gateways by default", async () => {
    const gateway = await startGateway(researchGateway(true));
    try {
      useGateway(gateway.baseUrl);
      const result = await researchInstrument(NVDA, WINDOW[0], WINDOW[1], "English");

      const [search] = gateway.requests;
      expect(search.path).toBe("/v1/responses");
      expect(search.body.tools?.[0]?.type).toBe("web_search_preview");
      expect(search.body.store).toBe(false);
      expect(result.status).toBe("cited");
      expect(gateway.requests).toHaveLength(3);
    } finally {
      await gateway.close();
    }
  });

  it("explains how to recover when a gateway has no Responses API", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-gateway-"));
    const gateway = await startGateway((req) =>
      req.path.startsWith("/v1/responses")
        ? { status: 404, json: { error: { message: "Not Found", type: "invalid_request_error" } } }
        : { json: chatCompletion("unused") }
    );
    try {
      useGateway(gateway.baseUrl);
      const result = await runBriefing({
        userId: "usr_gateway",
        store: new OperationalStore(dataDir),
        statement: { kind: "holdings", as_of: "2026-11-13", period: "", instruments: [NVDA], warnings: [] },
        confirmed: true,
        maxInstruments: 1,
      });

      expect(result.research[0].status).toBe("failed");
      expect(result.research[0].markdown).toContain('set the web search provider to "model" or "brave"');
      expect(result.markdown).toContain(`Endpoint: ${new URL(gateway.baseUrl).host}`);
    } finally {
      await gateway.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
