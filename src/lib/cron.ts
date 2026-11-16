/**
 * Minimal, dependency-free evaluation of standard 5-field cron expressions
 * (`minute hour day-of-month month day-of-week`) in an IANA timezone.
 *
 * Supported per-field syntax: `*`, `n`, `a-b`, lists (`a,b`), and steps
 * (`*\/n`, `a-b/n`, `a/n`). Month and day-of-week also accept three-letter
 * English names (`JAN`-`DEC`, `SUN`-`SAT`); day-of-week `7` is Sunday.
 * As in Vixie cron, when both day-of-month and day-of-week are restricted
 * (neither starts with `*`), a time matches if EITHER of them matches.
 */

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DAY_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES },
];

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  /** 0 = Sunday ... 6 = Saturday (a `7` in the expression is folded into 0). */
  daysOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

/** Wall-clock components of an instant in a given timezone. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

function parseValue(token: string, spec: FieldSpec): number {
  const named = spec.names?.[token.toUpperCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new Error(`Invalid ${spec.name} value "${token}"`);
  }
  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    throw new Error(`${spec.name} value ${value} is outside ${spec.min}-${spec.max}`);
  }
  return value;
}

function parseField(raw: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const item of raw.split(",")) {
    const [range, stepText, ...extra] = item.split("/");
    if (!range || extra.length > 0) {
      throw new Error(`Invalid ${spec.name} field "${raw}"`);
    }

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new Error(`Invalid ${spec.name} step "${stepText}"`);
      }
      step = Number(stepText);
    }

    let start: number;
    let end: number;
    if (range === "*") {
      start = spec.min;
      end = spec.max;
    } else if (range.includes("-")) {
      const [from, to, ...more] = range.split("-");
      if (!from || !to || more.length > 0) {
        throw new Error(`Invalid ${spec.name} range "${range}"`);
      }
      start = parseValue(from, spec);
      end = parseValue(to, spec);
      if (start > end) {
        throw new Error(`Invalid ${spec.name} range "${range}"`);
      }
    } else {
      start = parseValue(range, spec);
      // "a/n" means "every n starting at a", as in Vixie cron.
      end = stepText !== undefined ? spec.max : start;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

/** Parse a 5-field cron expression; throws an Error describing the first problem found. */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression needs 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`
    );
  }

  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = fields.map((field, index) =>
    parseField(field, FIELDS[index])
  );
  const daysOfWeek = new Set(Array.from(rawDaysOfWeek, (day) => day % 7));

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: !fields[2].startsWith("*"),
    dayOfWeekRestricted: !fields[4].startsWith("*"),
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws a RangeError for an unknown timezone. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")],
  };
}

export function cronMatches(schedule: CronSchedule, parts: ZonedParts): boolean {
  if (
    !schedule.minutes.has(parts.minute) ||
    !schedule.hours.has(parts.hour) ||
    !schedule.months.has(parts.month)
  ) {
    return false;
  }
  const dayOfMonth = schedule.daysOfMonth.has(parts.day);
  const dayOfWeek = schedule.daysOfWeek.has(parts.weekday);
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) {
    return dayOfMonth || dayOfWeek;
  }
  return dayOfMonth && dayOfWeek;
}

/**
 * The latest minute at or before `now` (searching back at most `lookbackMinutes`)
 * at which the expression fires in `timeZone`, or null if there is none.
 * `accept` can veto candidate fire times (e.g. to skip weekends).
 * Evaluating real UTC minutes makes DST transitions behave naturally: skipped
 * local times never fire, and repeated local times are distinct instants.
 */
export function mostRecentFireTime(
  expression: string | CronSchedule,
  timeZone: string,
  now: Date,
  lookbackMinutes: number,
  accept?: (fireTime: Date) => boolean
): Date | null {
  const schedule = typeof expression === "string" ? parseCron(expression) : expression;
  const latestMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let offset = 0; offset <= lookbackMinutes; offset++) {
    const candidate = new Date(latestMinute - offset * 60_000);
    if (cronMatches(schedule, zonedParts(candidate, timeZone)) && (!accept || accept(candidate))) {
      return candidate;
    }
  }
  return null;
}
