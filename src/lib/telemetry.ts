import crypto from "crypto";
import type { Research } from "./agent/models";

interface PricingRate {
  input: number;
  output: number;
  searchPer1k: number;
}

const MODEL_PRICING_PER_1M: Record<string, PricingRate> = {
  "gpt-4.1-mini": { input: 0.4, output: 1.6, searchPer1k: 10.0 },
  "gpt-4.1": { input: 2.0, output: 8.0, searchPer1k: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, searchPer1k: 10.0 },
  "gpt-4o": { input: 2.5, output: 10.0, searchPer1k: 10.0 },
};

const DEFAULT_PRICING: PricingRate = { input: 0.4, output: 1.6, searchPer1k: 10.0 };

const PII_PATTERNS: Array<[string, RegExp]> = [
  [
    "account_or_contact_line",
    /^(?:account\s*(?:number|no\.?|id|holder|name)|address|email|phone|tel|mobile|tax\s*id|ssn|tin|iban|swift)\s*[:#].*$/gim,
  ],
  ["ssn_or_tin", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["inline_email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  // IBKR live (U1234567) and paper (DU1234567) account ids, which statement headers print
  // without a "Number:" label. ISINs such as US0378331005 do not match.
  ["ibkr_account_id", /\b(?:DU|U)\d{5,9}\b/g],
];

export function redactPii(text: string): { sanitized: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let sanitized = text;

  for (const [label, pattern] of PII_PATTERNS) {
    let matches = 0;
    sanitized = sanitized.replace(pattern, () => {
      matches += 1;
      return "[personal field removed]";
    });
    if (matches > 0) {
      counts[label] = matches;
    }
  }
  return { sanitized, counts };
}

export function extractExcludedCount(markdown: string): number {
  const match = /Excluded\s+(\d+)\s+item\(s\)/.exec(markdown || "");
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  searchCalls = 0
): number {
  const rates = MODEL_PRICING_PER_1M[model] ?? DEFAULT_PRICING;
  const tokenCost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  const searchCost = (searchCalls / 1_000) * rates.searchPer1k;
  return Number((tokenCost + searchCost).toFixed(6));
}

export interface RunTelemetry {
  instrument_count: number;
  cited_count: number;
  unverified_count: number;
  failed_count: number;
  unsupported_count: number;
  citation_rate: number;
  total_search_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  excluded_news_count: number;
  latency_ms: number;
}

export function computeRunTelemetry(
  researchItems: Array<Partial<Research>>,
  model = "gpt-4.1-mini",
  latencyMs = 0
): RunTelemetry {
  let totalInput = 0;
  let totalOutput = 0;
  let totalTokens = 0;
  let totalSearchCalls = 0;
  let excludedNewsCount = 0;
  let sumLatency = latencyMs;
  const statusCounts: Record<string, number> = {
    cited: 0,
    unverified: 0,
    failed: 0,
    unsupported: 0,
  };

  for (const item of researchItems) {
    const status = item.status ?? "failed";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    totalSearchCalls += Number(item.search_calls ?? 0);

    const usage = item.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const inTok = Number(usage.input_tokens ?? 0);
    const outTok = Number(usage.output_tokens ?? 0);
    const totTok = Number(usage.total_tokens ?? inTok + outTok);
    totalInput += inTok;
    totalOutput += outTok;
    totalTokens += totTok;

    const excluded =
      item.excluded_news_count && item.excluded_news_count > 0
        ? item.excluded_news_count
        : extractExcludedCount(item.markdown ?? "");
    excludedNewsCount += Number(excluded);

    if (!latencyMs && item.latency_ms) {
      sumLatency += Number(item.latency_ms);
    }
  }

  const researchedEquities = statusCounts.cited + statusCounts.unverified + statusCounts.failed;
  const citationRate =
    researchedEquities > 0 ? Number((statusCounts.cited / researchedEquities).toFixed(4)) : 1.0;

  return {
    instrument_count: researchItems.length,
    cited_count: statusCounts.cited,
    unverified_count: statusCounts.unverified,
    failed_count: statusCounts.failed,
    unsupported_count: statusCounts.unsupported,
    citation_rate: citationRate,
    total_search_calls: totalSearchCalls,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_tokens: totalTokens,
    estimated_cost_usd: estimateCostUsd(model, totalInput, totalOutput, totalSearchCalls),
    excluded_news_count: excludedNewsCount,
    latency_ms: sumLatency,
  };
}

const KEY_HELP = "Generate one with: openssl rand -hex 32";

/**
 * AES-256 key for OAuth tokens at rest. A configured key must be valid (it is never silently
 * replaced), and production refuses to run without one. Outside production a derived key is
 * used so local development works out of the box; it changes whenever OPENAI_API_KEY does.
 */
function resolveEncryptionKey(): Buffer {
  const configured = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (configured) {
    if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
      throw new Error(`TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes). ${KEY_HELP}`);
    }
    return Buffer.from(configured, "hex");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(`TOKEN_ENCRYPTION_KEY is required in production to encrypt Gmail OAuth tokens. ${KEY_HELP}`);
  }
  const seed = process.env.OPENAI_API_KEY?.trim() || "ledgerpulse-local-dev-ephemeral-key";
  return crypto.createHash("sha256").update(seed).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = resolveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted secret payload");
  }
  const key = resolveEncryptionKey();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error(
      "Stored Gmail credentials cannot be decrypted with the current encryption key " +
        "(TOKEN_ENCRYPTION_KEY, or OPENAI_API_KEY in development, likely changed since Gmail " +
        "was connected). Reconnect Gmail on the Automation page."
    );
  }
}
