import type { BraveEndpoint } from "./llm-config";
import { isValidIsoDate } from "./models";
import { normalizeHttpUrl } from "./urls";

/**
 * Brave Search API client (https://api.search.brave.com). Used when WEB_SEARCH_PROVIDER is
 * "brave": LedgerPulse runs the search itself, so every source URL comes from Brave's index
 * rather than from a model, and any model provider can do the analysis.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  /** YYYY-MM-DD from Brave's page_age, when it provides one. */
  published: string | null;
  host: string;
}

export class BraveSearchError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "BraveSearchError";
  }
}

interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  page_age?: unknown;
  meta_url?: { hostname?: unknown };
}

interface BraveResponse {
  results?: BraveResult[];
  web?: { results?: BraveResult[] };
  news?: { results?: BraveResult[] };
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

/** Snippets can carry highlight markup and HTML entities; keep plain, bounded text. */
function cleanText(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function describeFailure(response: Response): Promise<string> {
  const { status } = response;
  if (status === 401 || status === 403) {
    return `Brave Search rejected the API key (HTTP ${status}). Check BRAVE_SEARCH_API_KEY and that your plan includes this endpoint.`;
  }
  if (status === 429) {
    return "Brave Search rate limit or plan quota reached (HTTP 429). Try again later or raise the plan limit.";
  }
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { detail?: unknown } };
    if (typeof body.error?.detail === "string") {
      detail = body.error.detail.replace(/\s+/g, " ").slice(0, 160);
    }
  } catch {
    // Non-JSON error body; the status code is enough.
  }
  return `Brave Search request failed (HTTP ${status})${detail ? `: ${detail}` : "."}`;
}

export async function braveSearch(params: {
  query: string;
  apiKey: string;
  endpoint: BraveEndpoint;
  baseUrl: string;
  /** Brave freshness filter, e.g. "pw" or "2026-11-09to2026-11-16". */
  freshness?: string;
  count?: number;
  timeoutMs?: number;
}): Promise<WebSearchResult[]> {
  const count = Math.max(1, Math.min(params.count ?? 10, params.endpoint === "web" ? 20 : 50));
  const url = new URL(`${params.baseUrl}/${params.endpoint}/search`);
  url.searchParams.set("q", params.query.slice(0, 400));
  url.searchParams.set("count", String(count));
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }
  if (params.endpoint === "web") {
    url.searchParams.set("result_filter", "news,web");
    url.searchParams.set("text_decorations", "false");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": params.apiKey },
      signal: AbortSignal.timeout(params.timeoutMs ?? 20_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new BraveSearchError(
      0,
      timedOut ? "Brave Search timed out. Try again." : "Could not reach Brave Search. Check network access."
    );
  }
  if (!response.ok) {
    throw new BraveSearchError(response.status, await describeFailure(response));
  }

  const body = (await response.json()) as BraveResponse;
  const raw =
    params.endpoint === "news"
      ? (body.results ?? [])
      : [...(body.news?.results ?? []), ...(body.web?.results ?? [])];

  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const item of raw) {
    const link = typeof item.url === "string" ? normalizeHttpUrl(item.url) : null;
    if (!link || seen.has(link)) continue;
    seen.add(link);
    const pageDate = typeof item.page_age === "string" ? item.page_age.slice(0, 10) : null;
    const hostname = typeof item.meta_url?.hostname === "string" ? item.meta_url.hostname : new URL(link).host;
    results.push({
      title: cleanText(item.title, 200),
      url: link,
      description: cleanText(item.description, 600),
      published: isValidIsoDate(pageDate) ? pageDate : null,
      host: cleanText(hostname, 100),
    });
    if (results.length >= count) break;
  }
  return results;
}
