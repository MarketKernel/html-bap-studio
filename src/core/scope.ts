/**
 * What expressions reach beyond their own record, and the host functions that
 * reach it (Task.md 7, Task_next.md 3.4–3.6).
 *
 * The evaluator is synchronous, so everything is loaded before it runs: the
 * expressions are read once, every reference path, register, table and
 * constant they name is collected from the tree, and loaded in one go. A list
 * of a thousand rows then costs a few queries, not a thousand.
 *
 *   lookup('Table', id, 'field')
 *   balance('Register', 'resource', 'dim', value, …)          on now
 *   balanceAt('Register', 'resource', date, 'dim', value, …)  on a date
 *   turnover(…), turnoverBetween('Register', 'resource', from, to, …)
 *   sumOf / avgOf / minOf / maxOf('Table', 'field', "condition")
 *   countOf('Table', "condition")
 *   firstOf / lastOf('Table', 'field', "condition", 'sortField')
 *   asOf('Table', seriesId, date, 'field')    a versioned record as it was
 *   reach('Report', 'measure', '<=', 0, 'param', value, …)
 *       the first step of a report (a series by days, say) where the measure
 *       meets the condition: when the money runs out, when a goal is affordable
 *   $const.name
 *
 * Register balances take in the movements planned by schedules up to their
 * date (core/planned.ts); aggregates over a versioned table see the versions
 * in force now.
 *
 * A condition is a text literal, an expression over the rows of the table
 * searched: bare names are its fields, `$this.x` is the record the outer
 * expression is about. Being a literal, it is parsed and checked with the
 * configuration, and what it reaches is loaded with the rest. A table may be
 * a document's part, 'Sales.lines', with `doc.x` for the document's fields.
 *
 * A computed field may aggregate its own table ("its share of the total"):
 * the rows it reads then have every computed field except those that
 * aggregate tables themselves — computing them would need the very value
 * being computed. `trail` carries the tables being computed down the chain.
 */
import { CONSTANTS, CONSTANTS_ID, constantsTable, inForce, table as tableOf } from './config/model';
import { expand, planSources, type PlanSource } from './planned';
import { runReport } from './reports';
import type { TableDef } from './config/types';
import { evaluate, visit, type Env, type Expr, type Value } from './expr/index';
import { clean, compare, toNumber } from './expr/functions';
import type { Row } from './query/types';
import { isoDate, isoDateTime, parseCached, partTableOf, truthy, type DataService } from './data';

export type EnvFactory = (row: Record<string, unknown>, extra?: Record<string, unknown>) => Env;

/** Where the condition and the sort field are among an aggregate's arguments. */
const AGGREGATES: Record<string, { field: boolean; cond: number; sort?: number }> = {
  sumof: { field: true, cond: 2 },
  avgof: { field: true, cond: 2 },
  minof: { field: true, cond: 2 },
  maxof: { field: true, cond: 2 },
  countof: { field: false, cond: 1 },
  firstof: { field: true, cond: 2, sort: 3 },
  lastof: { field: true, cond: 2, sort: 3 },
};
const REGISTERS = new Set(['balance', 'turnover', 'balanceat', 'turnoverbetween']);

/** The host functions with their argument counts: for the designer's checks. */
export const HOST_FUNCTIONS: Record<string, [number, number]> = {
  lookup: [2, 3],
  balance: [2, Infinity],
  balanceAt: [3, Infinity],
  turnover: [2, Infinity],
  turnoverBetween: [4, Infinity],
  sumOf: [2, 3],
  avgOf: [2, 3],
  minOf: [2, 3],
  maxOf: [2, 3],
  countOf: [1, 2],
  firstOf: [2, 4],
  lastOf: [2, 4],
  asOf: [4, 4],
  reach: [4, Infinity],
  currentUser: [0, 0],
  nextNumber: [1, 1],
};

/** The literal text of an argument, if it is one. */
const literal = (node: Expr | undefined): string | undefined => (node?.type === 'literal' && typeof node.value === 'string' ? node.value : undefined);

/** A table an aggregate reads, with its condition and what its fields need. */
export interface AggregateCall {
  table: string;
  field?: string;
  cond?: string;
  sort?: string;
}

