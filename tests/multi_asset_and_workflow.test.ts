import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { type Instrument, type Statement, validatedStatement } from "@/lib/agent/models";
import { extractStatement, researchInstrument, synthesizeResearch } from "@/lib/agent/services";
import { buildIngestionGraph, runBriefing } from "@/lib/agent/workflow";
import { OperationalStore } from "@/lib/db/store";
import { syncAndAnalyzeIbkrFromGmail } from "@/lib/gmail/client";

function build58PositionIbkrFixture(): {
  rawText: string;
  instruments: Instrument[];
} {
  const stocks: Array<[string, string, string, string, string, number]> = [
    ["2513", "Z AI CO LTD", "SEHK", "HKD", "500", 9],
    ["AMZN", "AMAZON.COM INC", "NASDAQ", "USD", "105", 9],
    ["ASML", "ASML HOLDING NV-NY REG SHS", "NASDAQ", "USD", "30", 9],
    ["ASTS", "AST SPACEMOBILE INC", "NASDAQ", "USD", "400", 9],
    ["AVAV", "AEROVIRONMENT INC", "NASDAQ", "USD", "270", 9],
    ["AVGO", "BROADCOM INC", "NASDAQ", "USD", "110", 9],
    ["CRWV", "COREWEAVE INC-CL A", "NASDAQ", "USD", "350", 9],
    ["GOOG", "ALPHABET INC-CL C", "NASDAQ", "USD", "40", 9],
    ["GRAB", "GRAB HOLDINGS LTD - CL A", "NASDAQ", "USD", "3500", 9],
    ["HII", "HUNTINGTON INGALLS INDUSTRIE", "NYSE", "USD", "120", 9],
    ["INTC", "INTEL CORP", "NASDAQ", "USD", "390", 9],
    ["LMT", "LOCKHEED MARTIN CORP", "NYSE", "USD", "50", 9],
    ["META", "META PLATFORMS INC-CLASS A", "NASDAQ", "USD", "70", 9],
    ["MSFT", "MICROSOFT CORP", "NASDAQ", "USD", "110", 9],
    ["MU", "MICRON TECHNOLOGY INC", "NASDAQ", "USD", "15", 9],
    ["NBIS", "NEBIUS GROUP NV", "NASDAQ", "USD", "140", 9],
    ["NET", "CLOUDFLARE INC - CLASS A", "NYSE", "USD", "60", 9],
    ["NFLX", "NETFLIX INC", "NASDAQ", "USD", "920", 9],
    ["NVDA", "NVIDIA CORP", "NASDAQ", "USD", "250", 9],
    ["ORCL", "ORACLE CORP", "NYSE", "USD", "370", 9],
    ["PANW", "PALO ALTO NETWORKS INC", "NASDAQ", "USD", "45", 10],
    ["PLTR", "PALANTIR TECHNOLOGIES INC-A", "NASDAQ", "USD", "100", 10],
    ["RKLB", "ROCKET LAB CORP", "NASDAQ", "USD", "180", 10],
    ["RXRX", "RECURSION PHARMACEUTICALS-A", "NASDAQ", "USD", "5000", 10],
    ["SKHY", "SK HYNIX INC-ADR", "NASDAQ", "USD", "260", 10],
    ["SNDK", "SANDISK CORP", "NASDAQ", "USD", "0", 10],
    ["SPCX", "SPACE EXPLORATION TECHN-CL A", "NASDAQ", "USD", "280", 10],
    ["TSLA", "TESLA INC", "NASDAQ", "USD", "110", 10],
    ["VST", "VISTRA CORP", "NYSE", "USD", "100", 10],
  ];

  const etfs: Array<[string, string, string, string, string, number]> = [
    ["DRAM", "ROUNDHILL MEMORY ETF", "BATS", "USD", "800", 9],
    ["QQQ", "INVESCO QQQ TRUST SERIES 1", "NASDAQ", "USD", "-315", 10],
  ];

  const options: Array<[string, string]> = [
    ["AAPL 18DEC26 265 P", "1"],
    ["AAPL 18DEC26 345 P", "-1"],
    ["AAPL 19FEB27 250 P", "1"],
    ["AAPL 19FEB27 360 P", "-1"],
    ["AMZN 19MAR27 185 P", "2"],
    ["AMZN 19MAR27 305 P", "-2"],
    ["DRAM 18DEC26 30 P", "4"],
    ["DRAM 18DEC26 70 P", "-4"],
    ["GOOG 18DEC26 280 P", "2"],
    ["GOOG 18DEC26 380 P", "-2"],
    ["INTC 17JUN27 45 P", "2"],
    ["INTC 17JUN27 160 P", "-2"],
    ["MSFT 15JAN27 270 P", "1"],
    ["MSFT 15JAN27 530 P", "-1"],
    ["MSFT 19MAR27 400 P", "1"],
    ["MSFT 19MAR27 605 P", "-1"],
    ["NVDA 19FEB27 175 P", "1"],
    ["NVDA 19FEB27 265 P", "-1"],
    ["NVDA 19MAR27 180 P", "4"],
    ["NVDA 19MAR27 280 P", "-4"],
    ["ORCL 19MAR27 100 P", "1"],
    ["ORCL 19MAR27 200 P", "-1"],
    ["QQQ 18DEC26 765 P", "-2"],
    ["SPCX 17JUN27 95 P", "3"],
    ["SPCX 17JUN27 165 P", "-3"],
    ["TSLA 17SEP27 230 P", "1"],
    ["TSLA 17SEP27 430 P", "-1"],
  ];

  const instruments: Instrument[] = [
    ...stocks.map(([symbol, name, exchange, currency, holding_quantity, source_page]) => ({
      symbol,
      name,
      exchange,
      asset_type: "stock" as const,
      currency,
      holding_quantity,
      activity: `Held ${holding_quantity} shares`,
      source_page,
      evidence: `${symbol} ${holding_quantity} ${currency}`,
    })),
    ...etfs.map(([symbol, name, exchange, currency, holding_quantity, source_page]) => ({
      symbol,
      name,
      exchange,
      asset_type: "etf" as const,
      currency,
      holding_quantity,
      activity: `Held ${holding_quantity} shares`,
      source_page,
      evidence: `${symbol} ${holding_quantity} ${currency}`,
    })),
    ...options.map(([symbol, holding_quantity]) => ({
      symbol,
      name: symbol,
      exchange: "CBOE",
      asset_type: "option" as const,
      currency: "USD",
      holding_quantity,
      activity: `Held ${holding_quantity} contracts`,
      source_page: 10,
      evidence: `${symbol} ${holding_quantity} 100 CP`,
    })),
  ];

  const page9 = instruments
    .filter((i) => i.source_page === 9)
    .map((i) => `${i.symbol} | ${i.name} | ${i.exchange} | ${i.holding_quantity} | ${i.currency}`)
    .join("\n");
  const page10 = instruments
    .filter((i) => i.source_page === 10)
    .map((i) => `${i.symbol} | ${i.name} | ${i.exchange} | ${i.holding_quantity} | ${i.currency}`)
    .join("\n");

  const rawText = `[PAGE 9]\nOpen Positions as of 2026-10-02\n${page9}\n\n[PAGE 10]\n${page10}`;
  return { rawText, instruments };
}

