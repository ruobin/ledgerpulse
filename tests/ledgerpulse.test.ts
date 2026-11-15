import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runEvaluationSuite } from "@/lib/agent/evals";
import { validatedStatement } from "@/lib/agent/models";
import { readDocument, safeError } from "@/lib/agent/services";
import { OperationalStore } from "@/lib/db/store";
import { computeRunTelemetry, estimateCostUsd } from "@/lib/telemetry";
import { isTradingWeekday } from "@/worker/scheduler";

describe("LedgerPulse Production Guardrails & Evaluation Suite", () => {
  it("passes all 15 deterministic evaluation invariants", async () => {
    const summary = await runEvaluationSuite();
    expect(summary.overall_passed).toBe(summary.overall_total);
    expect(summary.overall_score).toBe(1.0);
  });

  it("rejects non-PDF bytes claiming .pdf extension and redacts PII from text", async () => {
    await expect(readDocument(Buffer.from("not a pdf"), "bad.pdf")).rejects.toThrow("PDF signature");

    const { text, pages, piiRedactions } = await readDocument(
      Buffer.from("Account Number: U123456\nSSN: 123-45-6789\nBUY NVDA 10 shares NASDAQ\n"),
      "statement.txt"
    );
    expect(pages).toBe(1);
    expect(text).not.toContain("U123456");
    expect(text).not.toContain("123-45-6789");
    expect(text).toContain("BUY NVDA 10 shares NASDAQ");
    expect(Object.values(piiRedactions).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
  });

  it("sanitizes secret tokens from provider error messages", () => {
    const err = new Error("Bearer sk-proj-super-secret-value-12345");
    expect(safeError(err)).not.toContain("sk-proj");
  });

  it("enforces trading-day weekday check in target timezone", () => {
    // 2026-11-16 is a Monday; 2026-11-15 is a Sunday
    expect(isTradingWeekday(new Date("2026-11-16T15:00:00Z"), "America/New_York")).toBe(true);
    expect(isTradingWeekday(new Date("2026-11-15T15:00:00Z"), "America/New_York")).toBe(false);
  });

  it("calculates token telemetry, USD cost, and outbox delivery retry", () => {
    const cost = estimateCostUsd("gpt-4.1-mini", 10_000, 1_000, 1);
    expect(cost).toBeGreaterThan(0);

    const tel = computeRunTelemetry(
      [
        {
          instrument: "NVDA",
          status: "cited",
          markdown: "Excluded 2 item(s) with missing/out-of-window dates",
          search_calls: 1,
          usage: { input_tokens: 8000, output_tokens: 800, total_tokens: 8800 },
        },
      ],
      "gpt-4.1-mini",
      350
    );
    expect(tel.citation_rate).toBe(1.0);
    expect(tel.excluded_news_count).toBe(2);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-outbox-"));
    try {
      const store = new OperationalStore(tmpDir);
      const validated = validatedStatement({
        kind: "holdings",
        as_of: "2026-10-02",
        period: "Oct",
        instruments: [],
        warnings: [],
      });
      store.saveSnapshot({ userId: "usr_1", statement: validated, confirmed: true, snapshotId: "s1" });
      store.enqueueDelivery({
        userId: "usr_1",
        runId: "r1",
        channel: "email",
        destination: "user@example.com",
        confirmed: true,
      });
      const processed = store.processOutbox();
      expect(processed).toHaveLength(1);
      expect(processed[0].status).toBe("sent");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
