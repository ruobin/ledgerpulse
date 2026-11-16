import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { type Instrument, validatedStatement } from "@/lib/agent/models";
import { normalizeHttpUrl, normalizeResearchFromResponse } from "@/lib/agent/services";
import { runBriefing } from "@/lib/agent/workflow";
import { OperationalStore } from "@/lib/db/store";
import { syncAndAnalyzeIbkrFromGmail } from "@/lib/gmail/client";
import { redactPii } from "@/lib/telemetry";

const noUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function nvda(holding_quantity: string | null): Instrument {
  return {
    symbol: "NVDA",
    name: "NVIDIA CORP",
    exchange: "NASDAQ",
    asset_type: "stock",
    currency: "USD",
    holding_quantity,
    activity: "",
    source_page: 1,
    evidence: "NVDA",
  };
}

const holdings = (...instruments: Instrument[]) =>
  validatedStatement({ kind: "holdings", as_of: "2026-10-02", period: "", instruments, warnings: [] });

describe("statement consolidation", () => {
  it("keeps an explicit quantity when a duplicate row has none", () => {
    // e.g. the same instrument in Open Positions (quantity) and in Trades (no quantity)
    for (const rows of [
      [nvda("250"), nvda(null)],
      [nvda(null), nvda("250")],
    ]) {
      const statement = holdings(...rows);
      expect(statement.instruments).toHaveLength(1);
      expect(statement.instruments[0].holding_quantity).toBe("250");
      expect(statement.warnings).toEqual([]);
    }
  });

  it("treats numerically equal quantities as the same position", () => {
    const statement = holdings(nvda("-315"), nvda("-315.0000"));
    expect(statement.instruments[0].holding_quantity).toBe("-315");
    expect(statement.warnings).toEqual([]);
  });

  it("omits genuinely conflicting quantities for good", () => {
    const statement = holdings(nvda("10"), nvda("4"), nvda("10"));
    expect(statement.instruments[0].holding_quantity).toBeNull();
    expect(statement.warnings.filter((w) => w.includes("Conflicting"))).toHaveLength(1);
  });
});

describe("PII redaction", () => {
  it("removes unlabeled IBKR account ids but keeps instrument identifiers", () => {
    const { sanitized, counts } = redactPii(
      "Account U1234567\nAccount: DU7654321 Individual\nAAPL US0378331005 100 USD\nNVDA 250 NASDAQ"
    );
    expect(sanitized).not.toMatch(/U1234567|DU7654321/);
    expect(sanitized).toContain("AAPL US0378331005 100 USD");
    expect(sanitized).toContain("NVDA 250 NASDAQ");
    expect(counts.ibkr_account_id).toBe(2);
  });
});

