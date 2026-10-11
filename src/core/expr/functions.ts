/**
 * Value rules shared by the operators and the built-in functions, and the
 * built-ins themselves.
 *
 * Values follow the one convention of Task.md 5.4: a date is 'YYYY-MM-DD', a
 * date-time 'YYYY-MM-DDTHH:mm:ss' (local, no zone). Calendar math works on the
 * year/month/day parts through UTC, so daylight saving never shifts a day.
 */
import { t, tn } from '../i18n';
import type { Env, Value } from './eval';
import { nextOccurrence, occurrences, perMonth, readSchedule, type Schedule } from '../schedule';
import type { Expr } from './parser';

// ---------------------------------------------------------------- values

/** Drops binary float noise: 0.1 + 0.2 is 0.3, as people expect from money. */
export function clean(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const r = Number(x.toPrecision(15));
  return r === 0 ? 0 : r;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** A number for arithmetic: numbers, booleans and numeric strings; anything else is null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim();
    return NUMERIC.test(s) ? Number(s) : null;
  }
  return null;
}

export function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(toText).join(', ');
  return JSON.stringify(v);
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  return v !== null && v !== undefined && v !== false && v !== '';
}

export function equals(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equals(x, b[i]));
  }
  if (typeof a === typeof b) return typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b;
  // A number typed into a text field still equals the number.
  if (typeof a === 'number' && typeof b === 'string') return toNumber(b) === a;
  if (typeof a === 'string' && typeof b === 'number') return toNumber(a) === b;
  return false;
}

/** Order of two values, or null when they cannot be ordered (null, mixed kinds). */
export function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return compareText(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number' || typeof b === 'number') {
    const x = toNumber(a);
    const y = toNumber(b);
    if (x !== null && y !== null && typeof a !== 'boolean' && typeof b !== 'boolean') return x < y ? -1 : x > y ? 1 : 0;
  }
  return null;
}

/** By code points, not UTF-16 units, so characters beyond the BMP sort after the rest. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i += 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

// ---------------------------------------------------------------- dates

export interface DateParts {
  y: number;
  m: number;
  d: number;
  /** Seconds since midnight, or null for a plain date. */
  time: number | null;
}

const DATE_START = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_PART = /^T(\d{2}):(\d{2})(?::(\d{2}))?/;
const DAY = 86400;

export function isDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_START.test(v);
}

export function parseDate(v: unknown): DateParts | null {
  if (typeof v !== 'string') return null;
  const m = DATE_START.exec(v);
  if (!m) return null;
  const tm = TIME_PART.exec(v.slice(10));
  const time = tm ? Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3] ?? 0) : null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), time };
}

/** Days since 1970-01-01; setUTCFullYear keeps years below 100 as written. */
function dayNumber(y: number, m: number, d: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return Math.round(date.getTime() / 86400000);
}

