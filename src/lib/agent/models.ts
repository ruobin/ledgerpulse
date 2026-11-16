import { z } from "zod";

export const AssetTypeSchema = z.enum(["stock", "etf", "option", "bond", "cash", "other"]);

export const InstrumentSchema = z
  .object({
    symbol: z.string().describe("Ticker or exact broker instrument identifier; empty if unavailable"),
    name: z.string(),
    exchange: z.string().describe("Exchange if explicitly present, otherwise empty"),
    asset_type: AssetTypeSchema,
    currency: z.string(),
    holding_quantity: z
      .string()
      .nullable()
      .describe("ONLY explicit open/closing quantity as a decimal string; never a trade quantity"),
    activity: z.string().describe("Brief observed trade activity, or empty"),
    source_page: z.number().int().min(1),
    evidence: z.string().describe("Short verbatim excerpt supporting identity and quantity"),
  })
  .strict();

export type Instrument = z.infer<typeof InstrumentSchema>;

export const StatementKindSchema = z.enum(["holdings", "activity", "unknown"]);

export const StatementSchema = z
  .object({
    kind: StatementKindSchema,
    as_of: z.string().nullable().describe("Explicit holdings date in YYYY-MM-DD format; null if absent"),
    period: z.string().describe("Statement reporting period as written, or empty"),
    instruments: z.array(InstrumentSchema),
    warnings: z.array(z.string()),
  })
  .strict();

export type Statement = z.infer<typeof StatementSchema>;

export const SourceSchema = z
  .object({
    title: z.string(),
    url: z.string(),
  })
  .strict();

export type Source = z.infer<typeof SourceSchema>;

export const NewsFactSchema = z
  .object({
    headline: z.string(),
    publication_date: z.string().nullable().describe("Explicit publication date in YYYY-MM-DD format; null if absent"),
    summary: z.string(),
    source_ids: z.array(z.number().int()),
  })
  .strict();

export type NewsFact = z.infer<typeof NewsFactSchema>;

export const TradingIdeaSchema = z
  .object({
    trigger: z.string(),
    possible_action: z.string(),
    counterargument: z.string(),
    missing_evidence: z.string(),
  })
  .strict();

export type TradingIdea = z.infer<typeof TradingIdeaSchema>;

export const EvidenceSchema = z
  .object({
    news: z.array(NewsFactSchema),
    limitations: z.array(z.string()),
  })
  .strict();

export type Evidence = z.infer<typeof EvidenceSchema>;

export const ScenariosSchema = z
  .object({
    interpretation: z.string(),
    ideas: z.array(TradingIdeaSchema),
  })
  .strict();

export type Scenarios = z.infer<typeof ScenariosSchema>;

export const AnalysisSchema = z
  .object({
    news: z.array(NewsFactSchema),
    interpretation: z.string(),
    ideas: z.array(TradingIdeaSchema),
    limitations: z.array(z.string()),
  })
  .strict();

export type Analysis = z.infer<typeof AnalysisSchema>;

export const ResearchStatusSchema = z.enum(["cited", "unverified", "failed", "unsupported"]);

export const ResearchSchema = z
  .object({
    instrument: z.string(),
    status: ResearchStatusSchema,
    markdown: z.string(),
    sources: z.array(SourceSchema).default([]),
    search_calls: z.number().int().default(0),
    usage: z
      .object({
        input_tokens: z.number().int().default(0),
        output_tokens: z.number().int().default(0),
        total_tokens: z.number().int().default(0),
      })
      .default({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
    latency_ms: z.number().int().default(0),
    excluded_news_count: z.number().int().default(0),
    /** Estimated USD for this instrument's search and model calls, priced per model. */
    cost_usd: z.number().optional(),
  })
  .strict();

export type Research = z.infer<typeof ResearchSchema>;

function isFiniteDecimalString(val: string): boolean {
  const trimmed = val.trim();
  if (!trimmed) return false;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed) && Number.isFinite(Number(trimmed));
}

export function isValidIsoDate(val: string | null | undefined): val is string {
  if (!val) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const parsed = new Date(`${val}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(val);
}

/**
 * Validate provenance bounds, enforce activity-vs-holdings isolation,
 * and consolidate duplicate instrument records.
 */
export function validatedStatement(statement: Statement, pageCount?: number): Statement {
  const cloned: Statement = structuredClone(statement);
  const warnings = [...cloned.warnings];

  if (cloned.kind !== "holdings") {
    cloned.as_of = null;
  } else if (cloned.as_of && !isValidIsoDate(cloned.as_of)) {
    warnings.push(`Invalid holdings date "${cloned.as_of}" omitted.`);
    cloned.as_of = null;
  }

  const seen = new Map<string, Instrument>();
  const conflicted = new Set<string>();

  for (const item of cloned.instruments) {
    item.symbol = item.symbol.trim().toUpperCase();
    item.name = item.name.trim();
    item.exchange = item.exchange.trim();

    if (!item.symbol && !item.name) {
      throw new Error("Instrument needs a symbol or name");
    }
    if (pageCount !== undefined && item.source_page > pageCount) {
      throw new Error("Extracted source page is outside the input document");
    }

    if (cloned.kind !== "holdings") {
      item.holding_quantity = null;
    } else if (item.holding_quantity !== null) {
      const cleanedQty = item.holding_quantity.replace(/,/g, "").trim();
      if (!isFiniteDecimalString(cleanedQty)) {
        throw new Error(`Quantity must be finite for ${item.symbol || item.name}`);
      }
      item.holding_quantity = cleanedQty;
    }

    const key = `${item.symbol || item.name}|${item.exchange}|${item.asset_type}`;
    const existing = seen.get(key);
    if (existing) {
      // null means "no explicit quantity on this row" (e.g. a trade line), not zero, so it
      // never conflicts with an explicit quantity. Two different explicit quantities do
      // conflict; the quantity is then omitted for good, whatever later rows say.
      if (!conflicted.has(key) && item.holding_quantity !== null) {
        if (existing.holding_quantity === null) {
          existing.holding_quantity = item.holding_quantity;
        } else if (Number(existing.holding_quantity) !== Number(item.holding_quantity)) {
          existing.holding_quantity = null;
          conflicted.add(key);
          warnings.push(
            `Conflicting quantities for ${item.symbol || item.name}; quantity omitted. Review the PDF.`
          );
        }
      }
      if (item.activity && item.activity !== existing.activity) {
        existing.activity = existing.activity ? `${existing.activity} | ${item.activity}` : item.activity;
      }
    } else {
      seen.set(key, item);
    }
  }

  cloned.instruments = Array.from(seen.values());
  if (cloned.kind !== "holdings") {
    warnings.push("Current holdings are unknown. Instruments below are a watchlist from statement activity.");
  }
  cloned.warnings = Array.from(new Set(warnings));
  return cloned;
}
