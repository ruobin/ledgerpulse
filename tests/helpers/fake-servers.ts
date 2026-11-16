import http from "http";
import type { AddressInfo } from "net";

/** Request bodies sent to the fake OpenAI-compatible gateway (fields the tests inspect). */
export interface GatewayRequestBody {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  store?: boolean;
  web_search_options?: unknown;
  tools?: Array<{ type?: string }>;
  response_format?: { type?: string; json_schema?: { name?: string } };
  messages?: Array<{ role: string; content: string }>;
}

export interface CapturedRequest {
  method: string;
  /** Path plus query string, e.g. "/v1/chat/completions?api-version=..." */
  path: string;
  headers: http.IncomingHttpHeaders;
  body: GatewayRequestBody;
}

export type Route = (req: CapturedRequest) => { status?: number; json: unknown };

/** A local JSON server that records every request; used as a fake gateway or Brave API. */
export async function startJsonServer(route: Route) {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as GatewayRequestBody) : {},
      };
      requests.push(captured);
      const { status = 200, json } = route(captured);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function chatCompletion(content: string, options: { annotations?: unknown[]; finishReason?: string } = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "gateway-model",
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason ?? "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content,
          refusal: null,
          ...(options.annotations ? { annotations: options.annotations } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

/** Clears every AI setting from the environment so tests never inherit the developer's shell. */
export const CLEAN_AI_ENV: Record<string, undefined> = {
  LLM_BASE_URL: undefined,
  LLM_API_KEY: undefined,
  LLM_HEADERS: undefined,
  LLM_MODEL: undefined,
  LLM_ANALYSIS_MODEL: undefined,
  LLM_RESEARCH_MODEL: undefined,
  LLM_PRICING: undefined,
  WEB_SEARCH_PROVIDER: undefined,
  BRAVE_SEARCH_API_KEY: undefined,
  BRAVE_SEARCH_ENDPOINT: undefined,
  BRAVE_SEARCH_COST_PER_1K: undefined,
  BRAVE_SEARCH_BASE_URL: undefined,
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_MODEL: undefined,
  OPENAI_RESEARCH_MODEL: undefined,
  OPENAI_ORG_ID: undefined,
  OPENAI_PROJECT_ID: undefined,
};
