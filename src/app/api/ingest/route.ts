import { NextRequest, NextResponse } from "next/server";
import { readDocument, safeError } from "@/lib/agent/services";
import { buildIngestionGraph } from "@/lib/agent/workflow";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";

const FICTIONAL_IBKR_SAMPLE = `INTERACTIVE BROKERS - DAILY ACTIVITY STATEMENT (FICTIONAL SAMPLE FOR TESTING)
Period: 2026-10-02
Holdings as of: 2026-10-02
Account Number: U9999999 (will be redacted)

OPEN POSITIONS
Symbol   Name                         Type    Exchange  Qty    Currency
NVDA     NVIDIA CORP                  stock   NASDAQ    250    USD
MSFT     MICROSOFT CORP               stock   NASDAQ    110    USD
ASML     ASML HOLDING NV-NY REG SHS   stock   NASDAQ    30     USD
QQQ      INVESCO QQQ TRUST SERIES 1   etf     NASDAQ    -315   USD
NVDA 19MAR27 280 P  NVDA 19MAR27 280 P  option  CBOE    -4     USD
`;

export async function POST(req: NextRequest) {
  try {
    const userId = resolveUserId(req);
    const store = new OperationalStore();
    const contentType = req.headers.get("content-type") || "";

    let buffer: Buffer;
    let filename = "statement.txt";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      filename = file.name || "statement.pdf";
      buffer = Buffer.from(await file.arrayBuffer());
    } else {
      const body = (await req.json()) as { mode?: string; text?: string };
      if (body.mode === "sample") {
        filename = "ibkr-sample-statement.txt";
        buffer = Buffer.from(FICTIONAL_IBKR_SAMPLE, "utf8");
      } else if (body.text && body.text.trim()) {
        buffer = Buffer.from(body.text, "utf8");
      } else {
        return NextResponse.json({ error: "Provide a file, pasted text, or mode='sample'." }, { status: 400 });
      }
    }

    const { text, pages, piiRedactions } = await readDocument(buffer, filename);
    if (Object.keys(piiRedactions).length > 0) {
      store.logEvent({
        userId,
        eventType: "pii_redacted",
        message: `Redacted PII fields from ${filename} prior to cloud extraction.`,
        severity: "info",
        details: piiRedactions,
      });
    }

    const graph = buildIngestionGraph();
    const result = await graph.invoke({ text, pageCount: pages });

    return NextResponse.json({
      statement: result.statement,
      pages,
      piiRedactions,
    });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 400 });
  }
}