/** Every aggregate call in an expression whose table is a literal: for loading, and for the designer's checks. */
export function aggregateCalls(expr: Expr): AggregateCall[] {
  const out: AggregateCall[] = [];
  visit(expr, (node) => {
    if (node.type !== 'call') return;
    const spec = AGGREGATES[node.name.toLowerCase()];
    const table = literal(node.args[0]);
    if (!spec || !table) return;
    const call: AggregateCall = { table };
    const field = spec.field ? literal(node.args[1]) : undefined;
    const cond = literal(node.args[spec.cond]);
    const sort = spec.sort ? literal(node.args[spec.sort]) : undefined;
    if (field) call.field = field;
    if (cond) call.cond = cond;
    if (sort) call.sort = sort;
    out.push(call);
  });
  return out;
}

/** Whether an expression aggregates a table: such a field is left out when its own table is read for an aggregate. */
export function aggregatesTables(source: string): boolean {
  try {
    return aggregateCalls(parseCached(source)).length > 0;
  } catch {
    return false;
  }
}

interface Source {
  table: TableDef;
  /** For a part: the document table; each row carries its document as `doc`. */
  owner?: TableDef;
  rows: Record<string, unknown>[];
  maps: Map<string, Map<string, Row>>;
  conds: Map<string, { expr: Expr; envOf: EnvFactory; perRow: boolean }>;
}

/** The table an aggregate names: a table, or a document's part. */
function sourceOf(data: DataService, name: string): { table: TableDef; owner?: TableDef; part?: string } | null {
  const [head, part] = name.split('.') as [string, string?];
  const tb = tableOf(data.config, head);
  if (!tb) return null;
  if (part) return (tb.parts ?? []).some((p) => p.name === part) ? { table: partTableOf(tb, part), owner: tb, part } : null;
  return { table: tb };
}

/** The default order of firstOf/lastOf: by date where there is one, else by creation. */
function defaultSort(src: { table: TableDef; owner?: TableDef }): string {
  if (src.owner) return 'doc.date';
  return src.table.kind === 'document' || src.table.kind === 'register' || src.table.fields.some((f) => f.name === 'date') ? 'date' : '_createdAt';
}

const reachKey = (report: string, params: Record<string, unknown>) => `${report}|${JSON.stringify(params)}`;

/** The latest moment a movement may have to count by a date: a plain date takes its whole day in. */
function upTo(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  return v.length === 10 ? `${v}T23:59:59` : v;
}

