import { NextRequest, NextResponse } from "next/server";
import { runEvaluationSuite } from "@/lib/agent/evals";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  return NextResponse.json(store.summaryMetrics(userId));
}

export async function POST() {
  const summary = await runEvaluationSuite();
  return NextResponse.json(summary);
}
