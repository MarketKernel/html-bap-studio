/**
 * The client-side query engine: filtering, sorting, paging and aggregation over
 * plain arrays of rows. The core runs it for sources that cannot do these
 * themselves, and the built-in local source and the grid use it too, so a query
 * behaves the same wherever it is answered (Task.md 5.4).
 *
 * Filters are compiled once into closures; on 100 000 rows the per-row cost of
 * re-reading the filter tree and re-lowercasing the needle would dominate.
 */
import type { AggregateQuery, Condition, Filter, Measure, OrderBy, Query } from './types';

type AnyRow = Record<string, unknown>;

const defaultCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const hasOwn = Object.prototype.hasOwnProperty;

export function getField(row: AnyRow, path: string): unknown {
  // The core materialises path values as flat keys ('product.name'), so those win.
  if (hasOwn.call(row, path)) return row[path] ?? null;
  if (!path.includes('.')) return null;
  let value: unknown = row;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as AnyRow)[part];
  }
  return value ?? null;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Rank of a non-empty value's type, for comparing across types: boolean < number < string < anything else. */
function rank(value: unknown): number {
  switch (typeof value) {
    case 'boolean':
      return 1;
    case 'number':
      return 2;
    case 'string':
      return 3;
    default:
      return 4;
  }
}

/** True for strings that start like 'YYYY-MM-DD': those compare by code points, which is their chronological order. */
function isIsoLike(s: string): boolean {
  if (s.length < 10) return false;
  const c = (i: number): number => s.charCodeAt(i);
  const digit = (i: number): boolean => c(i) >= 48 && c(i) <= 57;
  return digit(0) && digit(1) && digit(2) && digit(3) && c(4) === 45 && digit(5) && digit(6) && c(7) === 45 && digit(8) && digit(9);
}

function codePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compare(a: unknown, b: unknown, collator: Intl.Collator = defaultCollator): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea && eb ? 0 : ea ? -1 : 1;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 2) {
    const x = a as number;
    const y = b as number;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (ra === 1) return a === b ? 0 : a ? 1 : -1;
  if (ra === 3) {
    const x = a as string;
    const y = b as string;
    if (x === y) return 0;
    if (isIsoLike(x) && isIsoLike(y)) return codePoints(x, y);
    return collator.compare(x, y);
  }
  return collator.compare(JSON.stringify(a) ?? '', JSON.stringify(b) ?? '');
}

/** `between` bounds: strings by code points so ISO dates and date-times interleave correctly. */
function compareBound(a: unknown, b: unknown): number {
  if (typeof a === 'string' && typeof b === 'string') return codePoints(a, b);
  return compare(a, b);
}

function lower(value: unknown): string {
  return String(value).toLocaleLowerCase();
}

type Predicate = (row: AnyRow) => boolean;

function compileCondition(c: Condition): Predicate {
  const { field, value } = c;
  const get = (row: AnyRow): unknown => getField(row, field);
  switch (c.op) {
    case 'eq':
      if (isEmpty(value)) return (row) => isEmpty(get(row));
      return (row) => get(row) === value;
    case 'ne':
      if (isEmpty(value)) return (row) => !isEmpty(get(row));
      return (row) => get(row) !== value;
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge': {
      if (isEmpty(value)) return () => false;
      const op = c.op;
      return (row) => {
        const v = get(row);
        if (isEmpty(v)) return false;
        const r = compare(v, value);
        return op === 'lt' ? r < 0 : op === 'le' ? r <= 0 : op === 'gt' ? r > 0 : r >= 0;
      };
    }
    case 'in':
    case 'notIn': {
      const list: unknown[] = Array.isArray(value) ? value : [];
      const set = new Set(list.filter((v) => !isEmpty(v)));
      const withEmpty = list.some(isEmpty);
      const test = (v: unknown): boolean => (isEmpty(v) ? withEmpty : set.has(v));
      return c.op === 'in' ? (row) => test(get(row)) : (row) => !test(get(row));
    }
    case 'contains':
    case 'notContains':
    case 'startsWith':
    case 'endsWith': {
      const needle = lower(value ?? '');
      const op = c.op;
      return (row) => {
        const v = get(row);
        if (v === null || v === undefined) return op === 'notContains';
        const s = lower(v);
        if (op === 'contains') return s.includes(needle);
        if (op === 'notContains') return !s.includes(needle);
        if (op === 'startsWith') return s.startsWith(needle);
        return s.endsWith(needle);
      };
    }
    case 'between': {
      const pair: unknown[] = Array.isArray(value) ? value : [];
      const from = pair[0];
      const to = pair[1];
      const openFrom = isEmpty(from);
      const openTo = isEmpty(to);
      return (row) => {
        const v = get(row);
        if (isEmpty(v)) return false;
        if (!openFrom && compareBound(v, from) < 0) return false;
        if (!openTo && compareBound(v, to) > 0) return false;
        return true;
      };
    }
    case 'isNull':
      return (row) => isEmpty(get(row));
    case 'isNotNull':
      return (row) => !isEmpty(get(row));
    default:
      // An operator from a newer contract: refusing to match is safer than matching everything.
      return () => false;
  }
}

