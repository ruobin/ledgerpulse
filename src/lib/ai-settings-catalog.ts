/**
 * Catalog of the AI settings editable in the Admin Console (/admin). Pure data, safe to
 * import from client components. Resolution order for every key: value saved in the Admin
 * Console > environment variable (or its legacy alias) > default.
 *
 * Choosing models per task. Every structured call sends `temperature: 0` and `max_tokens`
 * with a strict JSON schema. OpenAI's reasoning models (o-series, GPT-5) reject those
 * parameters on Chat Completions, so use non-reasoning chat models unless your gateway
 * translates them. "Test connection" in the Admin Console checks each configured model.
 *
 * - Statement extraction (LLM_MODEL): precision over speed. A capable model with reliable
 *   strict JSON-schema output and a long context window (statements are up to ~120k
 *   characters). Mid-size (default gpt-4.1-mini) for typical statements, a larger model
 *   (e.g. gpt-4.1) for long multi-asset statements with many option legs; avoid
 *   "nano"-class models, which drop rows and flip signs.
 * - Analysis (LLM_ANALYSIS_MODEL): the strongest instruction-following model you can
 *   afford, because it decides which facts are dated and sourced and writes the ideas.
 * - Web research (LLM_RESEARCH_MODEL): a fast, inexpensive model that supports the chosen
 *   search provider; depth matters less because uncited output is withheld. Unused with
 *   Brave Search, which supplies results directly to the analysis model.
 */

export type AiSettingGroup = "provider" | "models" | "search" | "cost";
export type AiSettingKind = "text" | "secret" | "select" | "json" | "number";

export interface AiSettingOption {
  value: string;
  label: string;
  description: string;
}

export interface AiSettingDescriptor {
  key: string;
  group: AiSettingGroup;
  label: string;
  kind: AiSettingKind;
  help: string;
  /** Older environment variable names that also supply this setting. */
  envAliases: string[];
  /** Effective value when neither the Admin Console nor the environment sets one. */
  defaultValue: string;
  /** Shown when the default is empty or derived from another setting. */
  defaultLabel?: string;
  placeholder?: string;
  options?: AiSettingOption[];
}

export const AI_SETTING_GROUPS: Array<{ id: AiSettingGroup; title: string; description: string }> = [
  {
    id: "provider",
    title: "AI provider",
    description:
      "Call OpenAI directly, or route every model call through an OpenAI-compatible API gateway such as OpenRouter, LiteLLM, Cloudflare AI Gateway, Azure OpenAI or Portkey.",
  },
  {
    id: "models",
    title: "Models by task",
    description:
      "Each task has different needs. All structured calls send temperature 0 and max_tokens, which OpenAI's reasoning models (o-series, GPT-5) reject, so prefer non-reasoning chat models unless your gateway translates those parameters.",
  },
  {
    id: "search",
    title: "Web search",
    description:
      "Where research results come from. Whichever provider you choose, research without citations is withheld from the briefing.",
  },
  {
    id: "cost",
    title: "Cost estimation",
    description: "Prices used for the per-run cost estimates on the dashboard.",
  },
];

export const WEB_SEARCH_PROVIDERS: AiSettingOption[] = [
  {
    value: "openai",
    label: "OpenAI web search tool (Responses API)",
    description:
      "OpenAI's hosted search, at most 2 searches per instrument. Works with OpenAI directly and with gateways that pass requests through to OpenAI (Cloudflare AI Gateway, Helicone, Portkey).",
  },
  {
    value: "model",
    label: "Model's built-in search (Chat Completions)",
    description:
      "The research model's own web search via web_search_options, cited with url_citation annotations. Use with OpenRouter :online models, OpenAI search models or LiteLLM.",
  },
  {
    value: "brave",
    label: "Brave Search API",
    description:
      "LedgerPulse queries Brave's independent index itself with your Brave API key, limited to the briefing window. Source URLs come from Brave, not from a model, and any model provider works. The research model is not used.",
  },
];

