import { parsePricingOverrides, type PricingRate } from "../telemetry";

/**
 * Pure resolution and validation of the AI settings: model endpoint, per-task models, web
 * search provider and pricing. Values come from an env-like map; src/lib/ai-settings.ts
 * builds that map from the Admin Console's saved values layered over process.env. Every
 * LLM_* name falls back to its legacy OPENAI_* alias. Model guidance per task lives in
 * src/lib/ai-settings-catalog.ts.
 */

export type LlmEnv = Record<string, string | undefined>;
export type ModelPurpose = "extraction" | "analysis" | "research";

/**
 * - "openai": the Responses API with OpenAI's hosted `web_search_preview` tool (OpenAI, or
 *   gateways that pass requests through to OpenAI).
 * - "model": Chat Completions with `web_search_options`, cited through OpenAI-style
 *   `url_citation` annotations (OpenRouter `:online` models, OpenAI search models, LiteLLM).
 * - "brave": the Brave Search API; results go straight to the analysis model.
 * With every provider, research without citations is withheld as "unverified".
 */
export type WebSearchProvider = "openai" | "model" | "brave";
export type BraveEndpoint = "news" | "web";

export const DEFAULT_MODEL = "gpt-4.1-mini";
export const OPENAI_API_URL = "https://api.openai.com/v1";
export const BRAVE_API_URL = "https://api.search.brave.com/res/v1";
/** Bearer value sent to a gateway that needs no key (the SDK always sends one). */
const NO_KEY_PLACEHOLDER = "not-required";
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;

export interface LlmEndpoint {
  /** null means OpenAI's public API. */
  baseURL: string | null;
  apiKey: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  organization: string | null;
  project: string | null;
}

export interface AiConfig {
  endpoint: LlmEndpoint;
  /** "OpenAI API" or the gateway host; safe to show in reports. */
  endpointLabel: string;
  models: Record<ModelPurpose, string>;
  webSearch: WebSearchProvider;
  brave: { apiKey: string | null; endpoint: BraveEndpoint; costPer1k: number; baseUrl: string };
  pricing: Record<string, PricingRate>;
}

export function setting(env: LlmEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Never throws, so reports can always name the models. The analysis model defaults to the extraction model. */
export function llmModel(purpose: ModelPurpose, env: LlmEnv): string {
  const extraction = setting(env, "LLM_MODEL", "OPENAI_MODEL") ?? DEFAULT_MODEL;
  if (purpose === "extraction") return extraction;
  if (purpose === "analysis") return setting(env, "LLM_ANALYSIS_MODEL") ?? extraction;
  return setting(env, "LLM_RESEARCH_MODEL", "OPENAI_RESEARCH_MODEL") ?? DEFAULT_MODEL;
}

export function validateModelId(raw: string): string {
  if (!MODEL_ID.test(raw)) {
    throw new Error("must be a model id such as gpt-4.1-mini or openai/gpt-4.1-mini:online (letters, digits, . _ : / @ + -)");
  }
  return raw;
}

function parseHttpUrl(raw: string, name: string, example: string): URL {
  // Error messages never echo the URL: it can carry an account id or token.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, e.g. ${example}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not embed credentials; use the API key or headers settings.`);
  }
  if (url.hash) {
    throw new Error(`${name} must not contain a #fragment.`);
  }
  return url;
}

export function parseBaseUrl(raw: string): { baseURL: string; query: Record<string, string> } {
  const url = parseHttpUrl(raw, "LLM_BASE_URL", "https://openrouter.ai/api/v1");
  const query = Object.fromEntries(url.searchParams);
  url.search = "";
  return { baseURL: url.toString().replace(/\/+$/, ""), query };
}

function parseBraveBaseUrl(raw: string): string {
  const url = parseHttpUrl(raw, "BRAVE_SEARCH_BASE_URL", BRAVE_API_URL);
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const usage =
    'LLM_HEADERS must be a JSON object of header names to string values, e.g. {"cf-aig-authorization":"Bearer <token>"}.';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(usage);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(usage);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    // Only the header name is reported; values usually carry credentials.
    if (!HEADER_NAME.test(name) || typeof value !== "string" || /[\r\n\0]/.test(value)) {
      throw new Error(`LLM_HEADERS entry "${name.slice(0, 64)}" is invalid. ${usage}`);
    }
    headers[name] = value;
  }
  return headers;
}

