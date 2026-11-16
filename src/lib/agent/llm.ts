import OpenAI from "openai";
import { aiEnv } from "../ai-settings";
import {
  describeLlmEndpoint,
  llmModel,
  OPENAI_API_URL,
  parseBraveEndpoint,
  parseWebSearchProvider,
  resolveAiConfig,
  type AiConfig,
  type ModelPurpose,
} from "./llm-config";

/**
 * Model access layer. Every model call uses an OpenAI-compatible client, so LedgerPulse can
 * talk to OpenAI directly or to any OpenAI-compatible API gateway: OpenRouter, a LiteLLM
 * proxy, Cloudflare AI Gateway, Azure OpenAI's v1 API, Helicone, Portkey, a company proxy.
 *
 * Settings come from the Admin Console (/admin) and fall back to environment variables; see
 * llm-config.ts for resolution and ai-settings-catalog.ts for which model suits each task.
 */

/** Effective AI configuration (Admin Console over environment). Throws if anything is invalid. */
export function loadAiConfig(): AiConfig {
  return resolveAiConfig(aiEnv({ strict: true }));
}

/** Client for every model call; configuration is validated before any request is sent. */
export function createLlmClient(config: AiConfig = loadAiConfig()): OpenAI {
  const { endpoint } = config;
  return new OpenAI({
    apiKey: endpoint.apiKey,
    baseURL: endpoint.baseURL ?? OPENAI_API_URL,
    defaultHeaders: endpoint.headers,
    defaultQuery: Object.keys(endpoint.query).length > 0 ? endpoint.query : undefined,
    // Passed explicitly so the client depends only on the resolved configuration.
    organization: endpoint.organization,
    project: endpoint.project,
  });
}

/** Configured model for a task; never throws, so reports can always name it. */
export function currentModel(purpose: ModelPurpose): string {
  return llmModel(purpose, aiEnv());
}

/** "OpenAI API" or the gateway host; never throws. */
export function currentEndpointLabel(): string {
  return describeLlmEndpoint(aiEnv());
}

/**
 * How a briefing's research was produced, for report footers and run records. Never throws:
 * an invalid setting is described as configured and fails loudly at the model call instead.
 */
export function describeAiSetup(): { runModel: string; footer: string } {
  const env = aiEnv();
  const research = llmModel("research", env);
  const analysis = llmModel("analysis", env);
  const endpoint = describeLlmEndpoint(env);

  let search = `OpenAI web search tool (${research})`;
  let runModel = research;
  try {
    const provider = parseWebSearchProvider(env.WEB_SEARCH_PROVIDER);
    if (provider === "brave") {
      search = `Brave Search API (${parseBraveEndpoint(env.BRAVE_SEARCH_ENDPOINT)})`;
      runModel = analysis;
    } else if (provider === "model") {
      search = `${research} built-in search`;
    }
  } catch {
    search = "invalid WEB_SEARCH_PROVIDER";
  }
  return { runModel, footer: `Web search: ${search} · Analysis model: ${analysis} · Endpoint: ${endpoint}` };
}