export function compileFilter(filter: Filter | undefined): Predicate {
  if (!filter) return () => true;
  if ('and' in filter) {
    const parts = filter.and.map(compileFilter);
    return (row) => parts.every((p) => p(row));
  }
  if ('or' in filter) {
    const parts = filter.or.map(compileFilter);
    return (row) => parts.some((p) => p(row));
  }
  if ('not' in filter) {
    const inner = compileFilter(filter.not);
    return (row) => !inner(row);
  }
  return compileCondition(filter);
}

export function matches(row: AnyRow, filter: Filter | undefined): boolean {
  return compileFilter(filter)(row);
}

export function sortRows<T extends AnyRow>(rows: T[], orderBy: OrderBy[] | undefined, collator: Intl.Collator = defaultCollator): T[] {
  if (!orderBy || orderBy.length === 0) return rows.slice();
  // Decorate once: reading paths inside the comparator would repeat for every comparison.
  const keys = orderBy.map((o) => rows.map((r) => getField(r, o.field)));
  const signs = orderBy.map((o) => (o.desc ? -1 : 1));
  const index = rows.map((_, i) => i);
  index.sort((i, j) => {
    for (let k = 0; k < keys.length; k++) {
      const column = keys[k]!;
      const r = compare(column[i], column[j], collator);
      if (r !== 0) return r * signs[k]!;
    }
    return i - j;
  });
  return index.map((i) => rows[i]!);
}

function project<T extends AnyRow>(row: T, select: string[]): T {
  const out: AnyRow = { id: row.id };
  if (row._rev !== undefined) out._rev = row._rev;
  for (const field of select) out[field] = getField(row, field);
  return out as T;
}

export function runQuery<T extends AnyRow>(rows: T[], q: Query): { rows: T[]; total?: number; cursor?: string } {
  let list = q.where ? rows.filter(compileFilter(q.where)) : rows;
  list = sortRows(list, q.orderBy);
  const result: { rows: T[]; total?: number; cursor?: string } = { rows: [] };
  if (q.count) result.total = list.length;
  const fromCursor = q.cursor !== undefined && q.cursor !== '' ? Number.parseInt(q.cursor, 10) : NaN;
  const start = Math.max(0, Number.isFinite(fromCursor) ? fromCursor : (q.offset ?? 0));
  const end = q.limit !== undefined && q.limit >= 0 ? start + q.limit : list.length;
  let page = list.slice(start, end);
  if (q.limit !== undefined && end < list.length) result.cursor = String(end);
  if (q.select) {
    const select = q.select;
    page = page.map((r) => project(r, select));
  }
  result.rows = page;
  return result;
}

/** Sums of decimals drift (0.1 + 0.2); fifteen significant digits is what a double holds exactly. */
function clean(x: number): number {
  return Number(x.toPrecision(15));
}

interface Accumulator {
  add(row: AnyRow): void;
  result(): unknown;
}

function accumulator(m: Measure): Accumulator {
  const field = m.field;
  const get = (row: AnyRow): unknown => (field === undefined ? null : getField(row, field));
  switch (m.fn) {
    case 'sum': {
      let sum = 0;
      return {
        add: (row) => {
          const v = get(row);
          if (typeof v === 'number' && Number.isFinite(v)) sum += v;
        },
        result: () => clean(sum),
      };
    }
    case 'avg': {
      let sum = 0;
      let n = 0;
      return {
        add: (row) => {
          const v = get(row);
          if (typeof v === 'number' && Number.isFinite(v)) {
            sum += v;
            n += 1;
          }
        },
        result: () => (n === 0 ? null : clean(sum / n)),
      };
    }
    case 'count': {
      let n = 0;
      return {
        add: (row) => {
          if (field === undefined || !isEmpty(get(row))) n += 1;
        },
        result: () => n,
      };
    }
    case 'countDistinct': {
      const seen = new Set<unknown>();
      return {
        add: (row) => {
          const v = get(row);
          if (!isEmpty(v)) seen.add(typeof v === 'object' ? JSON.stringify(v) : v);
        },
        result: () => seen.size,
      };
    }
    case 'min':
    case 'max': {
      const sign = m.fn === 'min' ? -1 : 1;
      let best: unknown = null;
      return {
        add: (row) => {
          const v = get(row);
          if (isEmpty(v)) return;
          if (best === null || compare(v, best) * sign > 0) best = v;
        },
        result: () => best,
      };
    }
    default:
      return { add: () => undefined, result: () => null };
  }
}

