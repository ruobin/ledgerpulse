import { NextRequest, NextResponse } from "next/server";
import { safeError } from "@/lib/agent/services";
import { runBriefing } from "@/lib/agent/workflow";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  return NextResponse.json({ runs: store.listRuns(userId) });
}

export async function POST(req: NextRequest) {
  try {
    const userId = resolveUserId(req);
    const store = new OperationalStore();
    const body = (await req.json()) as {
      snapshotId: string;
      days?: number;
      maxInstruments?: number;
      language?: "English" | "Chinese";
    };

    const snap = store.getSnapshot(userId, body.snapshotId);
    if (!snap) {
      return NextResponse.json({ error: "Snapshot not found for user." }, { status: 404 });
    }

    const result = await runBriefing({
      userId,
      statement: snap.statement,
      confirmed: snap.confirmed,
      snapshotId: body.snapshotId,
      days: body.days ?? 7,
      maxInstruments: body.maxInstruments ?? 3,
      language: body.language ?? "English",
      store,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 400 });
  }
}