export const AI_SETTINGS: AiSettingDescriptor[] = [
  {
    key: "LLM_BASE_URL",
    group: "provider",
    label: "API base URL (gateway)",
    kind: "text",
    envAliases: ["OPENAI_BASE_URL"],
    defaultValue: "",
    defaultLabel: "OpenAI API",
    placeholder: "https://openrouter.ai/api/v1",
    help: "OpenAI-compatible endpoint of an API gateway. Leave empty to call OpenAI directly. A query string such as ?api-version=… is sent with every request. Put credentials in the API key or headers, never in the URL.",
  },
  {
    key: "LLM_API_KEY",
    group: "provider",
    label: "API key",
    kind: "secret",
    envAliases: ["OPENAI_API_KEY"],
    defaultValue: "",
    defaultLabel: "Not set",
    help: "Sent as 'Authorization: Bearer'. Your OpenAI key, or your gateway's key. Optional only for gateways that need none. Stored encrypted.",
  },
  {
    key: "LLM_HEADERS",
    group: "provider",
    label: "Extra request headers (JSON)",
    kind: "secret",
    envAliases: [],
    defaultValue: "",
    defaultLabel: "None",
    placeholder: '{"cf-aig-authorization":"Bearer …"}',
    help: 'Gateway authentication or attribution headers as a JSON object, e.g. {"cf-aig-authorization":"Bearer …"} for Cloudflare AI Gateway or {"HTTP-Referer":"https://…"} for OpenRouter. Stored encrypted.',
  },
  {
    key: "LLM_MODEL",
    group: "models",
    label: "Statement extraction model",
    kind: "text",
    envAliases: ["OPENAI_MODEL"],
    defaultValue: "gpt-4.1-mini",
    placeholder: "gpt-4.1-mini",
    help: "Reads up to ~120,000 characters of statement text and returns every position in a strict JSON schema. A missed row or a flipped sign on a short position affects everything downstream, so favour precision: a capable model with reliable strict JSON-schema output and a long context window. Mid-size models (the default gpt-4.1-mini) handle typical daily statements; use a larger one (for example gpt-4.1) for long multi-asset statements with many option legs. Avoid 'nano'-class models.",
  },
  {
    key: "LLM_ANALYSIS_MODEL",
    group: "models",
    label: "Analysis model (evidence and ideas)",
    kind: "text",
    envAliases: [],
    defaultValue: "",
    defaultLabel: "Same as the extraction model",
    placeholder: "gpt-4.1",
    help: "Turns search results into dated, sourced facts, then writes the interpretation and up to two conditional ideas per stock. Reasoning quality shows most here, so use the strongest instruction-following model you can afford. It must support strict JSON-schema output.",
  },
  {
    key: "LLM_RESEARCH_MODEL",
    group: "models",
    label: "Web research model",
    kind: "text",
    envAliases: ["OPENAI_RESEARCH_MODEL"],
    defaultValue: "gpt-4.1-mini",
    placeholder: "gpt-4.1-mini",
    help: "Searches the web for each stock or ETF and writes cited notes. It must support the selected search provider: an OpenAI model with the hosted search tool (e.g. gpt-4.1-mini), or a search-enabled model for 'Model's built-in search' (an OpenRouter ':online' model, OpenAI's gpt-4o-mini-search-preview). A fast, inexpensive model is enough because uncited output is withheld. Not used with Brave Search.",
  },
  {
    key: "WEB_SEARCH_PROVIDER",
    group: "search",
    label: "Search provider",
    kind: "select",
    envAliases: [],
    defaultValue: "openai",
    options: WEB_SEARCH_PROVIDERS,
    help: "Where research results come from for each stock or ETF.",
  },
  {
    key: "BRAVE_SEARCH_API_KEY",
    group: "search",
    label: "Brave Search API key",
    kind: "secret",
    envAliases: [],
    defaultValue: "",
    defaultLabel: "Not set",
    help: "Subscription token from the Brave Search API dashboard (sent as X-Subscription-Token). Required when the provider is Brave Search. Stored encrypted.",
  },
  {
    key: "BRAVE_SEARCH_ENDPOINT",
    group: "search",
    label: "Brave endpoint",
    kind: "select",
    envAliases: [],
    defaultValue: "news",
    options: [
      {
        value: "news",
        label: "News search (recommended)",
        description: "News articles with publication dates, which the date gate needs.",
      },
      {
        value: "web",
        label: "Web search",
        description: "Broader results, plus news when Brave detects it. Use it if your plan lacks news search.",
      },
    ],
    help: "Which Brave Search endpoint to query.",
  },
  {
    key: "BRAVE_SEARCH_COST_PER_1K",
    group: "search",
    label: "Brave price per 1,000 requests (USD)",
    kind: "number",
    envAliases: [],
    defaultValue: "0",
    placeholder: "0",
    help: "Your Brave plan's price per 1,000 requests, so cost estimates include search fees. Leave 0 on the free tier.",
  },
  {
    key: "LLM_PRICING",
    group: "cost",
    label: "Model prices (JSON)",
    kind: "json",
    envAliases: [],
    defaultValue: "",
    defaultLabel: "Built-in OpenAI prices",
    placeholder: '{"vendor/model":{"input":3,"output":15}}',
    help: "Prices for models the built-in table doesn't know: USD per 1M input/output tokens, optional searchPer1k. Gateway ids such as openai/gpt-4.1-mini:online already price as the base model. Unknown models are estimated at gpt-4.1-mini rates.",
  },
];

export const AI_SETTING_KEYS = AI_SETTINGS.map((setting) => setting.key);

export function aiSettingDescriptor(key: string): AiSettingDescriptor | undefined {
  return AI_SETTINGS.find((setting) => setting.key === key);
}