function totals(rows: AnyRow[], measures: Measure[]): Record<string, unknown> {
  const accs = measures.map(accumulator);
  for (const row of rows) for (const a of accs) a.add(row);
  const out: Record<string, unknown> = {};
  measures.forEach((m, i) => {
    out[m.name] = accs[i]!.result();
  });
  return out;
}

/** A Map key for a group value; '' and undefined fall in with null, as everywhere else in the engine. */
function groupKey(value: unknown): unknown {
  if (isEmpty(value)) return null;
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

export function aggregate(rows: AnyRow[], q: Omit<AggregateQuery, 'table'> & { table?: string }): AnyRow[] {
  const list = q.where ? rows.filter(compileFilter(q.where)) : rows;
  const groupBy = q.groupBy;
  let out: AnyRow[];
  if (groupBy.length === 0) {
    out = [totals(list, q.measures)];
  } else {
    const groups = new Map<string, { values: unknown[]; accs: Accumulator[] }>();
    for (const row of list) {
      const values = groupBy.map((f) => {
        const v = getField(row, f);
        return isEmpty(v) ? null : v;
      });
      const key = JSON.stringify(values.map((v) => [typeof v, v]));
      let g = groups.get(key);
      if (!g) {
        g = { values, accs: q.measures.map(accumulator) };
        groups.set(key, g);
      }
      for (const a of g.accs) a.add(row);
    }
    out = [];
    for (const g of groups.values()) {
      const r: AnyRow = {};
      groupBy.forEach((f, i) => {
        r[f] = g.values[i];
      });
      q.measures.forEach((m, i) => {
        r[m.name] = g.accs[i]!.result();
      });
      out.push(r);
    }
  }
  // Without an explicit order, groups come out in the order of their keys, so reports are reproducible.
  const orderBy = q.orderBy && q.orderBy.length > 0 ? q.orderBy : groupBy.map((field) => ({ field }));
  return sortRows(out, orderBy);
}

export interface GroupNode<T> {
  field: string;
  value: unknown;
  path: unknown[];
  rows: T[];
  children: GroupNode<T>[];
  totals: Record<string, unknown>;
}

function buildLevel<T extends AnyRow>(rows: T[], fields: string[], level: number, path: unknown[], measures: Measure[]): GroupNode<T>[] {
  const field = fields[level];
  if (field === undefined) return [];
  const groups = new Map<unknown, { value: unknown; rows: T[] }>();
  for (const row of rows) {
    const raw = getField(row, field);
    const value = isEmpty(raw) ? null : raw;
    const key = groupKey(value);
    let g = groups.get(key);
    if (!g) {
      g = { value, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(row);
  }
  const ordered = [...groups.values()].sort((a, b) => compare(a.value, b.value));
  return ordered.map((g) => {
    const p = [...path, g.value];
    return {
      field,
      value: g.value,
      path: p,
      rows: g.rows,
      children: buildLevel(g.rows, fields, level + 1, p, measures),
      totals: totals(g.rows, measures),
    };
  });
}

export function groupTree<T extends AnyRow>(rows: T[], fields: string[], measures: Measure[]): GroupNode<T>[] {
  return buildLevel(rows, fields, 0, [], measures);
}

/** Distinct values of a field, sorted; empty values collapse into one leading null (the "(empty)" entry of a value list). */
export function distinctValues(rows: AnyRow[], field: string, limit?: number): unknown[] {
  const seen = new Map<unknown, unknown>();
  for (const row of rows) {
    const raw = getField(row, field);
    const value = isEmpty(raw) ? null : raw;
    const key = groupKey(value);
    if (!seen.has(key)) seen.set(key, value);
  }
  const values = [...seen.values()].sort((a, b) => compare(a, b));
  return limit !== undefined && limit >= 0 ? values.slice(0, limit) : values;
}
