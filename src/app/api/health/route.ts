import { NextResponse } from "next/server";
import { OperationalStore } from "@/lib/db/store";

export async function GET() {
  try {
    const store = new OperationalStore();
    store.ensureUser();
    return NextResponse.json({
      status: "ok",
      service: "ledgerpulse",
      database: "sqlite",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : "Healthcheck failed" },
      { status: 500 }
    );
  }
}
