import { NextRequest, NextResponse } from "next/server";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  const run = store.getRun(userId, id);
  if (!run) {
    return NextResponse.json({ error: "Briefing run not found" }, { status: 404 });
  }
  return NextResponse.json({ run });
}
