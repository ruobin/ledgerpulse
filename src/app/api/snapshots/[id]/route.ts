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
  const snapshot = store.getSnapshot(userId, id);
  if (!snapshot) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }
  return NextResponse.json({ snapshot_id: id, ...snapshot });
}
