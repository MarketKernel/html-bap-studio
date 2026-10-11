/**
 * When something recurring happens (Task_next.md 3.1): every day at a time,
 * every week on a weekday, every month on a day or the last day, every year
 * on a date — within an optional first and last date.
 *
 * Moments are local date-times as the whole studio keeps them,
 * 'YYYY-MM-DDTHH:mm:ss', built from calendar parts and never by adding
 * milliseconds: a daily payment at 09:00 stays at 09:00 across a change of
 * the clocks, because there are no clocks here, only the calendar. The 31st
 * in a short month is its last day; 29 February in a common year is the 28th.
 */

export type Every = 'day' | 'week' | 'month' | 'year';

export interface Schedule {
  every: Every;
  /** HH:MM, local; midnight when left out. */
  time?: string;
  /** For a weekly one: 1 = Monday … 7 = Sunday, as weekday() counts. */
  weekday?: number;
  /** For a monthly or yearly one: the day of the month, or the last day. */
  day?: number | 'last';
  /** For a yearly one: 1 … 12. */
  month?: number;
  /** The first and the last date it may happen on, YYYY-MM-DD. */
  from?: string;
  until?: string;
}

const EVERY: Every[] = ['day', 'week', 'month', 'year'];

/** A schedule from whatever is stored (a hand-edited file, an old version): null when it is not one. */
export function readSchedule(value: unknown): Schedule | null {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  const every = EVERY.includes(raw.every as Every) ? (raw.every as Every) : null;
  if (!every) return null;
  const out: Schedule = { every };
  if (typeof raw.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) out.time = raw.time;
  const int = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && Number.isInteger(x) ? Math.min(hi, Math.max(lo, x)) : undefined);
  if (every === 'week') out.weekday = int(raw.weekday, 1, 7) ?? 1;
  if (every === 'month' || every === 'year') out.day = raw.day === 'last' ? 'last' : (int(raw.day, 1, 31) ?? 1);
  if (every === 'year') out.month = int(raw.month, 1, 12) ?? 1;
  const date = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : undefined);
  const from = date(raw.from);
  const until = date(raw.until);
  if (from) out.from = from;
  if (until) out.until = until;
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Days since 1970-01-01 of a calendar date (through UTC: no clock is involved). */
function dayNumber(y: number, m: number, d: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return Math.round(date.getTime() / 86400000);
}

function fromDayNumber(n: number): [number, number, number] {
  const date = new Date(n * 86400000);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

export function daysInMonth(y: number, m: number): number {
  return fromDayNumber(dayNumber(y, m + 1, 1) - 1)[2];
}

const moment = (y: number, m: number, d: number, time: string) => `${pad(y, 4)}-${pad(m)}-${pad(d)}T${time}:00`;

/** A date or a date-time as a moment to compare with: a plain date is its midnight. */
function asMoment(v: string): string {
  return v.length === 10 ? `${v}T00:00:00` : v.slice(0, 19);
}

/**
 * Every moment it happens in (after, to]: after the first, up to and with the
 * second, and within its own from/until. Earliest first; at most `limit`.
 * Without `after` it starts on its `from` — or not at all, having no start.
 * `inclusive` takes in a moment exactly at `after` too: the start of a version.
 */
export function occurrences(s: Schedule, after: string | null, to: string, limit = 100_000, inclusive = false): string[] {
  const time = s.time ?? '00:00';
  const low = after ? asMoment(after) : s.from ? `${s.from}T00:00:00` : null;
  if (low === null) return [];
  const high = asMoment(to);
  const first = s.from && `${s.from}T00:00:00` > low ? `${s.from}T00:00:00` : low;
  const last = s.until && `${s.until}T23:59:59` < high ? `${s.until}T23:59:59` : high;
  if (first > last) return [];
  const [y0, m0, d0] = [Number(first.slice(0, 4)), Number(first.slice(5, 7)), Number(first.slice(8, 10))];
  const out: string[] = [];
  // True while the moments may still come; a moment is taken when it is inside the window.
  const take = (at: string): boolean => {
    if (at > last) return false;
    if ((after && !inclusive ? at > low : at >= low) && (!s.from || at >= `${s.from}T00:00:00`)) out.push(at);
    return out.length < limit;
  };
  const start = dayNumber(y0, m0, d0);
  switch (s.every) {
    case 'day':
      for (let n = start; ; n++) {
        const [y, m, d] = fromDayNumber(n);
        if (!take(moment(y, m, d, time))) break;
      }
      break;
    case 'week': {
      // weekday() of 1970-01-01, a Thursday, is 4.
      const wd = (((start + 3) % 7) + 7) % 7 + 1;
      for (let n = start + ((((s.weekday ?? 1) - wd) % 7) + 7) % 7; ; n += 7) {
        const [y, m, d] = fromDayNumber(n);
        if (!take(moment(y, m, d, time))) break;
      }
      break;
    }
    case 'month':
      for (let i = 0; ; i++) {
        const y = y0 + Math.floor((m0 - 1 + i) / 12);
        const m = ((m0 - 1 + i) % 12) + 1;
        const dim = daysInMonth(y, m);
        if (!take(moment(y, m, s.day === 'last' ? dim : Math.min(s.day ?? 1, dim), time))) break;
      }
      break;
    case 'year':
      for (let y = y0; ; y++) {
        const m = s.month ?? 1;
        const dim = daysInMonth(y, m);
        if (!take(moment(y, m, s.day === 'last' ? dim : Math.min(typeof s.day === 'number' ? s.day : 1, dim), time))) break;
      }
      break;
  }
  return out;
}

/** The first moment after `after`, or null if it never comes (within a hundred years). */
export function nextOccurrence(s: Schedule, after: string): string | null {
  const y = Number(after.slice(0, 4)) + 100;
  return occurrences(s, after, `${pad(y, 4)}${after.slice(4, 10)}T23:59:59`, 1)[0] ?? null;
}

/** How many times a month it happens on average: a daily one about 30.44 times. */
export function perMonth(s: Schedule): number {
  switch (s.every) {
    case 'day':
      return 365.2425 / 12;
    case 'week':
      return 365.2425 / 7 / 12;
    case 'month':
      return 1;
    case 'year':
      return 1 / 12;
  }
}