export async function buildScope(data: DataService, tb: TableDef, sources: string[], vars: Record<string, unknown>, docTable: TableDef | undefined, trail: string[]): Promise<EnvFactory> {
  const paths: string[] = [];
  const docPaths: string[] = [];
  const constPaths: string[] = [];
  const registers = new Set<string>();
  const lookups = new Set<string>();
  const aggregates = new Map<string, AggregateCall[]>();
  const reaches = new Map<string, { report: string; params: Record<string, unknown> }>();
  let constants = false;
  const collect = (expr: Expr) => {
    visit(expr, (node) => {
      if (node.type === 'path') {
        const p = node.path;
        const head = p[0]!;
        if ((head === 'doc' || head === '$doc') && p.length > 2) docPaths.push(p.slice(1).join('.'));
        else if (head === '$this' && p.length > 2) paths.push(p.slice(1).join('.'));
        else if (head === '$const') {
          constants = true;
          if (p.length > 2) constPaths.push(p.slice(1).join('.'));
        } else if (!head.startsWith('$') && head !== 'doc') paths.push(p.join('.'));
        return;
      }
      if (node.type !== 'call') return;
      const fn = node.name.toLowerCase();
      const first = literal(node.args[0]);
      if (!first) return;
      if (REGISTERS.has(fn)) registers.add(first);
      else if (fn === 'lookup' || fn === 'asof') lookups.add(first);
      else if (fn === 'reach') {
        // Parameters given as literal pairs; the report is run once, before anything is evaluated.
        const params: Record<string, unknown> = {};
        for (let i = 4; i + 1 < node.args.length; i += 2) {
          const k = literal(node.args[i]);
          const v = node.args[i + 1];
          if (k && v?.type === 'literal') params[k] = k === 'period' ? { kind: v.value } : v.value;
        }
        reaches.set(reachKey(first, params), { report: first, params });
      }
    });
    for (const call of aggregateCalls(expr)) {
      aggregates.set(call.table, [...(aggregates.get(call.table) ?? []), call]);
      if (!call.cond) continue;
      // Inside a condition only `$this` is about this record: what it reaches is loaded here.
      try {
        visit(parseCached(call.cond), (node) => {
          if (node.type === 'path' && node.path[0] === '$this' && node.path.length > 2) paths.push(node.path.slice(1).join('.'));
        });
      } catch {
        // A broken condition is the configuration's problem, shown by the designer; the call finds nothing.
      }
    }
  };
  for (const source of sources) {
    try {
      collect(parseCached(source));
    } catch {
      continue;
    }
  }

  const maps = await data.refMaps(tb, paths);
  if (docTable && docPaths.length) for (const [name, rows] of await data.refMaps(docTable, docPaths)) maps.set(name, rows);
  for (const name of lookups) if (tableOf(data.config, name)) maps.set(name, await data.rowsById(name));
  const registerRows = new Map<string, Row[]>();
  const registerPlans = new Map<string, PlanSource[]>();
  for (const name of registers) {
    if (!tableOf(data.config, name)) continue;
    registerRows.set(name, [...(await data.rowsById(name)).values()]);
    const plans = await planSources(data, name, trail);
    if (plans.length) registerPlans.set(name, plans);
  }

  const constTable = constants ? constantsTable(data.config) : undefined;
  let constRow: Row | null = null;
  if (constTable) {
    constRow = (await data.rowsById(CONSTANTS)).get(CONSTANTS_ID) ?? null;
    for (const [name, rows] of await data.refMaps(constTable, constPaths)) maps.set(name, rows);
  }

  const tables = new Map<string, Source>();
  for (const [name, calls] of aggregates) {
    const src = sourceOf(data, name);
    if (!src) continue;
    let rows: Record<string, unknown>[];
    if (src.owner && src.part) {
      const docs = await data.all(src.owner.name);
      await data.compute(src.owner, docs, {}, trail);
      rows = docs.flatMap((doc) => ((doc[src.part!] as Record<string, unknown>[] | undefined) ?? []).map((line) => ({ ...line, doc })));
    } else {
      // A register's movements up to now, the planned ones included, as its balances count them.
      rows = src.table.kind === 'register' ? await data.movements(src.table.name) : await data.all(src.table.name);
      // Of a versioned table, the versions in force: the past ones are history, not records.
      if (src.table.versioned) rows = rows.filter((r) => inForce(src.table, r, isoDateTime(data.context.now())));
      await data.compute(src.table, rows as Row[], {}, trail);
    }
    const fieldPaths = calls.flatMap((c) => [c.field ?? '', c.sort ?? defaultSort(src)]).filter((p) => p.includes('.') && !p.startsWith('doc.'));
    const source: Source = { table: src.table, ...(src.owner ? { owner: src.owner } : {}), rows, maps: await data.refMaps(src.table, fieldPaths), conds: new Map() };
    for (const call of calls) {
      if (!call.cond || source.conds.has(call.cond)) continue;
      let expr: Expr;
      try {
        expr = parseCached(call.cond);
      } catch {
        continue;
      }
      const envOf = await buildScope(data, src.table, [call.cond], vars, src.owner, trail);
      source.conds.set(call.cond, { expr, envOf, perRow: /\$this\b/i.test(call.cond) });
    }
    tables.set(name, source);
  }

  const reachRows = new Map<string, { key: string; rows: Record<string, unknown>[] }>();
  for (const [key, { report, params }] of reaches) {
    const def = data.config.reports.find((r) => r.name === report);
    if (!def) continue;
    try {
      const result = await runReport(data, def, params, data.context.now(), trail);
      reachRows.set(key, { key: result.columns[0]?.key ?? '', rows: result.rows });
    } catch {
      // A report that cannot run reaches nothing.
    }
  }

  const now = data.context.now();
  const nowText = isoDateTime(now);
  const user = data.context.user();

  /** Planned movements up to a moment, made once per moment asked for. */
  const plannedUpTo = new Map<string, Row[]>();
  const planned = (register: string, to: string | null): Row[] => {
    const plans = registerPlans.get(register);
    if (!plans) return [];
    const bound = to ?? nowText;
    const key = `${register}|${bound}`;
    let rows = plannedUpTo.get(key);
    if (!rows) {
      rows = expand(plans, null, bound);
      plannedUpTo.set(key, rows);
    }
    return rows;
  };
  /** The register's movements that match the dimension pairs and the dates, planned ones included. */
  const movements = (register: string, pairs: Value[], from: string | null, to: string | null): Row[] => {
    const out: Row[] = [];
    for (const r of [...(registerRows.get(register) ?? []), ...planned(register, to)]) {
      const date = typeof r.date === 'string' ? r.date : null;
      if (date !== null && to !== null && date > to) continue;
      if (date !== null && from !== null && date < from) continue;
      let ok = true;
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        if (r[String(pairs[i])] !== pairs[i + 1]) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(r);
    }
    return out;
  };
  const total = (rows: Row[], resource: string, signed: boolean): number => {
    let sum = 0;
    for (const r of rows) {
      const v = Number(r[resource]) || 0;
      sum += signed && r.direction === 'out' ? -v : v;
    }
    return Number(sum.toPrecision(15));
  };

  const dynamic = (src: Source, text: string): Source['conds'] extends Map<string, infer C> ? C | undefined : never => {
    let expr: Expr;
    try {
      expr = parseCached(text);
    } catch {
      return undefined;
    }
    const envOf: EnvFactory = (r, extra = {}) => ({
      now: () => now,
      resolve: (path) => {
        if (path[0] === '$this' && extra.outer) return (extra.outer as Env).resolve(path);
        if (path[0] === 'doc' && src.owner) return data.walk(src.owner, r.doc as Row, path.slice(1), src.maps);
        return path[0]!.startsWith('$') ? (vars[path[0]!.slice(1)] ?? null) : data.walk(src.table, r, path, src.maps);
      },
    });
    const c = { expr, envOf, perRow: true };
    src.conds.set(text, c);
    return c;
  };

  const memo = new Map<string, Value>();
  const aggregate = (fn: string, args: Value[], outer: Env): Value => {
    const spec = AGGREGATES[fn]!;
    const src = tables.get(String(args[0]));
    const field = spec.field ? String(args[1] ?? '') : '';
    const cond = args[spec.cond];
    const empty = fn === 'sumof' || fn === 'countof' ? 0 : null;
    if (!src) return empty;
    const text = typeof cond === 'string' && cond.trim() ? cond : null;
    // A condition built at run time was not seen in advance: it reads the row and `$this`, but no further data.
    const c = text ? (src.conds.get(text) ?? dynamic(src, text)) : undefined;
    const key = c?.perRow ? null : JSON.stringify([fn, ...args]);
    if (key !== null && memo.has(key)) return memo.get(key)!;
    const rows = c
      ? src.rows.filter((r) => {
          try {
            return truthy(evaluate(c.expr, c.envOf(r, { outer, ...(src.owner ? { doc: r.doc, docTable: src.owner } : {}) })));
          } catch {
            return false;
          }
        })
      : src.rows;
    const value = (r: Record<string, unknown>, path: string) => data.walk(src.table, r, path.split('.'), src.maps) as Value;
    let result: Value;
    switch (fn) {
      case 'countof':
        result = rows.length;
        break;
      case 'sumof':
      case 'avgof': {
        let sum = 0;
        let n = 0;
        for (const r of rows) {
          const x = toNumber(value(r, field));
          if (x === null) continue;
          sum = clean(sum + x) ?? 0;
          n += 1;
        }
        result = fn === 'sumof' ? sum : n ? clean(sum / n) : null;
        break;
      }
      case 'minof':
      case 'maxof': {
        const sign = fn === 'maxof' ? 1 : -1;
        let best: Value = null;
        for (const r of rows) {
          const x = value(r, field);
          if (x === null) continue;
          if (best === null || (compare(x, best) ?? 0) * sign > 0) best = x;
        }
        result = best;
        break;
      }
      default: {
        const sort = typeof args[spec.sort!] === 'string' && args[spec.sort!] ? String(args[spec.sort!]) : defaultSort(src);
        let best: Record<string, unknown> | null = null;
        let bestKey: Value = null;
        for (const r of rows) {
          const k = value(r, sort);
          if (best === null) {
            best = r;
            bestKey = k;
            continue;
          }
          const order = compare(k, bestKey);
          // Ties keep the first for firstOf and take the later for lastOf: the order rows came in.
          if (order === null ? bestKey === null && k !== null : fn === 'firstof' ? order < 0 : order >= 0) {
            best = r;
            bestKey = k;
          }
        }
        result = best ? value(best, field) : null;
      }
    }
    if (key !== null) memo.set(key, result);
    return result;
  };

  return (row, extra = {}) => {
    const env: Env = {
      now: () => now,
      resolve: (path) => {
        const head = path[0]!;
        if (head.startsWith('$')) {
          const name = head.slice(1);
          // Inside a condition `$this` is the record the outer expression is about.
          if (name === 'this' && extra.outer) return (extra.outer as Env).resolve(path);
          if (name === 'const') return constTable && constRow ? (path.length === 1 ? constRow : data.walk(constTable, constRow, path.slice(1), maps)) : null;
          let base: unknown = name === 'this' ? row : name === 'user' ? user : name === 'today' ? isoDate(now) : name === 'now' ? nowText : (extra[name] ?? vars[name]);
          if (path.length === 1) return base;
          if (name === 'this' || name === 'doc') return data.walk(name === 'doc' ? ((extra.docTable as TableDef | undefined) ?? tb) : tb, base as Row, path.slice(1), maps);
          for (const p of path.slice(1)) base = base && typeof base === 'object' ? (base as Record<string, unknown>)[p] : null;
          return base ?? null;
        }
        if (head === 'doc' && extra.doc) return data.walk((extra.docTable as TableDef | undefined) ?? tb, extra.doc as Row, path.slice(1), maps);
        return data.walk(tb, row, path, maps);
      },
      call: (name, args, self) => {
        const fn = name.toLowerCase();
        if (fn === 'currentuser') return user;
        if (fn === 'lookup') {
          const [table, id, f] = args as [string, string, string];
          const target = maps.get(table)?.get(String(id));
          return target ? ((target[f ?? 'id'] as Value) ?? null) : null;
        }
        if (fn === 'reach') {
          const [report, measure, op, threshold, ...pairs] = args;
          const params: Record<string, unknown> = {};
          for (let i = 0; i + 1 < pairs.length; i += 2) params[String(pairs[i])] = String(pairs[i]) === 'period' ? { kind: pairs[i + 1] } : pairs[i + 1];
          const found = reachRows.get(reachKey(String(report), params));
          if (!found) return null;
          for (const r of found.rows) {
            const c = compare(r[String(measure)], threshold);
            if (c === null) continue;
            if (op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '=' ? c === 0 : op === '<>' ? c !== 0 : false) return (r[found.key] as Value) ?? null;
          }
          return null;
        }
        if (fn === 'asof') {
          // The version of a series in force at a moment: validFrom ≤ date < validTo.
          const [table, series, date, f] = args;
          const at = typeof date === 'string' ? (date.length === 10 ? `${date}T23:59:59` : date) : null;
          if (!at) return null;
          for (const r of maps.get(String(table))?.values() ?? []) {
            if ((r.seriesId ?? r.id) !== series) continue;
            if (String(r.validFrom ?? '') <= at && (!r.validTo || String(r.validTo) > at)) return (r[String(f)] as Value) ?? null;
          }
          return null;
        }
        if (fn === 'balance' || fn === 'turnover') {
          const [register, resource, ...pairs] = args;
          return total(movements(String(register), pairs, null, nowText), String(resource), fn === 'balance');
        }
        if (fn === 'balanceat') {
          const [register, resource, date, ...pairs] = args;
          const to = upTo(date);
          return to === null ? null : total(movements(String(register), pairs, null, to), String(resource), true);
        }
        if (fn === 'turnoverbetween') {
          const [register, resource, from, to, ...pairs] = args;
          return total(movements(String(register), pairs, typeof from === 'string' ? from : null, upTo(to)), String(resource), false);
        }
        if (AGGREGATES[fn]) return aggregate(fn, args, self);
        return undefined;
      },
    };
    return env;
  };
}
