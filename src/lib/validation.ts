import { z } from "zod";
import { isValidTimeZone, parseCron } from "./cron";

/** Accepts the 0/1 integers SQLite returns as well as booleans; normalizes to 0/1. */
const flag = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((value) => (value ? 1 : 0));

/**
 * Fields a client may change on its own schedule. Unknown keys (schedule_id, user_id,
 * last_run_at, updated_at, ...) are stripped, so the UI can PUT back the record it
 * fetched without being able to rewrite worker-owned state.
 */
export const SchedulePatchSchema = z.object({
  enabled: flag.optional(),
  trading_days_only: flag.optional(),
  cron_expression: z
    .string()
    .trim()
    .max(120)
    .superRefine((value, ctx) => {
      try {
        parseCron(value);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : "Invalid cron expression",
        });
      }
    })
    .optional(),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimeZone, { message: "must be an IANA timezone such as America/New_York" })
    .optional(),
  news_window_days: z.number().int().min(1).max(30).optional(),
  max_instruments: z.number().int().min(1).max(10).optional(),
  language: z.enum(["English", "Chinese"]).optional(),
  gmail_query: z.string().trim().min(1).max(500).optional(),
  delivery_channel: z.string().trim().min(1).max(32).optional(),
  delivery_destination: z.string().trim().max(320).optional(),
});

export type SchedulePatch = z.infer<typeof SchedulePatchSchema>;

export const BriefingRequestSchema = z.object({
  snapshotId: z.string().trim().min(1).max(128),
  days: z.number().int().min(1).max(30).default(7),
  maxInstruments: z.number().int().min(1).max(10).default(3),
  language: z.enum(["English", "Chinese"]).default("English"),
});

export type BriefingRequest = z.infer<typeof BriefingRequestSchema>;

/** One-line, user-presentable summary of validation issues, e.g. "timezone: must be ...". */
export function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "body"}: ${issue.message}`)
    .join("; ");
}
