import { NextRequest, NextResponse } from "next/server";
import { StatementSchema, validatedStatement } from "@/lib/agent/models";
import { safeError } from "@/lib/agent/services";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  return NextResponse.json({ snapshots: store.listSnapshots(userId) });
}

export async function POST(req: NextRequest) {
  try {
    const userId = resolveUserId(req);
    const body = (await req.json()) as {
      statement: unknown;
      confirmed?: boolean;
      sourceType?: "gmail" | "upload" | "paste" | "sample";
    };
    const parsed = StatementSchema.parse(body.statement);
    const validated = validatedStatement(parsed);
    const store = new OperationalStore();
    const saved = store.saveSnapshot({
      userId,
      statement: validated,
      confirmed: Boolean(body.confirmed),
      sourceType: body.sourceType ?? "upload",
    });
    return NextResponse.json({ ...saved, statement: validated });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 400 });
  }
}