export function parseWebSearchProvider(raw: string | undefined): WebSearchProvider {
  const value = raw?.trim() || "openai";
  if (value !== "openai" && value !== "model" && value !== "brave") {
    throw new Error(`WEB_SEARCH_PROVIDER must be "openai", "model" or "brave" (got "${value.slice(0, 32)}").`);
  }
  return value;
}

export function parseBraveEndpoint(raw: string | undefined): BraveEndpoint {
  const value = raw?.trim() || "news";
  if (value !== "news" && value !== "web") {
    throw new Error(`BRAVE_SEARCH_ENDPOINT must be "news" or "web" (got "${value.slice(0, 32)}").`);
  }
  return value;
}

export function parseBraveCost(raw: string | undefined): number {
  const value = raw?.trim() || "0";
  const cost = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(cost) || cost > 1000) {
    throw new Error("BRAVE_SEARCH_COST_PER_1K must be a price in USD between 0 and 1000.");
  }
  return cost;
}

export function resolveLlmEndpoint(env: LlmEnv): LlmEndpoint {
  const rawBaseUrl = setting(env, "LLM_BASE_URL", "OPENAI_BASE_URL");
  const { baseURL, query } = rawBaseUrl ? parseBaseUrl(rawBaseUrl) : { baseURL: null, query: {} };
  const apiKey = setting(env, "LLM_API_KEY", "OPENAI_API_KEY");
  if (!apiKey && !baseURL) {
    throw new Error(
      "No API key configured: set it in the Admin Console or as LLM_API_KEY (or OPENAI_API_KEY), or point LLM_BASE_URL at a gateway that needs no key."
    );
  }
  return {
    baseURL,
    apiKey: apiKey ?? NO_KEY_PLACEHOLDER,
    headers: parseHeaders(setting(env, "LLM_HEADERS")),
    query,
    organization: setting(env, "OPENAI_ORG_ID") ?? null,
    project: setting(env, "OPENAI_PROJECT_ID") ?? null,
  };
}

/** Where model calls go, for reports: "OpenAI API" or the gateway host (never a path or key). */
export function describeLlmEndpoint(env: LlmEnv): string {
  const raw = setting(env, "LLM_BASE_URL", "OPENAI_BASE_URL");
  if (!raw) return "OpenAI API";
  try {
    return new URL(raw).host || "custom gateway";
  } catch {
    return "custom gateway";
  }
}

/**
 * Validate and resolve every AI setting. Throws a descriptive error for any invalid value,
 * so a misconfiguration fails before a request (and any spend) happens. A missing Brave key
 * is reported only when Brave search actually runs.
 */
export function resolveAiConfig(env: LlmEnv): AiConfig {
  const braveBase = setting(env, "BRAVE_SEARCH_BASE_URL");
  return {
    endpoint: resolveLlmEndpoint(env),
    endpointLabel: describeLlmEndpoint(env),
    models: {
      extraction: llmModel("extraction", env),
      analysis: llmModel("analysis", env),
      research: llmModel("research", env),
    },
    webSearch: parseWebSearchProvider(setting(env, "WEB_SEARCH_PROVIDER")),
    brave: {
      apiKey: setting(env, "BRAVE_SEARCH_API_KEY") ?? null,
      endpoint: parseBraveEndpoint(setting(env, "BRAVE_SEARCH_ENDPOINT")),
      costPer1k: parseBraveCost(setting(env, "BRAVE_SEARCH_COST_PER_1K")),
      // Advanced, environment-only: route Brave calls through a proxy.
      baseUrl: braveBase ? parseBraveBaseUrl(braveBase) : BRAVE_API_URL,
    },
    pricing: parsePricingOverrides(setting(env, "LLM_PRICING")),
  };
}
