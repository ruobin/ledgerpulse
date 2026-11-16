import { NextRequest, NextResponse } from "next/server";
import { safeError } from "@/lib/agent/services";
import { OperationalStore } from "@/lib/db/store";
import { isGmailConfigured, syncAndAnalyzeIbkrFromGmail } from "@/lib/gmail/client";
import { resolveUserId } from "@/lib/tenant";

const SIMULATED_IBKR_DAILY_EMAIL = `INTERACTIVE BROKERS LLC — DAILY ACTIVITY STATEMENT
Date: 2026-11-15
Account Number: U1234567 (redacted before LLM)

OPEN POSITIONS
NVDA   NVIDIA CORP                 stock   NASDAQ   250   USD
MSFT   MICROSOFT CORP              stock   NASDAQ   110   USD
AMZN   AMAZON.COM INC              stock   NASDAQ   105   USD
`;

export async function POST(req: NextRequest) {
  try {
    const userId = resolveUserId(req);
    const store = new OperationalStore();
    const body = (await req.json().catch(() => ({}))) as {
      runBriefingAfter?: boolean;
      demoMode?: boolean;
    };

    const sched = store.getSchedule(userId);
    const useDemo = body.demoMode || !isGmailConfigured() || !store.getOAuthConnection(userId, "gmail");

    const result = await syncAndAnalyzeIbkrFromGmail({
      userId,
      store,
      query: sched.gmail_query,
      runBriefingAfter: Boolean(body.runBriefingAfter),
      days: sched.news_window_days,
      maxInstruments: sched.max_instruments,
      language: sched.language,
      // Demo statements are labelled "sample" so they are not mistaken for real Gmail data.
      sourceType: useDemo ? "sample" : "gmail",
      ...(useDemo
        ? {
            mockAttachment: {
              messageId: "msg_ibkr_daily_demo",
              subject: "Daily Activity Statement - November 15, 2026",
              receivedAt: new Date().toISOString(),
              filename: "IBKR_Daily_Activity_Statement_2026-11-15.txt",
              pdfBuffer: Buffer.from(SIMULATED_IBKR_DAILY_EMAIL, "utf8"),
            },
          }
        : {}),
    });

    return NextResponse.json({ ...result, mode: useDemo ? "simulated_demo" : "live_gmail" });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 400 });
  }
}
