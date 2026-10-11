/**
 * Reports (Task.md 11.1): a source, a period, a filter, groupings and
 * measures, run over the rows the DataService gives.
 *
 * The source is a table, a document part ('Sales.lines' — one row per line,
 * with `doc.x` for the document's fields) or a register: its balances at the
 * end of the period (movements out count negative) or its turnover within it.
 * A grouping may bucket a date: 'date:month', 'date:year', 'date:day'.
 */
import { language, t } from './i18n';
import { allFields, fieldAtPath, inForce, NOWHERE, table as tableOf } from './config/model';
import type { FieldDef, RefLine, ReportDef, TableDef } from './config/types';
import { DataService, isoDate, isoDateTime, parseCached, partTableOf, truthy } from './data';
import { evaluate } from './expr/index';
import { formatDate } from './format';
import { aggregate, runQuery } from './query/index';
import type { Row } from './query/types';

/** A period; `next:3m` — from today three months ahead (d, w, m, y). */
export type PeriodKind = 'all' | 'today' | 'week' | 'month' | 'quarter' | 'year' | 'lastMonth' | 'custom' | `next:${number}${'d' | 'w' | 'm' | 'y'}`;

export interface Period {
  kind: PeriodKind;
  from?: string;
  to?: string;
}

export interface ReportColumn {
  key: string;
  title: string;
  field?: FieldDef;
  measure?: boolean;
  /** A measure whose sum means nothing: no total under it. */
  noTotal?: boolean;
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  /** Group values as shown (labels of references, month names) by column key. */
  labels: Record<string, Map<unknown, string>>;
  /** Levels drawn across the chart: zero, each goal's price. */
  refLines?: { value: number; title: string }[];
  /** A plugin's own chart for its report, when the configuration names none. */
  chart?: NonNullable<ReportDef['chart']>;
}

export function periodRange(p: Period, now = new Date()): { from: string | null; to: string | null } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = (yy: number, mm: number, dd: number) => isoDate(new Date(yy, mm, dd));
  switch (p.kind) {
    case 'today':
      return { from: isoDate(now), to: isoDate(now) };
    case 'week': {
      const day = (now.getDay() + 6) % 7;
      return { from: d(y, m, now.getDate() - day), to: d(y, m, now.getDate() - day + 6) };
    }
    case 'month':
      return { from: d(y, m, 1), to: d(y, m + 1, 0) };
    case 'lastMonth':
      return { from: d(y, m - 1, 1), to: d(y, m, 0) };
    case 'quarter': {
      const q = Math.floor(m / 3) * 3;
      return { from: d(y, q, 1), to: d(y, q + 3, 0) };
    }
    case 'year':
      return { from: d(y, 0, 1), to: d(y, 11, 31) };
    case 'custom':
      return { from: p.from ?? null, to: p.to ?? null };
    default: {
      const ahead = /^next:(\d+)([dwmy])$/.exec(p.kind);
      if (!ahead) return { from: null, to: null };
      const n = Number(ahead[1]);
      const unit = ahead[2];
      const end = unit === 'd' ? d(y, m, now.getDate() + n) : unit === 'w' ? d(y, m, now.getDate() + 7 * n) : unit === 'm' ? d(y, m + n, now.getDate()) : d(y + n, m, now.getDate());
      return { from: isoDate(now), to: end };
    }
  }
}

export const PERIODS: PeriodKind[] = ['all', 'today', 'week', 'month', 'lastMonth', 'quarter', 'year', 'custom'];
/** The periods ahead, offered where the future means something: a register's balances, a series. */
export const PERIODS_AHEAD: PeriodKind[] = ['next:7d', 'next:1m', 'next:3m', 'next:6m', 'next:1y', 'next:5y'];

