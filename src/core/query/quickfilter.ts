/**
 * The grid's auto-filter row (Task.md 8.2): what a person types under a column
 * header becomes a Filter. The forms follow the habits of desktop grids — text
 * means "contains", numbers and dates take `>100`, `10..20`, `<=01.10.2026`.
 *
 * Dates are matched as ranges of whole days, months or years, ending at
 * 'T23:59:59' so that the same filter works for date and date-time fields.
 */
import { t } from '../i18n';
import type { Filter, FilterOp } from './types';

export type QuickKind = 'text' | 'number' | 'date' | 'boolean' | 'enum';

type Parsed = Filter | null | { error: string };

const END_OF_DAY = 'T23:59:59';

function cond(field: string, op: FilterOp, value?: unknown): Filter {
  return value === undefined ? { field, op } : { field, op, value };
}

/** Number as typed: decimal comma or point, spaces (also no-break ones) as thousand separators. */
function parseNumber(s: string): number | null {
  const text = s.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

interface DayRange {
  from: string;
  to: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayRange(year: number, month: number, day: number): DayRange | null {
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  const d = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  return { from: d, to: d };
}

function monthRange(year: number, month: number): DayRange | null {
  if (month < 1 || month > 12) return null;
  return { from: `${pad(year, 4)}-${pad(month)}-01`, to: `${pad(year, 4)}-${pad(month)}-${pad(daysIn(year, month))}` };
}

function fullYear(text: string): number {
  const y = Number(text);
  return text.length <= 2 ? 2000 + y : y;
}

/** A day, a month or a year, as the inclusive range of days it covers. */
function parseDate(s: string): DayRange | null {
  const text = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return dayRange(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(text);
  if (m) return dayRange(fullYear(m[3]!), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (m) return monthRange(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})\.(\d{4})$/.exec(text);
  if (m) return monthRange(Number(m[2]), Number(m[1]));
  m = /^(\d{4})$/.exec(text);
  if (m) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
  return null;
}

/** The comparison prefix of a number or date input; the longest operators are tried first. */
function splitOperator(s: string): { op: string; rest: string } {
  for (const op of ['>=', '<=', '<>', '!=', '>', '<', '=']) {
    if (s.startsWith(op)) return { op, rest: s.slice(op.length).trim() };
  }
  return { op: '', rest: s };
}

function parseNumberFilter(field: string, s: string): Parsed {
  const notNumber = { error: t('query', 'Not a number') };
  if (s.includes(';')) {
    const values: number[] = [];
    for (const part of s.split(';')) {
      if (part.trim() === '') continue;
      const n = parseNumber(part);
      if (n === null) return notNumber;
      values.push(n);
    }
    return values.length ? cond(field, 'in', values) : null;
  }
  if (s.includes('..')) {
    const [a = '', b = ''] = s.split('..', 2);
    const from = a.trim() === '' ? null : parseNumber(a);
    const to = b.trim() === '' ? null : parseNumber(b);
    if ((from === null && a.trim() !== '') || (to === null && b.trim() !== '') || (from === null && to === null)) return notNumber;
    return cond(field, 'between', [from, to]);
  }
  const { op, rest } = splitOperator(s);
  const n = parseNumber(rest);
  if (n === null) return notNumber;
  switch (op) {
    case '>':
      return cond(field, 'gt', n);
    case '>=':
      return cond(field, 'ge', n);
    case '<':
      return cond(field, 'lt', n);
    case '<=':
      return cond(field, 'le', n);
    case '<>':
    case '!=':
      return cond(field, 'ne', n);
    default:
      return cond(field, 'eq', n);
  }
}

function dateFilter(field: string, op: string, r: DayRange): Filter {
  switch (op) {
    case '>':
      return cond(field, 'gt', r.to + END_OF_DAY);
    case '>=':
      return cond(field, 'ge', r.from);
    case '<':
      return cond(field, 'lt', r.from);
    case '<=':
      return cond(field, 'le', r.to + END_OF_DAY);
    case '<>':
    case '!=':
      return { not: cond(field, 'between', [r.from, r.to + END_OF_DAY]) };
    default:
      return cond(field, 'between', [r.from, r.to + END_OF_DAY]);
  }
}

function parseDateFilter(field: string, s: string): Parsed {
  const notDate = { error: t('query', 'Not a date') };
  if (s.includes(';')) {
    const parts: Filter[] = [];
    for (const part of s.split(';')) {
      if (part.trim() === '') continue;
      const r = parseDate(part);
      if (!r) return notDate;
      parts.push(dateFilter(field, '', r));
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0]! : { or: parts };
  }
  if (s.includes('..')) {
    const [a = '', b = ''] = s.split('..', 2);
    const from = a.trim() === '' ? null : parseDate(a);
    const to = b.trim() === '' ? null : parseDate(b);
    if ((from === null && a.trim() !== '') || (to === null && b.trim() !== '') || (from === null && to === null)) return notDate;
    return cond(field, 'between', [from ? from.from : null, to ? to.to + END_OF_DAY : null]);
  }
  const { op, rest } = splitOperator(s);
  const r = parseDate(rest);
  return r ? dateFilter(field, op, r) : notDate;
}

const YES = new Set(['yes', 'true', '1', '+', 'да', 'так', '✓', 'y']);
const NO = new Set(['no', 'false', '0', '-', 'нет', 'ні', 'n']);

function parseBooleanFilter(field: string, s: string): Parsed {
  const word = s.toLocaleLowerCase();
  if (YES.has(word)) return cond(field, 'eq', true);
  // An unset flag reads as "no" in a grid, so "no" finds those too.
  if (NO.has(word)) return { or: [cond(field, 'eq', false), cond(field, 'isNull')] };
  return { error: t('query', 'Type yes or no') };
}

function parseTextFilter(field: string, s: string): Parsed {
  if (s.startsWith('<>') || s.startsWith('!=')) return cond(field, 'ne', s.slice(2).trim());
  if (s.startsWith('=')) return cond(field, 'eq', s.slice(1).trim());
  if (s.startsWith('!')) {
    const rest = s.slice(1).trim();
    return rest === '' ? null : cond(field, 'notContains', rest);
  }
  const head = s.startsWith('*');
  const tail = s.endsWith('*');
  const core = s.slice(head ? 1 : 0, tail ? -1 : undefined).trim();
  if (core === '') return cond(field, 'isNotNull');
  if (head && !tail) return cond(field, 'endsWith', core);
  if (tail && !head) return cond(field, 'startsWith', core);
  return cond(field, 'contains', core);
}

export function parseQuickFilter(field: string, input: string, kind: QuickKind): Parsed {
  const s = input.trim();
  if (s === '') return null;
  // The forms for "empty" and "not empty" are the same in every column.
  if (s === '=' || s === '""') return cond(field, 'isNull');
  if (s === '*' || s === '!=' || s === '<>') return cond(field, 'isNotNull');
  switch (kind) {
    case 'number':
      return parseNumberFilter(field, s);
    case 'date':
      return parseDateFilter(field, s);
    case 'boolean':
      return parseBooleanFilter(field, s);
    case 'enum': {
      const values = s
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
      return values.length ? cond(field, 'in', values) : null;
    }
    default:
      return parseTextFilter(field, s);
  }
}