function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const date = new Date(n * 86400000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function formatDate(y: number, m: number, d: number, time: number | null = null): string {
  // Normalise overflowing parts (month 13, day 0) through the calendar.
  const p = fromDayNumber(dayNumber(y, m, d));
  const date = `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
  if (time === null) return date;
  return `${date}T${pad(Math.floor(time / 3600))}:${pad(Math.floor(time / 60) % 60)}:${pad(time % 60)}`;
}

export function addDays(p: DateParts, n: number): string {
  if (p.time === null) return formatDate(p.y, p.m, p.d + Math.trunc(n));
  const total = dayNumber(p.y, p.m, p.d) * DAY + p.time + Math.round(n * DAY);
  const days = Math.floor(total / DAY);
  const q = fromDayNumber(days);
  return formatDate(q.y, q.m, q.d, total - days * DAY);
}

/** b − a in days; fractional when either has a time. */
export function daysBetween(a: DateParts, b: DateParts): number | null {
  const da = dayNumber(a.y, a.m, a.d) + (a.time ?? 0) / DAY;
  const db = dayNumber(b.y, b.m, b.d) + (b.time ?? 0) / DAY;
  return clean(db - da);
}

export function addMonths(p: DateParts, n: number): string {
  const total = p.y * 12 + (p.m - 1) + Math.trunc(n);
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  // Jan 31 + 1 month is the last day of February, not March 3.
  return formatDate(y, m, Math.min(p.d, daysInMonth(y, m)), p.time);
}

function daysInMonth(y: number, m: number): number {
  return fromDayNumber(dayNumber(y, m + 1, 1) - 1).d;
}

/** Whole months from a to b, counting only completed ones, signed. */
function monthsBetween(a: DateParts, b: DateParts): number {
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  const ka = a.d * DAY + (a.time ?? 0);
  const kb = b.d * DAY + (b.time ?? 0);
  if (months > 0 && kb < ka) months -= 1;
  else if (months < 0 && kb > ka) months += 1;
  return months;
}

function localNow(env: Env): Date {
  return env.now ? env.now() : new Date();
}

// ---------------------------------------------------------------- numbers

/** Moves the decimal point through the decimal text, so 1.005 shifted by 2 is exactly 100.5. */
function shift(x: number, by: number): number {
  const [mantissa, exponent] = String(x).split('e');
  return Number(`${mantissa}e${Number(exponent ?? 0) + by}`);
}

/** Half away from zero on the decimal value people see: round(2.675, 2) = 2.68, round(-2.5) = -3. */
export function round(x: number, digits = 0): number {
  const d = Math.trunc(digits);
  const r = shift(Math.round(shift(Math.abs(x), d)), -d);
  return x < 0 && r !== 0 ? -r : r;
}

function parseNumber(v: unknown): number | null {
  if (typeof v === 'string') {
    const s = v.replace(/[\s  ]/g, '').replace(',', '.');
    return s && NUMERIC.test(s) ? Number(s) : null;
  }
  return toNumber(v);
}

function items(args: Value[]): Value[] {
  const first = args[0];
  return args.length === 1 && Array.isArray(first) ? first : args;
}

function extreme(args: Value[], sign: 1 | -1): Value {
  let best: Value = null;
  for (const v of items(args)) {
    if (v === null || v === undefined) continue;
    if (best === null) best = v;
    else if ((compare(v, best) ?? 0) * sign > 0) best = v;
  }
  return best;
}

function numbers(v: Value): number[] {
  const list = Array.isArray(v) ? v : [v];
  const out: number[] = [];
  for (const x of list) {
    const n = toNumber(x);
    if (n !== null) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- the table

export interface CallContext {
  env: Env;
  /** The argument expressions, for the functions that evaluate them lazily. */
  args: Expr[];
  evaluate(expr: Expr): Value;
  /** Throws an error underlining argument `index`, or the whole call. */
  fail(message: string, index?: number): never;
}

export interface FunctionDef {
  /** As documented and offered by autocomplete. */
  name: string;
  min: number;
  max: number;
  /** Receives no evaluated arguments; evaluates ctx.args itself. */
  lazy?: boolean;
  fn(args: Value[], ctx: CallContext): Value;
}

type Fn = FunctionDef['fn'];

const BUILTINS = new Map<string, FunctionDef>();

function def(name: string, min: number, max: number, fn: Fn, lazy = false): void {
  BUILTINS.set(name.toLowerCase(), { name, min, max, fn, lazy });
}

/** Wraps a one-number function: null and non-numbers give null. */
function numeric(f: (x: number, digits: number) => number): Fn {
  return ([x, d]) => {
    const n = toNumber(x);
    return n === null ? null : clean(f(n, toNumber(d ?? 0) ?? 0));
  };
}

/** Wraps a text function: null gives null. */
function textual(f: (s: string, args: Value[]) => Value): Fn {
  return (args) => (args[0] === null || args[0] === undefined ? null : f(toText(args[0]), args.slice(1)));
}

/** Wraps a date function: null or a non-date gives null. */
function dated(f: (p: DateParts, args: Value[]) => Value): Fn {
  return (args) => {
    const p = parseDate(args[0]);
    return p ? f(p, args.slice(1)) : null;
  };
}

// logic
def('iif', 3, 3, (_, c) => (truthy(c.evaluate(c.args[0] as Expr)) ? c.evaluate(c.args[1] as Expr) : c.evaluate(c.args[2] as Expr)), true);
def('coalesce', 1, Infinity, (_, c) => {
  for (const arg of c.args) {
    const v = c.evaluate(arg);
    if (v !== null) return v;
  }
  return null;
}, true);
def('isEmpty', 1, 1, ([x]) => x === null || x === undefined || x === '' || (Array.isArray(x) && x.length === 0));

// numbers
def('round', 1, 2, numeric(round));
def('floor', 1, 2, numeric((x, d) => shift(Math.floor(shift(x, Math.trunc(d))), -Math.trunc(d))));
def('ceil', 1, 2, numeric((x, d) => shift(Math.ceil(shift(x, Math.trunc(d))), -Math.trunc(d))));
def('abs', 1, 1, numeric(Math.abs));
def('min', 1, Infinity, (args) => extreme(args, -1));
def('max', 1, Infinity, (args) => extreme(args, 1));
def('number', 1, 1, ([x]) => parseNumber(x));

// strings
def('len', 1, 1, ([s]) => (s === null || s === undefined ? 0 : Array.isArray(s) ? s.length : Array.from(toText(s)).length));
def('upper', 1, 1, textual((s) => s.toUpperCase()));
def('lower', 1, 1, textual((s) => s.toLowerCase()));
def('trim', 1, 1, textual((s) => s.trim()));
def('left', 2, 2, textual((s, [n]) => Array.from(s).slice(0, Math.max(0, toNumber(n) ?? 0)).join('')));
def('right', 2, 2, textual((s, [n]) => {
  const k = Math.max(0, toNumber(n) ?? 0);
  return k === 0 ? '' : Array.from(s).slice(-k).join('');
}));
def('contains', 2, 2, ([s, sub]) => toText(s).toLowerCase().includes(toText(sub).toLowerCase()));
def('startsWith', 2, 2, ([s, sub]) => toText(s).toLowerCase().startsWith(toText(sub).toLowerCase()));
def('replace', 3, 3, textual((s, [a, b]) => {
  const from = toText(a);
  return from ? s.split(from).join(toText(b)) : s;
}));
def('concat', 1, Infinity, (args) => args.map(toText).join(''));
def('text', 1, 1, ([x]) => toText(x));
def('format', 1, 2, ([x, d]) => {
  const n = toNumber(x);
  if (n === null || typeof x === 'string') return toText(x);
  const digits = Math.min(20, Math.max(0, Math.trunc(toNumber(d ?? 0) ?? 0)));
  return round(n, digits).toFixed(digits);
});
def('padLeft', 2, 3, textual((s, [n, ch]) => s.padStart(toNumber(n) ?? 0, toText(ch ?? '0') || '0')));

// dates
def('today', 0, 0, (_, c) => {
  const now = localNow(c.env);
  return formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
});
def('now', 0, 0, (_, c) => {
  const now = localNow(c.env);
  return formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds());
});
def('year', 1, 1, dated((p) => p.y));
def('month', 1, 1, dated((p) => p.m));
def('day', 1, 1, dated((p) => p.d));
def('weekday', 1, 1, dated((p) => ((((dayNumber(p.y, p.m, p.d) + 3) % 7) + 7) % 7) + 1));
def('addDays', 2, 2, dated((p, [n]) => {
  const k = toNumber(n);
  return k === null ? null : addDays(p, k);
}));
def('addMonths', 2, 2, dated((p, [n]) => {
  const k = toNumber(n);
  return k === null ? null : addMonths(p, k);
}));
def('addYears', 2, 2, dated((p, [n]) => {
  const k = toNumber(n);
  return k === null ? null : addMonths(p, Math.trunc(k) * 12);
}));
def('dateDiff', 3, 3, ([unit, a, b], c) => {
  const u = toText(unit).toLowerCase().replace(/s$/, '');
  if (u !== 'day' && u !== 'month' && u !== 'year') {
    c.fail(t('expr', 'Unknown unit “{unit}”: use “day”, “month” or “year”', { unit: toText(unit) }), 0);
  }
  const pa = parseDate(a);
  const pb = parseDate(b);
  if (!pa || !pb) return null;
  if (u === 'day') {
    const days = daysBetween(pa, pb);
    return days === null ? null : Math.trunc(days);
  }
  const months = monthsBetween(pa, pb);
  return u === 'month' ? months : Math.trunc(months / 12);
});
def('startOfMonth', 1, 1, dated((p) => formatDate(p.y, p.m, 1)));
def('endOfMonth', 1, 1, dated((p) => formatDate(p.y, p.m, daysInMonth(p.y, p.m))));
def('startOfYear', 1, 1, dated((p) => formatDate(p.y, 1, 1)));
def('endOfYear', 1, 1, dated((p) => formatDate(p.y, 12, 31)));
def('date', 3, 3, ([y, m, d]) => {
  const parts = [toNumber(y), toNumber(m), toNumber(d)];
  if (parts.some((x) => x === null)) return null;
  const [yy, mm, dd] = parts.map((x) => Math.trunc(x as number)) as [number, number, number];
  return formatDate(yy, mm, dd);
});

// schedules (core/schedule.ts): schedule('month', '09:00', 15), nextOccurrence(when, now())
def('schedule', 1, 4, ([every, time, day, month], c) => {
  const s = readSchedule({ every, ...(time ? { time } : {}), ...(every === 'week' ? { weekday: toNumber(day) } : { day: day === 'last' ? 'last' : toNumber(day) }), month: toNumber(month) });
  if (!s) c.fail(t('expr', 'Unknown schedule “{every}”: use “day”, “week”, “month” or “year”', { every: toText(every) }), 0);
  return s as unknown as Value;
});
const asSchedule = (v: Value | undefined): Schedule | null => readSchedule(v);
def('nextOccurrence', 2, 2, ([s, after]) => {
  const sch = asSchedule(s);
  return sch && typeof after === 'string' && isDate(after) ? nextOccurrence(sch, after) : null;
});
def('occurrences', 3, 3, ([s, from, to]) => {
  const sch = asSchedule(s);
  // At most ten thousand: a list to count or take the first of, not a calendar of centuries.
  return sch && isDate(to) ? occurrences(sch, isDate(from) ? from : null, to, 10_000) : [];
});
def('perMonth', 1, 1, ([s]) => {
  const sch = asSchedule(s);
  return sch ? clean(perMonth(sch)) : null;
});

// collections
def('sum', 1, 1, ([x]) => {
  let total = 0;
  for (const n of numbers(x ?? null)) total = clean(total + n) ?? 0;
  return total;
});
def('count', 1, 1, ([x]) => (x === null || x === undefined ? 0 : Array.isArray(x) ? x.length : 1));
def('avg', 1, 1, ([x]) => {
  const list = numbers(x ?? null);
  if (!list.length) return null;
  let total = 0;
  for (const n of list) total += n;
  return clean(total / list.length);
});

export function builtin(name: string): FunctionDef | undefined {
  return BUILTINS.get(name.toLowerCase());
}

export const FUNCTIONS: string[] = [...BUILTINS.values()].map((f) => f.name);

/** The error for a wrong number of arguments, or undefined when the count fits. */
export function arityError(f: FunctionDef, count: number): string | undefined {
  if (count >= f.min && count <= f.max) return undefined;
  if (f.min === f.max) {
    return tn('expr', 'Function “{name}” takes {count} argument', 'Function “{name}” takes {count} arguments', f.min, { name: f.name });
  }
  if (f.max === Infinity) {
    return tn('expr', 'Function “{name}” takes at least {count} argument', 'Function “{name}” takes at least {count} arguments', f.min, { name: f.name });
  }
  return t('expr', 'Function “{name}” takes from {min} to {max} arguments', { name: f.name, min: f.min, max: f.max });
}