export function periodTitle(kind: PeriodKind): string {
  switch (kind) {
    case 'all':
      return t('reports', 'All time');
    case 'today':
      return t('reports', 'Today');
    case 'week':
      return t('reports', 'This week');
    case 'month':
      return t('reports', 'This month');
    case 'lastMonth':
      return t('reports', 'Last month');
    case 'quarter':
      return t('reports', 'This quarter');
    case 'year':
      return t('reports', 'This year');
    case 'next:7d':
      return t('reports', 'The next 7 days');
    case 'next:1m':
      return t('reports', 'The next month');
    case 'next:3m':
      return t('reports', 'The next 3 months');
    case 'next:6m':
      return t('reports', 'The next 6 months');
    case 'next:1y':
      return t('reports', 'The next year');
    case 'next:5y':
      return t('reports', 'The next 5 years');
    case 'custom':
      return t('reports', 'From… to…');
    default:
      return kind;
  }
}

/** The table a report reads, as fields go: a part's lines look like a table of their own. */
export function reportSourceTable(data: DataService, source: string): { table: TableDef; owner?: TableDef; part?: string } | null {
  const [name, part] = source.split('.') as [string, string?];
  const tb = tableOf(data.config, name);
  if (!tb) return null;
  if (part) return { table: partTableOf(tb, part), owner: tb, part };
  return { table: tb };
}

/**
 * The period a report opens with: its period parameter's default — a kind,
 * or an expression after '=' that gives one (`='next:' & $const.horizonYears & 'y'`).
 */
export async function defaultPeriod(data: DataService, report: ReportDef): Promise<Period> {
  const def = report.params?.find((p) => p.type === 'period')?.default?.trim();
  if (!def) return { kind: 'all' };
  if (!def.startsWith('=')) return { kind: def as PeriodKind };
  const src = reportSourceTable(data, report.source);
  if (!src) return { kind: 'all' };
  try {
    const envOf = await data.scope(src.table, [def.slice(1)]);
    const kind = evaluate(parseCached(def.slice(1)), envOf({}));
    return typeof kind === 'string' ? { kind: kind.replace(/\s+/g, '') as PeriodKind } : { kind: 'all' };
  } catch {
    return { kind: 'all' };
  }
}

function bucket(value: unknown, unit: string): unknown {
  if (typeof value !== 'string') return null;
  if (unit === 'year') return value.slice(0, 4);
  if (unit === 'month') return value.slice(0, 7);
  if (unit === 'day') return value.slice(0, 10);
  if (unit === 'week') return mondayOf(value.slice(0, 10));
  return value;
}

/** The Monday of a date's week, YYYY-MM-DD: a week bucket is named by its first day. */
function mondayOf(date: string): string {
  const d = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}

/** The buckets of a series from one date to another, each with its last moment. */
function buckets(from: string, to: string, unit: 'day' | 'week' | 'month'): { key: string; end: string }[] {
  const out: { key: string; end: string }[] = [];
  const d = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (unit === 'month') d.setDate(1);
  // A bounded loop: twenty years of days at most.
  for (let i = 0; i < 7400; i++) {
    const key = unit === 'month' ? isoDate(d).slice(0, 7) : isoDate(d);
    if ((unit === 'month' ? `${key}-01` : key) > to) break;
    const last = new Date(d);
    if (unit === 'week') last.setDate(last.getDate() + 6);
    if (unit === 'month') last.setMonth(last.getMonth() + 1, 0);
    out.push({ key, end: `${isoDate(last)}T23:59:59` });
    if (unit === 'day') d.setDate(d.getDate() + 1);
    else if (unit === 'week') d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1, 1);
  }
  return out;
}

