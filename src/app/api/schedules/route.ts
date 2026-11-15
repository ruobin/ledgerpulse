import { NextRequest, NextResponse } from "next/server";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  return NextResponse.json({ schedule: store.getSchedule(userId) });
}

export async function PUT(req: NextRequest) {
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  const patch = (await req.json()) as Record<string, unknown>;
  const updated = store.updateSchedule(userId, patch);
  return NextResponse.json({ schedule: updated });
}
