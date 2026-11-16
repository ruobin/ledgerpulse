import fs from "fs";
import os from "os";
import path from "path";
import { OperationalStore } from "../db/store";
import { syncAndAnalyzeIbkrFromGmail } from "../gmail/client";
import { decryptSecret, encryptSecret, redactPii } from "../telemetry";
import { type Instrument, type Research, validatedStatement } from "./models";
import * as services from "./services";
import { buildIngestionGraph, runBriefing } from "./workflow";

export interface EvalCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvalSuite {
  category: string;
  passed: number;
  total: number;
  score: number;
  checks: EvalCheck[];
}

export interface EvalSummary {
  evaluated_at: string;
  overall_passed: number;
  overall_total: number;
  overall_score: number;
  suites: EvalSuite[];
}

function sampleInstrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    symbol: "NVDA",
    name: "NVIDIA Corporation",
    exchange: "NASDAQ",
    asset_type: "stock",
    currency: "USD",
    holding_quantity: "10",
    activity: "Bought 10",
    source_page: 1,
    evidence: "BUY NVDA 10",
    ...overrides,
  };
}

async function evalIngestionGuardrails(): Promise<EvalSuite> {
  const checks: EvalCheck[] = [];

  // 1. Activity statement forces holding_quantity=null
  const actStmt = validatedStatement({
    kind: "activity",
    as_of: "2026-10-02",
    period: "Oct 2026",
    instruments: [sampleInstrument()],
    warnings: [],
  });
  checks.push({
    name: "activity_holdings_zeroed",
    passed:
      actStmt.as_of === null &&
      actStmt.instruments[0].holding_quantity === null &&
      actStmt.warnings.some((w) => w.includes("Current holdings are unknown")),
    detail: "Activity-only statements force holding_quantity=null and as_of=null",
  });

  // 2. Conflicting duplicate quantities omitted
  const dupStmt = validatedStatement({
    kind: "holdings",
    as_of: "2026-10-02",
    period: "Oct 2026",
    instruments: [sampleInstrument({ holding_quantity: "10" }), sampleInstrument({ holding_quantity: "4" })],
    warnings: [],
  });
  checks.push({
    name: "conflicting_duplicate_quantity_omitted",
    passed:
      dupStmt.instruments.length === 1 &&
      dupStmt.instruments[0].holding_quantity === null &&
      dupStmt.warnings.some((w) => w.includes("Conflicting")),
    detail: "Conflicting duplicate quantities nulled with explicit warning",
  });

  // 3. Out-of-bounds source page rejected
  let pageRejected = false;
  try {
    await buildIngestionGraph(async () => ({
      kind: "holdings",
      as_of: "2026-10-02",
      period: "Oct",
      instruments: [sampleInstrument({ source_page: 5 })],
      warnings: [],
    })).invoke({ text: "test", pageCount: 2 });
  } catch (err) {
    pageRejected = err instanceof Error && err.message.includes("outside");
  }
  checks.push({
    name: "page_provenance_bounds_enforced",
    passed: pageRejected,
    detail: "Source page exceeding PDF page count rejected by ingestion graph",
  });

  // 4. Adaptive truncation recovery & line-boundary splitting preserves [PAGE N]
  const oversized =
    "[PAGE 9]\nClosing holdings as of 2026-10-02\n" +
    Array.from({ length: 80 }, (_, i) => `TEST${i} | Fictional Corp | 1 | USD`).join("\n");
  const budgets: number[] = [];
  const extracted = await services.extractStatement(oversized, async (segment, _ctx, budget) => {
    budgets.push(budget);
    if (segment.length > 1800) {
      const err = new Error("Truncated");
      err.name = "LengthFinishReasonError";
      throw err;
    }
    if (!segment.includes("[PAGE 9]")) {
      throw new Error("Lost page marker");
    }
    return {
      kind: "holdings",
      as_of: "2026-10-02",
      period: "Oct 2026",
      instruments: [
        sampleInstrument({
          symbol: segment.includes("TEST0") ? "LEFT" : "RIGHT",
          source_page: 9,
        }),
      ],
      warnings: [],
    };
  });
  const syms = new Set(extracted.instruments.map((i) => i.symbol));
  checks.push({
    name: "adaptive_truncation_and_page_marker_retention",
    passed: syms.has("LEFT") && syms.has("RIGHT") && budgets.includes(5000) && budgets.includes(16000),
    detail: "Escalates 5k->16k budget and recursively splits while preserving [PAGE N] provenance",
  });

  const passed = checks.filter((c) => c.passed).length;
  return {
    category: "Ingestion & Financial Schema Guardrails",
    passed,
    total: checks.length,
    score: Number((passed / checks.length).toFixed(4)),
    checks,
  };
}

