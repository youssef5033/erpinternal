import {
  addDays as dfAddDays,
  addMonths as dfAddMonths,
  differenceInCalendarDays,
  endOfMonth,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { TZDate } from "@date-fns/tz";

/** Dates are stored as ISO "yyyy-MM-dd" strings for date columns. */
export type ISODate = string;

export function toISODate(date: Date): ISODate {
  return format(date, "yyyy-MM-dd");
}

/** Today's calendar date in the given IANA time zone. */
export function todayISO(timeZone = "UTC"): ISODate {
  return format(new TZDate(new Date(), timeZone), "yyyy-MM-dd");
}

export function addDaysISO(date: ISODate, days: number): ISODate {
  return toISODate(dfAddDays(parseISO(date), days));
}

export function addMonthsISO(date: ISODate, months: number): ISODate {
  return toISODate(dfAddMonths(parseISO(date), months));
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return differenceInCalendarDays(parseISO(to), parseISO(from));
}

export function monthStartISO(date: ISODate) {
  return toISODate(startOfMonth(parseISO(date)));
}
export function monthEndISO(date: ISODate) {
  return toISODate(endOfMonth(parseISO(date)));
}
export function weekStartISO(date: ISODate) {
  return toISODate(startOfWeek(parseISO(date), { weekStartsOn: 1 }));
}

export function formatDate(value: ISODate | Date | null | undefined, pattern = "dd MMM yyyy"): string {
  if (!value) return "—";
  const dt = typeof value === "string" ? parseISO(value) : value;
  if (Number.isNaN(dt.getTime())) return "—";
  return format(dt, pattern);
}

export function formatDateTime(value: Date | string | null | undefined, timeZone?: string, pattern = "dd MMM yyyy, HH:mm") {
  if (!value) return "—";
  const dt = typeof value === "string" ? new Date(value) : value;
  return format(timeZone ? new TZDate(dt, timeZone) : dt, pattern);
}

export function isISODate(value: unknown): value is ISODate {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseISO(value).getTime());
}

/** Resolve a named period into an inclusive ISO date range. */
export function resolvePeriod(period: string | undefined, today: ISODate, fiscalYearStartMonth = 1): { from: ISODate; to: ISODate; label: string } {
  const t = parseISO(today);
  switch (period) {
    case "last_month": {
      const s = startOfMonth(dfAddMonths(t, -1));
      return { from: toISODate(s), to: toISODate(endOfMonth(s)), label: format(s, "MMMM yyyy") };
    }
    case "quarter": {
      const q = Math.floor(t.getMonth() / 3);
      const s = new Date(t.getFullYear(), q * 3, 1);
      return { from: toISODate(s), to: toISODate(endOfMonth(dfAddMonths(s, 2))), label: `Q${q + 1} ${t.getFullYear()}` };
    }
    case "last_90": {
      return { from: addDaysISO(today, -89), to: today, label: "Last 90 days" };
    }
    case "ytd":
    case "fiscal_ytd": {
      let y = t.getFullYear();
      if (t.getMonth() + 1 < fiscalYearStartMonth) y -= 1;
      const s = new Date(y, fiscalYearStartMonth - 1, 1);
      return { from: toISODate(s), to: today, label: `Fiscal year to date (from ${format(s, "MMM yyyy")})` };
    }
    case "last_12": {
      const s = startOfMonth(dfAddMonths(t, -11));
      return { from: toISODate(s), to: toISODate(endOfMonth(t)), label: "Last 12 months" };
    }
    case "month":
    default: {
      const s = startOfMonth(t);
      return { from: toISODate(s), to: toISODate(endOfMonth(t)), label: format(s, "MMMM yyyy") };
    }
  }
}

/** Current epoch milliseconds (request time on the server). */
export function nowMs() {
  return Date.now();
}