describe("citation rendering", () => {
  it("renders a single link when two citations share a span", () => {
    const text = "NVDA rose after earnings (reuters.com).";
    const start = text.indexOf("(reuters.com)");
    const span = { start_index: start, end_index: start + "(reuters.com)".length };

    const research = normalizeResearchFromResponse(
      "NVDA",
      [
        {
          text,
          annotations: [
            { url: "https://a.example/1", title: "A", ...span },
            { url: "https://b.example/2", title: "B", ...span },
          ],
        },
      ],
      1,
      noUsage
    );

    expect(research.markdown).toBe("NVDA rose after earnings [A](<https://a.example/1>).");
    expect(research.sources.map((s) => s.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  it("applies adjacent citations and skips overlapping ones without corrupting text", () => {
    const render = (annotations: Array<{ url: string; title: string; start_index: number; end_index: number }>) =>
      normalizeResearchFromResponse("X", [{ text: "Alpha beta gamma.", annotations }], 1, noUsage).markdown;

    expect(
      render([
        { url: "https://a.example/", title: "A", start_index: 0, end_index: 5 },
        { url: "https://b.example/", title: "B", start_index: 5, end_index: 10 },
      ])
    ).toBe("[A](<https://a.example/>)[B](<https://b.example/>) gamma.");

    expect(
      render([
        { url: "https://a.example/", title: "A", start_index: 0, end_index: 10 },
        { url: "https://b.example/", title: "B", start_index: 6, end_index: 16 },
      ])
    ).toBe("Alpha [B](<https://b.example/>).");
  });

  it("only links canonical http(s) URLs without credentials", () => {
    expect(normalizeHttpUrl("https://example.com/a b?q=<x>")).toBe("https://example.com/a%20b?q=%3Cx%3E");
    expect(normalizeHttpUrl("https://:pw@example.com/")).toBeNull();
    expect(normalizeHttpUrl("https://user@example.com/")).toBeNull();
    expect(normalizeHttpUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("store and sync invariants", () => {
  let dataDir: string;
  let store: OperationalStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-regress-"));
    store = new OperationalStore(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("takes over expired leases but never steals an active one", () => {
    expect(store.acquireLease("job", "w1", 60)).toBe(true);
    expect(store.acquireLease("job", "w2", 60)).toBe(false);
    expect(store.acquireLease("job", "w1", 60)).toBe(true); // renewal by the owner
    store.releaseLease("job", "w2"); // a non-owner cannot release it
    expect(store.acquireLease("job", "w2", 60)).toBe(false);

    expect(store.acquireLease("stale", "w1", -1)).toBe(true); // already expired
    expect(store.acquireLease("stale", "w2", 60)).toBe(true);
  });

  it("never demotes a completed ingestion job", () => {
    const job = { userId: "usr_1", sourceType: "gmail" as const, attachmentSha256: "abc", filename: "s.pdf" };
    store.recordIngestionJob({ ...job, status: "completed", snapshotId: "snap_1" });
    store.recordIngestionJob({ ...job, status: "failed", errorMessage: "boom" });
    expect(store.hasProcessedAttachment("usr_1", "abc")).toEqual({ processed: true, snapshotId: "snap_1" });
  });

  it("records a failed ingestion and retries the attachment on the next sync", async () => {
    const mockAttachment = {
      messageId: "msg_retry",
      subject: "Daily Activity Statement",
      receivedAt: "2026-11-16T22:00:00Z",
      filename: "Daily_Activity_Statement.txt",
      pdfBuffer: Buffer.from("IBKR DAILY ACTIVITY STATEMENT\nNVDA NVIDIA CORP NASDAQ 250 USD\n", "utf8"),
    };

    await expect(
      syncAndAnalyzeIbkrFromGmail({
        userId: "usr_retry",
        store,
        mockAttachment,
        extractor: async () => {
          throw new Error("Model output truncated");
        },
      })
    ).rejects.toThrow("Model output truncated");
    const events = store.summaryMetrics("usr_retry").audit_events.map((e) => e.event_type);
    expect(events).toContain("gmail_ingestion_failed");

    const retry = await syncAndAnalyzeIbkrFromGmail({
      userId: "usr_retry",
      store,
      mockAttachment,
      sourceType: "sample",
      extractor: async () => ({
        kind: "holdings",
        as_of: "2026-11-16",
        period: "",
        instruments: [nvda("250")],
        warnings: [],
      }),
    });
    expect(retry.syncStatus).toBe("ingested");
    expect(store.listSnapshots("usr_retry")[0].source_type).toBe("sample");
  });

  it("records end-to-end briefing latency and rejects non-integer bounds", async () => {
    const result = await runBriefing({
      userId: "usr_latency",
      store,
      statement: holdings(nvda("250")),
      confirmed: true,
      researcher: async (item) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          instrument: item.symbol,
          status: "unverified",
          markdown: "",
          sources: [],
          search_calls: 0,
          usage: noUsage,
          latency_ms: 0, // the researcher reports nothing; the graph must still measure
          excluded_news_count: 0,
        };
      },
    });
    expect(result.telemetry.latency_ms).toBeGreaterThanOrEqual(20);
    expect(store.listRuns("usr_latency")[0].latency_ms).toBe(result.telemetry.latency_ms);

    await expect(runBriefing({ statement: holdings(nvda("1")), days: Number.NaN, store })).rejects.toThrow(
      "Choose 1-30 days"
    );
  });
});