export async function runReport(data: DataService, report: ReportDef, params: Record<string, unknown>, now = new Date(), trail: string[] = []): Promise<ReportResult> {
  if (report.plugin) return pluginReport(data, report, { ...params, period: params.period ?? (await defaultPeriod(data, report)) });
  const src = reportSourceTable(data, report.source);
  if (!src) throw new Error(t('reports', 'The report reads “{source}”, which does not exist', { source: report.source }));
  const { table, owner, part } = src;
  const mark = `report:${report.name}`;
  // A report asked for by an expression its own rows evaluate: nothing, rather than for ever.
  if (trail.includes(mark)) return { columns: [], rows: [], labels: {} };
  const below = [...trail, mark];
  const mode = report.mode ?? 'rows';
  const period = (params.period as Period | undefined) ?? (await defaultPeriod(data, report));
  const range = periodRange(period, now);
  let items: Record<string, unknown>[];
  if (owner && part) {
    const docs = await data.all(owner.name);
    await data.compute(owner, docs, {}, below);
    items = docs.flatMap((doc) => ((doc[part] as Record<string, unknown>[] | undefined) ?? []).map((line) => ({ ...line, doc })));
  } else {
    // A register's movements up to the end of the period, the planned ones included: a period ahead is a forecast.
    items = table.kind === 'register' ? await data.movements(table.name, range.to ? `${range.to}T23:59:59` : mode === 'series' ? `${isoDate(now)}T23:59:59` : null) : await data.all(table.name);
    await data.compute(table, items as Row[], {}, below);
  }
  const dateField = report.dateField ?? (table.kind === 'register' || table.kind === 'document' ? 'date' : undefined);
  const dateOf = (item: Record<string, unknown>, full = false) => {
    if (!dateField) return null;
    const path = dateField.split('.');
    let v: unknown = item;
    for (const p of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : null;
    return typeof v === 'string' ? (full ? v : v.slice(0, 10)) : null;
  };
  // A balance and a series count everything up to the end; the other modes, what is inside the period.
  const upToEnd = mode === 'balance' || mode === 'series';
  if (dateField && (range.from || range.to)) {
    items = items.filter((item) => {
      const d = dateOf(item);
      if (!d) return false;
      if (upToEnd) return !range.to || d <= range.to;
      return (!range.from || d >= range.from) && (!range.to || d <= range.to);
    });
  }
  if (table.kind === 'register' && upToEnd) {
    const resources = table.fields.filter((f) => f.role === 'resource').map((f) => f.name);
    items = items.map((m) => (m.direction === 'out' ? { ...m, ...Object.fromEntries(resources.map((r) => [r, -(Number(m[r]) || 0)])) } : m));
  }
  const extra = (item: Record<string, unknown>) => (owner ? { doc: item.doc, docTable: owner } : {});
  if (report.where) {
    const envOf = await data.scope(table, [report.where], { params }, undefined, below);
    const expr = parseCached(report.where);
    items = items.filter((item) => {
      try {
        return truthy(evaluate(expr, envOf(item, extra(item))));
      } catch {
        return false;
      }
    });
  }
  // A series is the balance at the end of each step: the date is its own grouping.
  const unit = report.bucket ?? 'day';
  const groupBy = mode === 'series' ? report.groupBy.filter((g) => g.split(':')[0] !== dateField) : report.groupBy;
  const seriesKey = `${dateField ?? 'date'}:${unit}`;
  // Measures read a field, or an expression over the row, and only the rows their own condition lets through.
  const keyOf = (m: ReportDef['measures'][number]) => (m.expr || m.where ? `__m:${m.name}` : (m.field ?? ''));
  const computed = report.measures.filter((m) => m.expr || m.where);
  const measureEnv = computed.length ? await data.scope(table, computed.flatMap((m) => [m.expr, m.where].filter((x): x is string => !!x)), { params }, owner, below) : null;
  // Group keys and measure fields as flat values: paths walked, dates bucketed.
  const fieldPaths = [...groupBy.map((g) => g.split(':')[0]!), ...report.measures.filter((m) => !m.expr).map((m) => m.field ?? '')];
  const maps = await data.refMaps(table, fieldPaths.filter((p) => p.includes('.') && !p.startsWith('doc.')));
  // doc.customer.name in a report over lines: the references are the document's.
  const docPaths = fieldPaths.filter((p) => p.startsWith('doc.') && p.split('.').length > 2).map((p) => p.slice(4));
  if (owner && docPaths.length) for (const [name, rows] of await data.refMaps(owner, docPaths)) maps.set(name, rows);
  const walkAt = (item: Record<string, unknown>, path: string) => (path.startsWith('doc.') && owner ? data.walk(owner, item.doc as Row, path.slice(4).split('.'), maps) : data.walk(table, item, path.split('.'), maps));
  const flat = items.map((item) => {
    const out: Record<string, unknown> = {};
    for (const g of groupBy) {
      const [path, u] = g.split(':') as [string, string?];
      const raw = walkAt(item, path);
      out[g] = u ? bucket(raw, u) : raw;
    }
    const env = measureEnv ? measureEnv(item, extra(item)) : null;
    for (const m of report.measures) {
      if (!m.expr && !m.where) {
        if (m.field) out[m.field] = walkAt(item, m.field);
        continue;
      }
      let value: unknown = null;
      try {
        if (!m.where || truthy(evaluate(parseCached(m.where), env!))) value = m.expr ? evaluate(parseCached(m.expr), env!) : m.field ? walkAt(item, m.field) : 1;
      } catch {
        value = null;
      }
      out[keyOf(m)] = value;
    }
    if (mode === 'series') out.__date = dateOf(item, true);
    return out;
  });
  let rows: Record<string, unknown>[];
  if (mode === 'series') {
    rows = series(flat, groupBy, report.measures.map((m) => ({ name: m.name, fn: m.fn, key: keyOf(m) })), range.from ?? (flat.map((r) => String(r.__date ?? '')).filter(Boolean).sort()[0]?.slice(0, 10) ?? isoDate(now)), range.to ?? isoDate(now), unit, seriesKey);
    if (report.sort?.length) rows = runQuery(rows as Row[], { table: '', orderBy: report.sort }).rows;
  } else {
    rows = aggregate(flat, { groupBy, measures: report.measures.map((m) => ({ name: m.name, fn: m.fn, ...(keyOf(m) ? { field: keyOf(m) } : {}) })), ...(report.sort ? { orderBy: report.sort } : {}) });
  }
  if (table.kind === 'register' && mode === 'balance') {
    const first = report.measures[0]?.name;
    // Balances of zero are what was sold out: not worth a line.
    if (first) for (let i = rows.length - 1; i >= 0; i--) if (rows[i]![first] === 0) rows.splice(i, 1);
  }
  // Columns worked out from each grouped row.
  for (const c of report.columns ?? []) {
    let expr: ReturnType<typeof parseCached>;
    try {
      expr = parseCached(c.expr);
    } catch {
      continue;
    }
    for (const r of rows) {
      try {
        r[c.name] = evaluate(expr, { resolve: (path) => (path[0]!.startsWith('$') ? ((params[path[0]!.slice(1)] as unknown) ?? null) : (r[path.join('.')] ?? null)), now: () => now });
      } catch {
        r[c.name] = null;
      }
    }
  }
  const labels: Record<string, Map<unknown, string>> = {};
  const columns: ReportColumn[] = [];
  if (mode === 'series') {
    const map = new Map<unknown, string>();
    for (const r of rows) {
      const v = r[seriesKey];
      if (typeof v === 'string') map.set(v, unit === 'month' ? new Intl.DateTimeFormat(language(), { month: 'short', year: 'numeric' }).format(new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, 1)) : formatDate(v));
    }
    labels[seriesKey] = map;
    columns.push({ key: seriesKey, title: t('reports', 'Date') });
  }
  for (const g of groupBy) {
    const [path, u] = g.split(':') as [string, string?];
    const at = path.startsWith('doc.') && owner ? fieldAtPath(data.config, owner, path.slice(4)) : fieldAtPath(data.config, table, path);
    const f = at?.field;
    const map = new Map<unknown, string>();
    if (f?.type === 'ref' && f.ref) {
      const target = tableOf(data.config, f.ref);
      const byId = await data.rowsById(f.ref);
      for (const r of rows) {
        const id = r[g];
        if (id && target) map.set(id, byId.get(String(id)) ? data.rowLabel(target, byId.get(String(id))!) : String(id));
      }
    } else if (f?.type === 'enum') {
      const values = f.options?.length ? f.options : (data.config.enums.find((e) => e.name === f.enum)?.values ?? []);
      for (const v of values) map.set(v.value, v.title);
    } else if (u === 'month') {
      for (const r of rows) {
        const v = r[g];
        if (typeof v === 'string') map.set(v, new Intl.DateTimeFormat(language(), { month: 'short', year: 'numeric' }).format(new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, 1)));
      }
    } else if (u === 'day' || u === 'week') {
      for (const r of rows) {
        const v = r[g];
        if (typeof v === 'string') map.set(v, formatDate(v));
      }
    }
    labels[g] = map;
    columns.push({ key: g, title: f?.title ?? path, ...(f && !u ? { field: f } : {}) });
  }
  for (const m of report.measures) {
    const f = m.field && !m.expr ? (m.field.startsWith('doc.') && owner ? fieldAtPath(data.config, owner, m.field.slice(4))?.field : fieldAtPath(data.config, table, m.field)?.field) : undefined;
    const field: FieldDef = m.fn === 'count' || m.fn === 'countDistinct' ? { key: m.name, name: m.name, type: 'integer' } : { key: m.name, name: m.name, type: 'decimal', scale: f?.scale ?? 2 };
    columns.push({ key: m.name, title: m.title ?? f?.title ?? m.name, field, measure: true });
  }
  for (const c of report.columns ?? []) columns.push({ key: c.name, title: c.title ?? c.name, field: { key: c.name, name: c.name, type: 'decimal', scale: c.scale ?? 2 }, measure: true });
  const refLines = report.chart?.refLines?.length ? await levels(data, table, report.chart.refLines, params, below) : [];
  void allFields;
  return { columns, rows, labels, ...(refLines.length ? { refLines } : {}) };
}

