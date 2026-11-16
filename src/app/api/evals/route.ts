import { NextRequest, NextResponse } from "next/server";
import { runEvaluationSuite } from "@/lib/agent/evals";
import { safeError } from "@/lib/agent/services";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";

/** Operational summary metrics for the dashboard (snapshots, runs, audit events, Gmail). */
export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  return NextResponse.json(store.summaryMetrics(userId));
}

/** Run the offline, zero-cost guardrail evaluation suite. */
export async function POST() {
  try {
    return NextResponse.json(await runEvaluationSuite());
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
}
