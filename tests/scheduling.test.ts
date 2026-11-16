import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { cronMatches, isValidTimeZone, mostRecentFireTime, parseCron, zonedParts } from "@/lib/cron";
import { OperationalStore } from "@/lib/db/store";
import { isScheduleDue, runSchedulerTick, type SchedulerDeps, type TickResult } from "@/worker/scheduler";

type SyncFn = NonNullable<SchedulerDeps["sync"]>;

const ingested: SyncFn = async () => ({ syncStatus: "ingested", snapshotId: "snap_1" });

function connectGmail(store: OperationalStore, userId: string) {
  store.saveOAuthConnection({
    userId,
    provider: "gmail",
    emailAddress: `${userId}@example.com`,
    refreshToken: "1//test-refresh-token",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  });
}

const outcomes = (results: TickResult[]) => Object.fromEntries(results.map((r) => [r.userId, r.outcome]));

describe("cron evaluation", () => {
  it("parses ranges, lists, steps and names", () => {
    const spec = parseCron("*/15 9-17 * * MON-FRI");
    expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
    expect([...spec.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...spec.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
    expect([...parseCron("0 0 1,15 JAN-MAR *").months]).toEqual([1, 2, 3]);
    expect(parseCron("0 0 * * 7").daysOfWeek).toEqual(new Set([0]));
  });

  it.each([
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "a * * * *",
    "5-1 * * * *",
    "*/0 * * * *",
    "1,,2 * * * *",
  ])("rejects %j", (expression) => {
    expect(() => parseCron(expression)).toThrow();
  });

  it("finds the most recent weekday 18:00 in New York", () => {
    const weekdays6pm = "0 18 * * 1-5";
    const threeDays = 3 * 24 * 60;
    // Tue 2026-11-17 10:00 EST -> Mon 18:00 EST (23:00Z)
    expect(
      mostRecentFireTime(weekdays6pm, "America/New_York", new Date("2026-11-17T15:00:00Z"), threeDays)?.toISOString()
    ).toBe("2026-11-16T23:00:00.000Z");
    // Mon 10:00 EST -> the previous weekday occurrence is Fri 18:00 EST
    expect(
      mostRecentFireTime(weekdays6pm, "America/New_York", new Date("2026-11-16T15:00:00Z"), threeDays)?.toISOString()
    ).toBe("2026-11-13T23:00:00.000Z");
    // ...which lies outside a 24h window
    expect(mostRecentFireTime(weekdays6pm, "America/New_York", new Date("2026-11-16T15:00:00Z"), 24 * 60)).toBeNull();
  });

  it("follows the schedule's timezone across a DST change", () => {
    // US DST ended 2026-11-01: 18:00 New York is 22:00Z before and 23:00Z after.
    expect(
      mostRecentFireTime("0 18 * * *", "America/New_York", new Date("2026-11-01T22:30:00Z"), 48 * 60)?.toISOString()
    ).toBe("2026-10-31T22:00:00.000Z");
    expect(
      mostRecentFireTime("0 18 * * *", "America/New_York", new Date("2026-11-01T23:30:00Z"), 48 * 60)?.toISOString()
    ).toBe("2026-11-01T23:00:00.000Z");
  });

  it("matches day-of-month OR day-of-week only when both are restricted", () => {
    const at = (expression: string, iso: string) =>
      cronMatches(parseCron(expression), zonedParts(new Date(iso), "UTC"));
    expect(at("0 9 1 * MON", "2026-11-16T09:00:00Z")).toBe(true); // a Monday
    expect(at("0 9 1 * MON", "2026-12-01T09:00:00Z")).toBe(true); // the 1st (a Tuesday)
    expect(at("0 9 1 * MON", "2026-11-17T09:00:00Z")).toBe(false);
    expect(at("0 9 * * MON", "2026-12-01T09:00:00Z")).toBe(false);
  });

  it("validates IANA timezones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Hong_Kong")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("scheduler worker", () => {
  let dataDir: string;
  let store: OperationalStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-sched-"));
    store = new OperationalStore(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs once per cron occurrence in the schedule's timezone", async () => {
    connectGmail(store, "usr_a");
    store.updateSchedule("usr_a", {
      cron_expression: "0 18 * * 1-5",
      timezone: "America/New_York",
      trading_days_only: 1,
      last_run_at: "2026-11-16T12:00:00.000Z",
    });
    const sync = vi.fn(ingested);
    const tick = async (iso: string) => (await runSchedulerTick(store, { now: () => new Date(iso), sync }))[0];

    expect((await tick("2026-11-16T22:59:00Z")).outcome).toBe("not_due"); // Mon 17:59 New York
    expect((await tick("2026-11-16T23:00:30Z")).outcome).toBe("completed"); // Mon 18:00
    expect((await tick("2026-11-16T23:01:30Z")).outcome).toBe("not_due"); // same occurrence
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0]).toMatchObject({ userId: "usr_a", runBriefingAfter: true, days: 1, maxInstruments: 5 });
    expect(store.getSchedule("usr_a").last_run_at).toBe("2026-11-16T23:00:30.000Z");

    // A worker that was down at Tuesday 18:00 catches the occurrence up afterwards.
    expect((await tick("2026-11-17T23:20:00Z")).outcome).toBe("completed");
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("skips weekend occurrences when restricted to trading days", async () => {
    connectGmail(store, "usr_b");
    store.updateSchedule("usr_b", {
      cron_expression: "0 18 * * *",
      timezone: "America/New_York",
      trading_days_only: 1,
      last_run_at: "2026-11-20T23:10:00.000Z", // ran Friday 18:10 New York
    });
    const sync = vi.fn(ingested);
    const saturdayEvening = () => new Date("2026-11-21T23:30:00Z");

    expect((await runSchedulerTick(store, { now: saturdayEvening, sync }))[0].outcome).toBe("not_due");
    store.updateSchedule("usr_b", { trading_days_only: 0 });
    expect((await runSchedulerTick(store, { now: saturdayEvening, sync }))[0].outcome).toBe("completed");
  });

  it("waits for a Gmail connection without consuming the occurrence", async () => {
    store.ensureUser("usr_c");
    store.updateSchedule("usr_c", {
      cron_expression: "0 18 * * *",
      timezone: "UTC",
      trading_days_only: 0,
      last_run_at: "2026-11-16T00:00:00.000Z",
    });
    const sync = vi.fn(ingested);
    const now = () => new Date("2026-11-16T18:30:00Z");

    expect((await runSchedulerTick(store, { now, sync }))[0].outcome).toBe("gmail_not_connected");
    expect(store.getSchedule("usr_c").last_run_at).toBe("2026-11-16T00:00:00.000Z");

    connectGmail(store, "usr_c");
    expect((await runSchedulerTick(store, { now, sync }))[0].outcome).toBe("completed");
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("reports a failing run once per occurrence instead of retrying every poll", async () => {
    connectGmail(store, "usr_d");
    store.updateSchedule("usr_d", {
      cron_expression: "0 18 * * *",
      timezone: "UTC",
      trading_days_only: 0,
      last_run_at: "2026-11-16T00:00:00.000Z",
    });
    const sync = vi.fn<SyncFn>(async () => {
      throw new Error("Gmail API unavailable");
    });

    const first = await runSchedulerTick(store, { now: () => new Date("2026-11-16T18:01:00Z"), sync });
    expect(first[0]).toMatchObject({ outcome: "failed", detail: "Gmail API unavailable" });
    const second = await runSchedulerTick(store, { now: () => new Date("2026-11-16T18:02:00Z"), sync });
    expect(second[0].outcome).toBe("not_due");
    expect(sync).toHaveBeenCalledTimes(1);

    const errors = store
      .summaryMetrics("usr_d")
      .audit_events.filter((event) => event.event_type === "scheduler_tick_error");
    expect(errors).toHaveLength(1);
  });

  it("skips a schedule whose lease is held by another worker", async () => {
    connectGmail(store, "usr_e");
    store.updateSchedule("usr_e", {
      cron_expression: "0 18 * * *",
      timezone: "UTC",
      trading_days_only: 0,
      last_run_at: "2026-11-16T00:00:00.000Z",
    });
    expect(store.acquireLease("scheduled-sync:usr_e", "another-worker", 600)).toBe(true);
    const sync = vi.fn(ingested);

    const results = await runSchedulerTick(store, { now: () => new Date("2026-11-16T18:30:00Z"), sync });
    expect(results[0].outcome).toBe("locked");
    expect(sync).not.toHaveBeenCalled();
  });

  it("never runs the same occurrence twice when ticks overlap", async () => {
    connectGmail(store, "usr_f");
    store.updateSchedule("usr_f", {
      cron_expression: "0 18 * * *",
      timezone: "UTC",
      trading_days_only: 0,
      last_run_at: "2026-11-16T00:00:00.000Z",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sync = vi.fn<SyncFn>(async () => {
      await gate; // a slow sync + briefing that outlives the poll interval
      return { syncStatus: "ingested" };
    });
    const now = () => new Date("2026-11-16T18:30:00Z");

    const first = runSchedulerTick(store, { now, sync });
    const second = runSchedulerTick(store, { now, sync });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect([a[0].outcome, b[0].outcome].sort()).toEqual(["completed", "locked"]);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("isolates an invalid stored schedule from healthy ones", async () => {
    connectGmail(store, "usr_bad");
    connectGmail(store, "usr_good");
    // A row written before API validation existed.
    store.updateSchedule("usr_bad", { timezone: "Not/AZone", last_run_at: "2026-11-16T00:00:00.000Z" });
    store.updateSchedule("usr_good", {
      cron_expression: "0 18 * * *",
      timezone: "UTC",
      trading_days_only: 0,
      last_run_at: "2026-11-16T00:00:00.000Z",
    });
    const sync = vi.fn(ingested);
    const now = () => new Date("2026-11-16T18:30:00Z");

    expect(outcomes(await runSchedulerTick(store, { now, sync }))).toEqual({
      usr_bad: "invalid_schedule",
      usr_good: "completed",
    });
    await runSchedulerTick(store, { now, sync });
    expect(sync).toHaveBeenCalledTimes(1);

    const invalidEvents = store
      .summaryMetrics("usr_bad")
      .audit_events.filter((event) => event.event_type === "schedule_invalid");
    expect(invalidEvents).toHaveLength(1);
  });

  it("measures a never-run schedule from when it was last saved", () => {
    store.ensureUser("usr_h");
    const schedule = store.updateSchedule("usr_h", {
      cron_expression: "* * * * *",
      timezone: "UTC",
      trading_days_only: 0,
    });
    expect(schedule.last_run_at).toBeNull();

    const savedAt = Date.parse(schedule.updated_at);
    expect(isScheduleDue(schedule, new Date(savedAt - 10 * 60_000)).due).toBe(false);
    expect(isScheduleDue(schedule, new Date(savedAt + 3 * 60_000)).due).toBe(true);
  });
});