/** A report a plugin computes: its columns and rows as the studio shows any other. */
async function pluginReport(data: DataService, report: ReportDef, params: Record<string, unknown>): Promise<ReportResult> {
  if (!data.pluginReport) throw new Error(t('reports', 'Plugins do not run here'));
  const { plugin, report: name } = report.plugin!;
  const out = await data.pluginReport(plugin, name, params);
  const columns: ReportColumn[] = (Array.isArray(out?.columns) ? out.columns : []).map((c) => {
    const measure = c.type === 'number';
    const type = c.type === 'number' ? 'decimal' : c.type === 'date' ? 'date' : c.type === 'datetime' ? 'datetime' : 'string';
    return { key: String(c.key), title: String(c.title ?? c.key), field: { key: String(c.key), name: String(c.key), type, ...(measure ? { scale: c.scale ?? 2 } : {}) } as FieldDef, ...(measure ? { measure } : {}), ...(c.total === false ? { noTotal: true } : {}) };
  });
  const rows = Array.isArray(out?.rows) ? out.rows.filter((r) => r && typeof r === 'object') : [];
  return { columns, rows, labels: {}, ...(out?.chart && !report.chart ? { chart: out.chart } : {}) };
}

/**
 * The balance at the end of every step from `from` to `to`, by the other
 * groupings: each row's measures added up from the first movement on. A
 * grouping first seen later is zero before.
 */
