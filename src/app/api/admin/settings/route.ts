import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { safeError } from "@/lib/agent/services";
import { aiSettingsState, saveAiSettings, SettingsValidationError } from "@/lib/ai-settings";
import { resolveUserId } from "@/lib/tenant";
import { describeZodError } from "@/lib/validation";

/**
 * Admin Console API for AI settings. Like every route it sits behind the access gate
 * (src/middleware.ts). Secret values are write-only: responses never include them.
 */

const SettingsPatchSchema = z
  .object({
    values: z.record(z.string(), z.union([z.string().max(8000), z.null()])),
  })
  .strict();

export async function GET() {
  try {
    return NextResponse.json(aiSettingsState());
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const parsed = SettingsPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `Invalid request: ${describeZodError(parsed.error)}` }, { status: 400 });
  }

  try {
    saveAiSettings(parsed.data.values, { userId: resolveUserId(req) });
    return NextResponse.json(aiSettingsState());
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
    }
    // e.g. TOKEN_ENCRYPTION_KEY missing in production, so a secret cannot be stored.
    return NextResponse.json({ error: safeError(err) }, { status: 400 });
  }
}
