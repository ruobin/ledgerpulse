import { NextRequest, NextResponse } from "next/server";
import { OperationalStore } from "@/lib/db/store";
import { resolveUserId } from "@/lib/tenant";
import { describeZodError, SchedulePatchSchema } from "@/lib/validation";

export async function GET(req: NextRequest) {
  const userId = resolveUserId(req);
  const store = new OperationalStore();
  return NextResponse.json({ schedule: store.getSchedule(userId) });
}

export async function PUT(req: NextRequest) {
  const userId = resolveUserId(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = SchedulePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Invalid schedule: ${describeZodError(parsed.error)}` },
      { status: 400 }
    );
  }

  const store = new OperationalStore();
  const updated = store.updateSchedule(userId, parsed.data);
  return NextResponse.json({ schedule: updated });
}
