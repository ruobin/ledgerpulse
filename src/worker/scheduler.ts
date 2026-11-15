import { OperationalStore } from "../lib/db/store";
import { syncAndAnalyzeIbkrFromGmail } from "../lib/gmail/client";

/**
 * Determine if the current UTC/local date in the user's timezone is a weekday (Mon-Fri).
 * Extended market holiday calendars can be plugged in here.
 */
export function isTradingWeekday(now: Date, timeZone: string): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  });
  const day = formatter.format(now);
  return day !== "Sat" && day !== "Sun";
}

export async function runSchedulerTick(store = new OperationalStore()): Promise<void> {
  const workerId = `worker-${process.pid}`;
  const schedules = store.listDueSchedules();

  for (const sched of schedules) {
    if (sched.trading_days_only && !isTradingWeekday(new Date(), sched.timezone)) {
      continue;
    }

    const todaySlot = new Date().toISOString().slice(0, 10);
    const jobKey = `daily-ibkr:${sched.user_id}:${todaySlot}`;

    if (!store.acquireLease(jobKey, workerId, 600)) {
      continue;
    }

    try {
      const conn = store.getOAuthConnection(sched.user_id, "gmail");
      if (!conn) {
        continue;
      }
      const res = await syncAndAnalyzeIbkrFromGmail({
        userId: sched.user_id,
        store,
        query: sched.gmail_query,
        runBriefingAfter: true,
        days: sched.news_window_days,
        maxInstruments: sched.max_instruments,
        language: sched.language,
      });

      if (res.runId && sched.delivery_channel !== "dashboard" && sched.delivery_destination) {
        store.enqueueDelivery({
          userId: sched.user_id,
          runId: res.runId,
          channel: sched.delivery_channel,
          destination: sched.delivery_destination,
          confirmed: false,
          requireConfirmation: true,
        });
      }

      store.updateSchedule(sched.user_id, { last_run_at: new Date().toISOString() });
    } catch (err) {
      store.logEvent({
        userId: sched.user_id,
        eventType: "scheduler_tick_error",
        message: err instanceof Error ? err.message.slice(0, 200) : "Unknown scheduler error",
        severity: "error",
      });
    } finally {
      store.releaseLease(jobKey, workerId);
    }
  }
}

async function main() {
  const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 60_000);
  const store = new OperationalStore();
  console.log(`[LedgerPulse Worker] Started trading-day scheduler (poll=${intervalMs}ms)`);

  await runSchedulerTick(store);
  setInterval(() => {
    runSchedulerTick(store).catch((err) => {
      console.error("[LedgerPulse Worker] Tick failed:", err);
    });
  }, intervalMs);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[LedgerPulse Worker] Fatal:", err);
    process.exit(1);
  });
}
