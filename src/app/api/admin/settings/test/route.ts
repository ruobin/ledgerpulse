import { NextResponse } from "next/server";
import type OpenAI from "openai";
import { createLlmClient, loadAiConfig } from "@/lib/agent/llm";
import type { AiConfig } from "@/lib/agent/llm-config";
import { braveSearch } from "@/lib/agent/search";
import { safeError } from "@/lib/agent/services";

/**
 * "Test connection" for the Admin Console: one tiny request per configured model (a fraction
 * of a cent) plus a one-result Brave query when Brave is the search provider. Requests use the
 * same parameters as real runs, so incompatible models (e.g. reasoning models that reject
 * temperature 0) fail here rather than in the middle of a briefing.
 */

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs: number;
}

async function check(name: string, run: () => Promise<string>): Promise<CheckResult> {
  const started = performance.now();
  try {
    const detail = await run();
    return { name, ok: true, detail, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { name, ok: false, detail: safeError(err), latencyMs: Math.round(performance.now() - started) };
  }
}

async function pingStructuredModel(client: OpenAI, model: string): Promise<void> {
  await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 5,
    messages: [{ role: "user", content: "Reply with OK." }],
  });
}

async function researchCheck(client: OpenAI, config: AiConfig): Promise<CheckResult> {
  const model = config.models.research;
  if (config.webSearch === "brave") {
    return check(`Brave Search API (${config.brave.endpoint})`, async () => {
      if (!config.brave.apiKey) {
        throw new Error("No Brave API key is configured.");
      }
      const results = await braveSearch({
        query: "Interactive Brokers",
        apiKey: config.brave.apiKey,
        endpoint: config.brave.endpoint,
        baseUrl: config.brave.baseUrl,
        count: 1,
      });
      return `Reachable; returned ${results.length} result(s) for a sample query.`;
    });
  }
  if (config.webSearch === "openai") {
    return check(`Research model ${model} (Responses API)`, async () => {
      await client.responses.create({ model, input: "Reply with OK.", max_output_tokens: 16, store: false });
      return "Responses API reachable. The search tool itself is only used in real runs.";
    });
  }
  return check(`Research model ${model} (Chat Completions)`, async () => {
    // Search-enabled models reject temperature, so this mirrors the real research request.
    await client.chat.completions.create({ model, max_tokens: 5, messages: [{ role: "user", content: "Reply with OK." }] });
    return "Model reachable. Citations are checked on every real run.";
  });
}

export async function POST() {
  let config: AiConfig;
  try {
    config = loadAiConfig();
  } catch (err) {
    return NextResponse.json({ checks: [{ name: "Configuration", ok: false, detail: safeError(err), latencyMs: 0 }] });
  }

  const client = createLlmClient(config);
  const checks: CheckResult[] = [
    await check(`Extraction model ${config.models.extraction}`, async () => {
      await pingStructuredModel(client, config.models.extraction);
      return `Responded via ${config.endpointLabel}.`;
    }),
  ];
  if (config.models.analysis !== config.models.extraction) {
    checks.push(
      await check(`Analysis model ${config.models.analysis}`, async () => {
        await pingStructuredModel(client, config.models.analysis);
        return `Responded via ${config.endpointLabel}.`;
      })
    );
  }
  checks.push(await researchCheck(client, config));
  return NextResponse.json({ checks });
}