function series(flat: Record<string, unknown>[], groupBy: string[], measures: { name: string; fn: string; key: string }[], from: string, to: string, unit: 'day' | 'week' | 'month', seriesKey: string): Record<string, unknown>[] {
  const sorted = flat.filter((r) => r.__date).sort((a, b) => String(a.__date).localeCompare(String(b.__date)));
  const groups = new Map<string, Record<string, unknown>>();
  for (const r of sorted) {
    const k = JSON.stringify(groupBy.map((g) => r[g] ?? null));
    if (!groups.has(k)) groups.set(k, { ...Object.fromEntries(groupBy.map((g) => [g, r[g] ?? null])), ...Object.fromEntries(measures.map((m) => [m.name, 0])) });
  }
  if (!groups.size) groups.set('[]', Object.fromEntries(measures.map((m) => [m.name, 0])));
  const out: Record<string, unknown>[] = [];
  let i = 0;
  for (const b of buckets(from, to, unit)) {
    while (i < sorted.length && String(sorted[i]!.__date) <= b.end) {
      const r = sorted[i++]!;
      const total = groups.get(JSON.stringify(groupBy.map((g) => r[g] ?? null)))!;
      for (const m of measures) {
        const v = r[m.key];
        if (m.fn === 'count' || m.fn === 'countDistinct') total[m.name] = (total[m.name] as number) + (v === null || v === undefined || v === '' ? 0 : 1);
        else {
          const n = Number(v);
          if (Number.isFinite(n) && v !== null && v !== '') total[m.name] = Number(((total[m.name] as number) + n).toPrecision(15));
        }
      }
    }
    for (const total of groups.values()) out.push({ [seriesKey]: b.key, ...total });
  }
  return out;
}

