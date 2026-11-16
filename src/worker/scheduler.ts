import crypto from "crypto";
import os from "os";
import { mostRecentFireTime, zonedParts } from "../lib/cron";
import { OperationalStore, type ScheduleRecord } from "../lib/db/store";
import { syncAndAnalyzeIbkrFromGmail } from "../lib/gmail/client";

/** How long after its fire time a missed run (e.g. during a worker restart) is still caught up. */
export const CATCH_UP_WINDOW_MINUTES = 24 * 60;

/**
 * Upper bound for one scheduled sync + briefing. The lease is released as soon as the run
 * finishes; the TTL only matters if the worker dies mid-run.
 */
export const LEASE_TTL_SECONDS = 30 * 60;

/**
 * Whether `now` falls on Mon-Fri in `timeZone`. Exchange holidays are not modelled;
 * a holiday calendar can be plugged in here.
 */
export function isTradingWeekday(now: Date, timeZone: string): boolean {
  const { weekday } = zonedParts(now, timeZone);
  return weekday !== 0 && weekday !== 6;
}

export interface DueCheck {
  due: boolean;
  /** The occurrence this check refers to, or null if none fired within the catch-up window. */
  fireTime: Date | null;
}

/**
 * A schedule is due when its most recent cron occurrence (evaluated in the schedule's own
 * timezone, within the catch-up window, skipping weekends when `trading_days_only` is set)
 * is later than its last run. A schedule that has never run is measured from `updated_at`,
 * so creating or editing a schedule only affects future occurrences.
 * Throws if the stored cron expression or timezone is invalid.
 */
export function isScheduleDue(schedule: ScheduleRecord, now: Date): DueCheck {
  const fireTime = mostRecentFireTime(
    schedule.cron_expression,
    schedule.timezone,
    now,
    CATCH_UP_WINDOW_MINUTES,
    schedule.trading_days_only ? (candidate) => isTradingWeekday(candidate, schedule.timezone) : undefined
  );
  if (!fireTime) {
    return { due: false, fireTime: null };
  }
  const baselineMs = Date.parse(schedule.last_run_at ?? schedule.updated_at);
  return { due: Number.isNaN(baselineMs) || fireTime.getTime() > baselineMs, fireTime };
}

export type TickOutcome =
  | "not_due"
  | "gmail_not_connected"
  | "locked"
  | "completed"
  | "failed"
  | "invalid_schedule";

export interface TickResult {
  userId: string;
  outcome: TickOutcome;
  detail?: string;
}

export interface SchedulerDeps {
  /** Clock override for tests. */
  now?: () => Date;
  /** Sync implementation override for tests. */
  sync?: typeof syncAndAnalyzeIbkrFromGmail;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message.slice(0, 200) : fallback;
}

async function runScheduleIfDue(
  store: OperationalStore,
  schedule: ScheduleRecord,
  now: Date,
  sync: typeof syncAndAnalyzeIbkrFromGmail
): Promise<TickResult> {
  const userId = schedule.user_id;

  try {
    if (!isScheduleDue(schedule, now).due) {
      return { userId, outcome: "not_due" };
    }
  } catch (err) {
    const detail = errorMessage(err, "Invalid schedule");
    store.logEvent({
      userId,
      eventType: "schedule_invalid",
      message: `Scheduled sync skipped: ${detail}. Fix the schedule on the Automation page.`,
      severity: "error",
      // One event per schedule revision instead of one per poll.
      eventKey: `schedule-invalid:${userId}:${schedule.updated_at}`,
    });
    return { userId, outcome: "invalid_schedule", detail };
  }

  // Not marked as run: if Gmail is connected later, the pending occurrence can still run.
  if (!store.hasOAuthConnection(userId, "gmail")) {
    return { userId, outcome: "gmail_not_connected" };
  }

  const leaseKey = `scheduled-sync:${userId}`;
  const ownerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  if (!store.acquireLease(leaseKey, ownerId, LEASE_TTL_SECONDS)) {
    return { userId, outcome: "locked" };
  }

  try {
    // Re-check under the lease: another worker may have finished this occurrence meanwhile.
    const current = store.getSchedule(userId);
    if (!isScheduleDue(current, now).due) {
      return { userId, outcome: "not_due" };
    }

    try {
      const result = await sync({
        userId,
        store,
        query: current.gmail_query,
        runBriefingAfter: true,
        days: current.news_window_days,
        maxInstruments: current.max_instruments,
        language: current.language,
      });

      if (result.runId && current.delivery_channel !== "dashboard" && current.delivery_destination) {
        store.enqueueDelivery({
          userId,
          runId: result.runId,
          channel: current.delivery_channel,
          destination: current.delivery_destination,
          confirmed: false,
          requireConfirmation: true,
        });
      }
      return { userId, outcome: "completed", detail: result.syncStatus };
    } catch (err) {
      const detail = errorMessage(err, "Unknown scheduler error");
      store.logEvent({
        userId,
        eventType: "scheduler_tick_error",
        message: detail,
        severity: "error",
      });
      return { userId, outcome: "failed", detail };
    } finally {
      // Mark the occurrence as attempted even when it fails, so a persistent error is
      // reported once per scheduled run instead of being retried (and billed) every poll.
      // "Fetch IBKR Email Now" on the Automation page remains available for manual retries.
      store.updateSchedule(userId, { last_run_at: now.toISOString() });
    }
  } finally {
    store.releaseLease(leaseKey, ownerId);
  }
}

/**
 * Evaluate every enabled schedule once. Each schedule is isolated: an invalid or failing
 * schedule never prevents the others from running.
 */
export async function runSchedulerTick(
  store = new OperationalStore(),
  deps: SchedulerDeps = {}
): Promise<TickResult[]> {
  const now = deps.now?.() ?? new Date();
  const sync = deps.sync ?? syncAndAnalyzeIbkrFromGmail;
  const results: TickResult[] = [];

  for (const schedule of store.listEnabledSchedules()) {
    try {
      results.push(await runScheduleIfDue(store, schedule, now, sync));
    } catch (err) {
      results.push({
        userId: schedule.user_id,
        outcome: "failed",
        detail: errorMessage(err, "Unexpected scheduler error"),
      });
    }
  }
  return results;
}

async function main() {
  const configured = Number(process.env.WORKER_POLL_INTERVAL_MS);
  const intervalMs = Number.isFinite(configured) && configured >= 5_000 ? configured : 60_000;
  const store = new OperationalStore();
  console.log(`[LedgerPulse Worker] Started scheduler (poll=${intervalMs}ms)`);

  const tick = async () => {
    try {
      for (const result of await runSchedulerTick(store)) {
        if (result.outcome !== "not_due" && result.outcome !== "gmail_not_connected") {
          console.log(
            `[LedgerPulse Worker] ${result.userId}: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`
          );
        }
      }
    } catch (err) {
      console.error("[LedgerPulse Worker] Tick failed:", err);
    } finally {
      // Chain ticks instead of using setInterval so a slow sync never overlaps the next poll.
      setTimeout(tick, intervalMs);
    }
  };

  await tick();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[LedgerPulse Worker] Fatal:", err);
    process.exit(1);
  });
}