describe("LedgerPulse Multi-Asset & Workflow Integration Tests", () => {
  it("extracts, splits, validates, and persists a 58-position multi-asset IBKR statement", async () => {
    const { rawText, instruments } = build58PositionIbkrFixture();
    expect(instruments).toHaveLength(58);

    const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

    const extracted = await extractStatement(rawText, async (segment) => {
      // Force batch splitting when the segment contains more than 35 lines
      if (segment.split("\n").length > 35) {
        const err = new Error("Output token cap reached");
        err.name = "LengthFinishReasonError";
        throw err;
      }

      const matched: Instrument[] = [];
      for (const line of segment.split("\n")) {
        const sym = line.split(" | ")[0]?.trim();
        const found = sym ? bySymbol.get(sym) : undefined;
        if (found) matched.push(found);
      }
      return {
        kind: "holdings",
        as_of: "2026-10-02",
        period: "2026-10-02",
        instruments: matched,
        warnings: [],
      };
    });

    const validated = validatedStatement(extracted, 10);
    expect(validated.kind).toBe("holdings");
    expect(validated.as_of).toBe("2026-10-02");
    expect(validated.instruments).toHaveLength(58);
    expect(validated.instruments.find((i) => i.symbol === "QQQ")?.holding_quantity).toBe("-315");
    expect(validated.warnings.some((w) => w.includes("batches after an output-limit retry"))).toBe(true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-58pos-"));
    try {
      const store = new OperationalStore(tmpDir);
      const { snapshot_id } = store.saveSnapshot({
        userId: "usr_58",
        statement: validated,
        confirmed: true,
        sourceType: "upload",
      });
      const list = store.listSnapshots("usr_58");
      expect(list[0].snapshot_id).toBe(snapshot_id);
      expect(list[0].instrument_count).toBe(58);
      expect(list[0].stock_etf_count).toBe(31);
      expect(list[0].option_other_count).toBe(27);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("marks derivatives unsupported while isolating unverified and failed equity research", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-mixed-"));
    try {
      const store = new OperationalStore(tmpDir);
      const stmt: Statement = {
        kind: "holdings",
        as_of: "2026-10-02",
        period: "2026-10-02",
        instruments: [
          {
            symbol: "NVDA",
            name: "NVIDIA CORP",
            exchange: "NASDAQ",
            asset_type: "stock",
            currency: "USD",
            holding_quantity: "250",
            activity: "Held 250",
            source_page: 1,
            evidence: "NVDA 250",
          },
          {
            symbol: "ASML",
            name: "ASML HOLDING NV",
            exchange: "NASDAQ",
            asset_type: "stock",
            currency: "USD",
            holding_quantity: "30",
            activity: "Held 30",
            source_page: 1,
            evidence: "ASML 30",
          },
          {
            symbol: "NVDA 19MAR27 280 P",
            name: "NVDA 19MAR27 280 P",
            exchange: "CBOE",
            asset_type: "option",
            currency: "USD",
            holding_quantity: "-4",
            activity: "Short 4 contracts",
            source_page: 1,
            evidence: "NVDA 19MAR27 280 P -4",
          },
        ],
        warnings: [],
      };

      const res = await runBriefing({
        userId: "usr_mixed",
        statement: stmt,
        confirmed: true,
        maxInstruments: 3,
        store,
        researcher: async (item, start, end, lang) => {
          if (item.asset_type === "option") {
            return researchInstrument(item, start, end, lang);
          }
          if (item.symbol === "ASML") {
            return {
              instrument: "ASML",
              status: "unverified",
              markdown: "UNVERIFIED_PRICE_TARGET_9999",
              sources: [],
              search_calls: 1,
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
              latency_ms: 10,
              excluded_news_count: 0,
            };
          }
          return {
            instrument: "NVDA",
            status: "cited",
            markdown: "Verified NVDA news [Source 1](<https://example.com/nvda>).",
            sources: [{ title: "Reuters", url: "https://example.com/nvda" }],
            search_calls: 1,
            usage: { input_tokens: 500, output_tokens: 150, total_tokens: 650 },
            latency_ms: 20,
            excluded_news_count: 1,
          };
        },
      });

      expect(res.research.map((r) => r.status)).toEqual(["cited", "unverified", "unsupported"]);
      expect(res.markdown).toContain("Verified NVDA news");
      expect(res.markdown).not.toContain("UNVERIFIED_PRICE_TARGET_9999");
      expect(res.markdown).toContain("outside equity/ETF news scope");
      expect(res.telemetry.citation_rate).toBe(0.5); // 1 cited / 2 researched equities
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("isolates Stage-2 scenario generation from undated and out-of-window news", async () => {
    const stage2Inputs: string[] = [];
    const output = await synthesizeResearch(
      {
        instrument: "MSFT",
        status: "cited",
        markdown: "Raw snippet with $500 price quote and UNDATED_BREACH_STORY",
        sources: [{ title: "Axios", url: "https://example.com/msft" }],
        search_calls: 1,
        usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
        latency_ms: 5,
        excluded_news_count: 0,
      },
      "2026-09-27T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z",
      "English",
      {
        extractEvidence: async () => ({
          news: [
            {
              headline: "Dated event",
              publication_date: "2026-10-01",
              summary: "DATED_ACCEPTED_EVENT",
              source_ids: [0],
            },
            {
              headline: "Undated breach",
              publication_date: null,
              summary: "UNDATED_BREACH_STORY",
              source_ids: [0],
            },
            {
              headline: "Old event",
              publication_date: "2025-05-01",
              summary: "STALE_2025_EVENT",
              source_ids: [0],
            },
          ],
          limitations: ["Snippet only"],
        }),
        generateScenarios: async (payload) => {
          stage2Inputs.push(payload);
          return {
            interpretation: "Based strictly on DATED_ACCEPTED_EVENT.",
            ideas: [],
          };
        },
      }
    );

    expect(stage2Inputs).toHaveLength(1);
    expect(stage2Inputs[0]).toContain("DATED_ACCEPTED_EVENT");
    expect(stage2Inputs[0]).not.toContain("UNDATED_BREACH_STORY");
    expect(stage2Inputs[0]).not.toContain("STALE_2025_EVENT");
    expect(output.excluded_news_count).toBe(2);
    expect(output.markdown).toContain("Excluded 2 item(s)");
  });

  it("runs ingestion graph, redacts PII, and deduplicates Gmail IBKR syncs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-gmail-test-"));
    try {
      const store = new OperationalStore(tmpDir);
      const ibkrBody = Buffer.from(
        "Account Number: U8887776\nEmail: owner@example.com\nNVDA 250 NASDAQ\n",
        "utf8"
      );

      const first = await syncAndAnalyzeIbkrFromGmail({
        userId: "usr_sync",
        store,
        runBriefingAfter: false,
        extractor: async (sanitizedText) => {
          expect(sanitizedText).not.toContain("U8887776");
          expect(sanitizedText).not.toContain("owner@example.com");
          return {
            kind: "holdings",
            as_of: "2026-11-15",
            period: "2026-11-15",
            instruments: [
              {
                symbol: "NVDA",
                name: "NVIDIA CORP",
                exchange: "NASDAQ",
                asset_type: "stock",
                currency: "USD",
                holding_quantity: "250",
                activity: "Held 250",
                source_page: 1,
                evidence: "NVDA 250 NASDAQ",
              },
            ],
            warnings: [],
          };
        },
        mockAttachment: {
          messageId: "msg_100",
          subject: "Daily Activity Statement",
          receivedAt: "2026-11-15T22:00:00Z",
          filename: "Daily_Activity_Statement.txt",
          pdfBuffer: ibkrBody,
        },
      });

      expect(first.syncStatus).toBe("ingested");
      expect(first.instrumentCount).toBe(1);

      const second = await syncAndAnalyzeIbkrFromGmail({
        userId: "usr_sync",
        store,
        mockAttachment: {
          messageId: "msg_100",
          subject: "Daily Activity Statement",
          receivedAt: "2026-11-15T22:00:00Z",
          filename: "Daily_Activity_Statement.txt",
          pdfBuffer: ibkrBody,
        },
      });
      expect(second.syncStatus).toBe("skipped_duplicate");
      expect(second.snapshotId).toBe(first.snapshotId);

      // Also verify ingestion graph rejects out-of-range source_page
      const graph = buildIngestionGraph(async () => ({
        kind: "holdings",
        as_of: "2026-11-15",
        period: "2026-11-15",
        instruments: [
          {
            symbol: "NVDA",
            name: "NVIDIA CORP",
            exchange: "NASDAQ",
            asset_type: "stock",
            currency: "USD",
            holding_quantity: "250",
            activity: "Held 250",
            source_page: 99,
            evidence: "NVDA 250",
          },
        ],
        warnings: [],
      }));
      await expect(graph.invoke({ text: "test", pageCount: 2 })).rejects.toThrow("outside");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
