import { NextRequest, NextResponse } from "next/server";
import { safeError } from "@/lib/agent/services";
import { runBriefing } from "@/lib/agent/workflow";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";
import { BriefingRequestSchema, describeZodError } from "@/lib/validation";

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  return NextResponse.json({ runs: store.listRuns(userId) });
}

export async function POST(req: NextRequest) {
  try {
    const userId = resolveUserId(req);
    const parsed = BriefingRequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Invalid briefing request: ${describeZodError(parsed.error)}` },
        { status: 400 }
      );
    }
    const { snapshotId, days, maxInstruments, language } = parsed.data;

    const store = new OperationalStore();
    const snap = store.getSnapshot(userId, snapshotId);
    if (!snap) {
      return NextResponse.json({ error: "Snapshot not found for user." }, { status: 404 });
    }

    const result = await runBriefing({
      userId,
      statement: snap.statement,
      confirmed: snap.confirmed,
      snapshotId,
      days,
      maxInstruments,
      language,
      store,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 400 });
  }
}