/** The levels a chart draws: a value, or one per row of a table. */
async function levels(data: DataService, table: TableDef, lines: RefLine[], params: Record<string, unknown>, trail: string[]): Promise<{ value: number; title: string }[]> {
  const out: { value: number; title: string }[] = [];
  const now = isoDateTime(data.context.now());
  for (const line of lines) {
    try {
      if (line.from) {
        const tb = data.table(line.from);
        let rows = (await data.all(tb.name)).filter((r) => inForce(tb, r, now));
        await data.compute(tb, rows, {}, trail);
        const sources = [line.value, ...(line.title ? [line.title] : []), ...(line.where ? [line.where] : [])];
        const envOf = await data.scope(tb, sources, { params }, undefined, trail);
        if (line.where) rows = rows.filter((r) => truthy(evaluate(parseCached(line.where!), envOf(r))));
        for (const r of rows) {
          const v = Number(evaluate(parseCached(line.value), envOf(r)));
          if (Number.isFinite(v)) out.push({ value: v, title: line.title ? String(evaluate(parseCached(line.title), envOf(r)) ?? '') : data.rowLabel(tb, r) });
        }
      } else {
        const envOf = await data.scope(table, [line.value], { params }, undefined, trail);
        const v = Number(evaluate(parseCached(line.value), envOf({})));
        if (Number.isFinite(v)) out.push({ value: v, title: line.title ?? '' });
      }
    } catch {
      // A level that cannot be worked out is not drawn; the designer shows why.
    }
  }
  return out;
}

/** Expressions that belong to no record (a dashboard's), loaded together; each gives null when it fails. */
export async function evaluator(data: DataService, sources: string[], vars: Record<string, unknown> = {}): Promise<(source: string) => unknown> {
  const envOf = await data.scope(NOWHERE, sources, vars);
  const env = envOf({});
  return (source) => {
    try {
      return evaluate(parseCached(source), env);
    } catch {
      return null;
    }
  };
}

/** A single number for a KPI tile: an aggregate over a table with an expression filter. */
export async function kpi(data: DataService, tableName: string, fn: string, field: string | undefined, where: string | undefined): Promise<number> {
  const tb = data.table(tableName);
  let rows = await data.all(tb.name);
  await data.compute(tb, rows);
  if (where) {
    const envOf = await data.scope(tb, [where]);
    const expr = parseCached(where);
    rows = rows.filter((r) => {
      try {
        return truthy(evaluate(expr, envOf(r)));
      } catch {
        return false;
      }
    });
  }
  const result = aggregate(rows, { groupBy: [], measures: [{ name: 'v', fn: fn as 'sum', ...(field ? { field } : {}) }] });
  return Number(result[0]?.v ?? 0);
}