async function evalEvidenceGrounding(): Promise<EvalSuite> {
  const checks: EvalCheck[] = [];

  // 1. Undated, stale, and invalid-source news excluded
  const rendered = services.renderAnalysis(
    {
      news: [
        { headline: "Undated", publication_date: null, summary: "SECRET_UNDATED", source_ids: [0] },
        { headline: "Stale", publication_date: "2025-01-01", summary: "SECRET_STALE", source_ids: [0] },
        { headline: "BadSource", publication_date: "2026-10-02", summary: "SECRET_BAD_SRC", source_ids: [99] },
      ],
      interpretation: "Should be withheld",
      ideas: [],
      limitations: [],
    },
    [{ title: "Valid", url: "https://example.com/1" }],
    "2026-09-27T00:00:00.000Z",
    "2026-10-04T00:00:00.000Z"
  );
  checks.push({
    name: "undated_stale_invalid_sources_excluded",
    passed:
      !rendered.includes("SECRET_") &&
      rendered.includes("Excluded 3 item(s)") &&
      rendered.includes("Insufficient dated evidence"),
    detail: "100% of undated, stale, and invalid-source claims excluded",
  });

  // 2. Two-stage synthesis isolation
  const stage2Payloads: string[] = [];
  const raw: Research = {
    instrument: "MSFT",
    status: "cited",
    markdown: "Raw markdown with CONTAMINATED_UNDATED_CLAIM and $499 quote",
    sources: [{ title: "S1", url: "https://example.com/s1" }],
    search_calls: 1,
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    latency_ms: 10,
    excluded_news_count: 0,
  };
  const synthesized = await services.synthesizeResearch(
    raw,
    "2026-09-27T00:00:00.000Z",
    "2026-10-04T00:00:00.000Z",
    "English",
    {
      extractEvidence: async () => ({
        news: [
          {
            headline: "Accepted",
            publication_date: "2026-10-02",
            summary: "VALID_FACT_ONLY",
            source_ids: [0],
          },
          {
            headline: "Rejected",
            publication_date: null,
            summary: "CONTAMINATED_UNDATED_CLAIM",
            source_ids: [0],
          },
        ],
        limitations: [],
      }),
      generateScenarios: async (payloadJson) => {
        stage2Payloads.push(payloadJson);
        return { interpretation: "Grounded interpretation", ideas: [] };
      },
    }
  );
  checks.push({
    name: "two_stage_strategy_isolation",
    passed:
      stage2Payloads.length === 1 &&
      !stage2Payloads[0].includes("CONTAMINATED_UNDATED_CLAIM") &&
      synthesized.markdown.includes("VALID_FACT_ONLY") &&
      synthesized.excluded_news_count === 1,
    detail: "0% leakage of rejected/undated news or raw quotes into Stage-2 scenario prompt",
  });

  // 3. Unverified output withheld
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-eval-"));
  try {
    const store = new OperationalStore(tmpDir);
    const res = await runBriefing({
      userId: "usr_eval",
      statement: {
        kind: "holdings",
        as_of: "2026-10-02",
        period: "Oct",
        instruments: [sampleInstrument()],
        warnings: [],
      },
      confirmed: true,
      researcher: async (item) => ({
        instrument: item.symbol,
        status: "unverified",
        markdown: "HALLUCINATED_TARGET_999",
        sources: [],
        search_calls: 1,
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
        latency_ms: 5,
        excluded_news_count: 0,
      }),
      store,
    });
    checks.push({
      name: "unverified_output_withheld",
      passed: !res.markdown.includes("HALLUCINATED_TARGET_999") && res.markdown.includes("Analysis omitted"),
      detail: "Search responses without citation annotations are 100% withheld",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 4. Native citation conversion & private-use token cleanup
  const norm = services.normalizeResearchFromResponse(
    "NVDA",
    [
      {
        text: "Claim A \ue200cite\ue201 here.",
        annotations: [{ url: "https://sec.gov/filing", title: "Filing", start_index: 0, end_index: 7 }],
      },
    ],
    1,
    { input_tokens: 10, output_tokens: 10, total_tokens: 20 }
  );
  checks.push({
    name: "citation_normalization_and_token_cleanup",
    passed:
      norm.status === "cited" &&
      norm.markdown.includes("[Filing](<https://sec.gov/filing>)") &&
      !norm.markdown.includes("\ue200"),
    detail: "Native URL annotations converted to Markdown links and private tokens stripped",
  });

  const passed = checks.filter((c) => c.passed).length;
  return {
    category: "Two-Stage Evidence Grounding & Hallucination Containment",
    passed,
    total: checks.length,
    score: Number((passed / checks.length).toFixed(4)),
    checks,
  };
}

async function evalSecurityAndPermissions(): Promise<EvalSuite> {
  const checks: EvalCheck[] = [];

  // 1. PII redaction
  const { sanitized, counts } = redactPii(
    "Account Number: U9876543\nEmail: trader@example.com\nTax ID: 999-88-7777\nContact jane@firm.io\nBUY NVDA 100 NASDAQ"
  );
  checks.push({
    name: "pii_redaction_coverage",
    passed:
      !sanitized.includes("U9876543") &&
      !sanitized.includes("trader@example.com") &&
      !sanitized.includes("jane@firm.io") &&
      sanitized.includes("BUY NVDA 100 NASDAQ") &&
      Object.values(counts).reduce((a, b) => a + b, 0) >= 4,
    detail: "Strips account numbers, tax IDs, and inline emails while preserving trade rows",
  });

  // 2. AES-256-GCM OAuth token encryption at rest (fails, rather than throws, when the
  //    deployment's TOKEN_ENCRYPTION_KEY is missing or malformed)
  let encryptionPassed = false;
  let encryptionDetail = "Gmail refresh tokens encrypted with AES-256-GCM at rest";
  try {
    const secret = "1//0gRefreshTokenExampleSecretValue";
    const cipher = encryptSecret(secret);
    encryptionPassed = cipher !== secret && !cipher.includes(secret) && decryptSecret(cipher) === secret;
  } catch (err) {
    encryptionDetail = `Token encryption unavailable: ${err instanceof Error ? err.message : "unknown error"}`;
  }
  checks.push({
    name: "oauth_token_aes256_gcm_encryption",
    passed: encryptionPassed,
    detail: encryptionDetail,
  });

  // 3. URL scheme & credential rejection
  checks.push({
    name: "url_scheme_and_credential_guard",
    passed:
      services.httpUrl("https://finance.yahoo.com/news") &&
      !services.httpUrl("javascript:alert(1)") &&
      !services.httpUrl("file:///etc/passwd") &&
      !services.httpUrl("https://user:pass@example.com/"),
    detail: "Rejected non-HTTP schemes and credential-bearing URLs",
  });

  // 4. Outbox permission gate + multi-tenant isolation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-sec-"));
  try {
    const store = new OperationalStore(tmpDir);
    const blocked = store.enqueueDelivery({
      userId: "usr_a",
      runId: "run_1",
      channel: "email",
      destination: "a@example.com",
      confirmed: false,
    });
    store.saveSnapshot({
      userId: "usr_a",
      statement: { kind: "holdings", as_of: "2026-10-02", period: "Oct", instruments: [], warnings: [] },
      confirmed: true,
      snapshotId: "snap_a_only",
    });
    const usrBList = store.listSnapshots("usr_b");
    checks.push({
      name: "multi_tenant_isolation_and_outbox_gate",
      passed: blocked.status === "blocked_unconfirmed" && usrBList.length === 0,
      detail: "Unconfirmed delivery blocked and snapshots strictly isolated by userId",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const passed = checks.filter((c) => c.passed).length;
  return {
    category: "Security, Encryption, PII & Multi-Tenant Permissions",
    passed,
    total: checks.length,
    score: Number((passed / checks.length).toFixed(4)),
    checks,
  };
}

async function evalGmailAndResilience(): Promise<EvalSuite> {
  const checks: EvalCheck[] = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-gmail-"));

  try {
    const store = new OperationalStore(tmpDir);
    const sampleTxt = Buffer.from(
      "IBKR DAILY ACTIVITY STATEMENT\n2026-10-02\nBUY NVDA NVIDIA Corp NASDAQ 50 USD\n",
      "utf8"
    );

    // 1. Gmail IBKR sync + SHA-256 deduplication
    const first = await syncAndAnalyzeIbkrFromGmail({
      userId: "usr_gmail",
      store,
      runBriefingAfter: false,
      extractor: async () => ({
        kind: "activity",
        as_of: null,
        period: "2026-10-02",
        instruments: [sampleInstrument()],
        warnings: [],
      }),
      mockAttachment: {
        messageId: "msg_001",
        subject: "Daily Activity Statement for U***123",
        receivedAt: "2026-11-15T22:00:00Z",
        filename: "Daily_Activity_Statement.txt",
        pdfBuffer: sampleTxt,
      },
    });
    const second = await syncAndAnalyzeIbkrFromGmail({
      userId: "usr_gmail",
      store,
      mockAttachment: {
        messageId: "msg_001",
        subject: "Daily Activity Statement for U***123",
        receivedAt: "2026-11-15T22:00:00Z",
        filename: "Daily_Activity_Statement.txt",
        pdfBuffer: sampleTxt,
      },
    });
    checks.push({
      name: "gmail_ibkr_ingestion_and_sha256_dedup",
      passed:
        first.syncStatus === "ingested" &&
        second.syncStatus === "skipped_duplicate" &&
        first.snapshotId === second.snapshotId,
      detail: "Ingested IBKR attachment once and deduplicated repeat fetch via SHA-256",
    });

    // 2. Lease locking prevents concurrent duplicate worker execution
    const l1 = store.acquireLease("daily-ibkr:usr_gmail:2026-11-16", "w1", 120);
    const l2 = store.acquireLease("daily-ibkr:usr_gmail:2026-11-16", "w2", 120);
    store.releaseLease("daily-ibkr:usr_gmail:2026-11-16", "w1");
    const l3 = store.acquireLease("daily-ibkr:usr_gmail:2026-11-16", "w2", 120);
    checks.push({
      name: "idempotent_run_lease_locking",
      passed: l1 && !l2 && l3,
      detail: "Concurrent duplicate scheduled runs prevented via durable SQLite lease",
    });

    // 3. Partial failure isolation & cost cap
    const state = await runBriefing({
      userId: "usr_gmail",
      statement: {
        kind: "holdings",
        as_of: "2026-10-02",
        period: "Oct",
        instruments: [
          sampleInstrument({ symbol: "NVDA" }),
          sampleInstrument({ symbol: "MSFT" }),
          sampleInstrument({ symbol: "GOOG" }),
        ],
        warnings: [],
      },
      confirmed: true,
      maxInstruments: 2,
      researcher: async (item) => {
        if (item.symbol === "NVDA") {
          throw new Error("Upstream timeout sk-secret-should-not-leak");
        }
        return {
          instrument: item.symbol,
          status: "cited",
          markdown: "Grounded [Source 1](<https://example.com>)",
          sources: [{ title: "Source 1", url: "https://example.com" }],
          search_calls: 1,
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          latency_ms: 10,
          excluded_news_count: 0,
        };
      },
      store,
    });
    checks.push({
      name: "failure_isolation_and_budget_cap",
      passed:
        state.research.length === 2 &&
        state.research[0].status === "failed" &&
        state.research[1].status === "cited" &&
        !state.markdown.includes("sk-secret-should-not-leak") &&
        state.markdown.includes("cost limit excluded: GOOG"),
      detail: "Failed ticker isolated, secret stripped, and maxInstruments budget cap enforced",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const passed = checks.filter((c) => c.passed).length;
  return {
    category: "Gmail Automation, Leases & Fault Isolation",
    passed,
    total: checks.length,
    score: Number((passed / checks.length).toFixed(4)),
    checks,
  };
}

export async function runEvaluationSuite(): Promise<EvalSummary> {
  const suites = await Promise.all([
    evalIngestionGuardrails(),
    evalEvidenceGrounding(),
    evalSecurityAndPermissions(),
    evalGmailAndResilience(),
  ]);

  const overallPassed = suites.reduce((acc, s) => acc + s.passed, 0);
  const overallTotal = suites.reduce((acc, s) => acc + s.total, 0);

  return {
    evaluated_at: new Date().toISOString(),
    overall_passed: overallPassed,
    overall_total: overallTotal,
    overall_score: overallTotal > 0 ? Number((overallPassed / overallTotal).toFixed(4)) : 1.0,
    suites,
  };
}
