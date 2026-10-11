/**
 * DataService: everything between the screens and the data sources (Task.md 4).
 *
 * It knows which connection holds which table, does on the client what a
 * source cannot (filter, sort, page, aggregate — with the same engine the
 * built-in source uses), resolves references for display and for expressions,
 * fills defaults, computes computed fields, checks records, numbers documents,
 * stamps who changed what, and announces every write so open lists refresh.
 *
 * Expressions are evaluated synchronously. Before evaluating, the service
 * loads what the expressions will reach — referenced records, register rows —
 * into caches, so a list of a thousand rows costs a few queries, not a thousand.
 */
import { t } from './i18n';
import { allFields, CONSTANTS, connectionOf, displayField, field as fieldOf, inForce, table as tableOf } from './config/model';
import type { Config, FieldDef, TableDef } from './config/types';
import { evaluate, ExprError, parseExpr, type Env, type Expr } from './expr/index';
import { aggregatesTables, buildScope } from './scope';
import { expand, planSources, scheduledRules } from './planned';
import { scaled } from './format';
import { aggregate as aggregateRows, runQuery } from './query/index';
import type { AggregateQuery, Filter, Query, QueryResult, Row } from './query/types';
import { uuid } from './ids';
import { PluginError, type BatchOp, type Capabilities, type Connection, type PluginReportResult } from './plugin-protocol';

export interface DataContext {
  user(): string;
  now(): Date;
}

export interface Problem {
  /** Shown, but does not stop the save. */
  warning?: boolean;
  field?: string;
  /** The part and line, for a problem inside a document's part. */
  part?: string;
  line?: number;
  message: string;
}

export class ValidationError extends Error {
  constructor(readonly problems: Problem[]) {
    super(problems.map((p) => p.message).join('\n'));
    this.name = 'ValidationError';
  }
}

interface Linked {
  connection: Connection;
  caps: Capabilities;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function isoDateTime(d: Date): string {
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The parsed expression, or the error with its text, cached by source. */
const parsed = new Map<string, Expr | ExprError>();
export function parseCached(source: string): Expr {
  let p = parsed.get(source);
  if (!p) {
    try {
      p = parseExpr(source);
    } catch (error) {
      p = error instanceof ExprError ? error : new ExprError(String(error), 0, source.length);
    }
    if (parsed.size > 2000) parsed.clear();
    parsed.set(source, p);
  }
  if (p instanceof ExprError) throw p;
  return p;
}

export type Hook = (event: 'beforeSave' | 'afterSave' | 'beforeDelete' | 'afterDelete', tb: TableDef, row: Row, previous: Row | null) => Promise<void>;

export class DataService {
  private links = new Map<string, Linked>();
  private refCache = new Map<string, Promise<Map<string, Row>>>();
  private listeners = new Set<(tables: string[]) => void>();
  /** Triggers and posting plug in here (core/actions.ts, core/registers.ts). */
  hooks: Hook[] = [];
  /** Turns a record into its register movements; set by core/registers.ts. */
  poster: ((tb: TableDef, row: Row) => Promise<BatchOp[]>) | null = null;

  constructor(
    public config: Config,
    readonly context: DataContext,
  ) {}

  setConfig(config: Config): void {
    this.config = config;
    this.refCache.clear();
  }

  link(id: string, connection: Connection, caps: Capabilities): void {
    this.links.set(id, { connection, caps });
    this.refCache.clear();
  }

  unlink(id: string): void {
    this.links.delete(id);
    this.refCache.clear();
  }

  linked(id: string): Linked | undefined {
    return this.links.get(id);
  }

  table(name: string): TableDef {
    const tb = tableOf(this.config, name);
    if (!tb) throw new PluginError('not_found', t('data', 'No table “{name}” in the configuration', { name }));
    return tb;
  }

  private linkOf(tb: TableDef): Linked {
    const id = connectionOf(this.config, tb);
    const link = this.links.get(id);
    if (!link) throw new PluginError('network', t('data', 'The data source “{id}” is not connected', { id }));
    return link;
  }

  capabilities(tb: TableDef): Capabilities {
    return this.linkOf(tb).caps;
  }

  writable(tb: TableDef): boolean {
    if (tb.readOnly) return false;
    try {
      return this.linkOf(tb).caps.write;
    } catch {
      return false;
    }
  }

  onChange(listener: (tables: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A write here or elsewhere (another tab, another user): drop caches and tell the screens. */
  changed(tables: string[]): void {
    for (const name of tables) this.refCache.delete(name);
    for (const listener of this.listeners) listener(tables);
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  /** A query in the configuration's terms; what the source cannot do is done here. */
  async query(q: Query): Promise<QueryResult> {
    const tb = this.table(q.table);
    const { connection, caps } = this.linkOf(tb);
    const simpleWhere = !q.where || !containsPath(q.where);
    const canWhere = caps.query.where && simpleWhere;
    const canSort = caps.query.orderBy && !(q.orderBy ?? []).some((o) => o.field.includes('.'));
    if (canWhere && canSort && (caps.query.paging || (q.limit === undefined && !q.offset && !q.cursor))) {
      const result = await connection.query(q);
      // Without a count the length is the total only when nothing was cut off by paging.
      if (q.count && result.total === undefined && !caps.query.count && q.limit === undefined && !q.offset && !q.cursor) return { ...result, total: result.rows.length };
      return result;
    }
    // Fetch what the source can narrow down, then finish here.
    const rows = (await connection.query({ table: q.table, ...(canWhere && q.where ? { where: q.where } : {}) })).rows;
    const usable = q.where && !canWhere ? await this.withPaths(tb, rows, filterPaths(q.where)) : rows;
    const sorted = (q.orderBy ?? []).some((o) => o.field.includes('.')) ? await this.withPaths(tb, usable, (q.orderBy ?? []).map((o) => o.field)) : usable;
    const { table: _table, ...rest } = q;
    const result = runQuery(sorted, { ...rest, table: q.table, ...(canWhere ? { where: undefined } : {}) } as Query);
    return { ...result, rows: result.rows.map(stripPaths) };
  }

  async all(name: string, where?: Filter): Promise<Row[]> {
    return (await this.query(where ? { table: name, where } : { table: name })).rows;
  }

  async get(name: string, id: string): Promise<Row | null> {
    const tb = this.table(name);
    const { connection } = this.linkOf(tb);
    if (connection.get) {
      try {
        return await connection.get(name, id);
      } catch (error) {
        if (!(error instanceof PluginError && error.code === 'unsupported')) throw error;
      }
    }
    return (await this.query({ table: name, where: { field: 'id', op: 'eq', value: id }, limit: 1 })).rows[0] ?? null;
  }

  async aggregate(q: AggregateQuery): Promise<Record<string, unknown>[]> {
    const tb = this.table(q.table);
    const { connection, caps } = this.linkOf(tb);
    const paths = q.groupBy.some((g) => g.includes('.')) || q.measures.some((m) => m.field?.includes('.')) || (q.where && containsPath(q.where));
    if (caps.query.aggregate && connection.aggregate && !paths) return (await connection.aggregate(q)).rows;
    const rows = await this.all(q.table, q.where && !containsPath(q.where) ? q.where : undefined);
    const fields = [...q.groupBy, ...q.measures.map((m) => m.field ?? ''), ...(q.where ? filterPaths(q.where) : [])].filter((f) => f.includes('.'));
    const expanded = fields.length ? await this.withPaths(tb, rows, fields) : rows;
    const { table: _t, ...rest } = q;
    return aggregateRows(expanded, rest);
  }

  /** Every record of a table by id — references are resolved through this; reloaded after a write to it. */
  rowsById(name: string): Promise<Map<string, Row>> {
    let cached = this.refCache.get(name);
    if (!cached) {
      cached = this.all(name).then((rows) => new Map(rows.map((r) => [r.id, r])));
      cached.catch(() => this.refCache.delete(name));
      this.refCache.set(name, cached);
    }
    return cached;
  }

  /** The text a reference to `id` in table `name` shows. */
  async label(name: string, id: unknown): Promise<string> {
    if (id === null || id === undefined || id === '') return '';
    const tb = tableOf(this.config, name);
    if (!tb) return String(id);
    const row = (await this.rowsById(name)).get(String(id));
    return row ? this.rowLabel(tb, row) : `<${String(id).slice(0, 8)}…>`;
  }

  rowLabel(tb: TableDef, row: Row): string {
    // The one record of the constants is called by what it is.
    if (tb.name === CONSTANTS) return tb.title;
    if (tb.kind === 'document') {
      const date = typeof row.date === 'string' ? row.date.slice(0, 10).split('-').reverse().join('.') : '';
      return `${tb.itemTitle ?? tb.title} ${String(row.number ?? '')}${date ? ` ${t('data', 'of')} ${date}` : ''}`.trim();
    }
    const v = row[displayField(tb)];
    return v === null || v === undefined || v === '' ? `<${row.id.slice(0, 8)}…>` : String(v);
  }

  /** Loads the referenced tables of every ref field of `tb` that `fields` mention (first segment). */
  async refMaps(tb: TableDef, fields: string[]): Promise<Map<string, Map<string, Row>>> {
    const out = new Map<string, Map<string, Row>>();
    const visit = async (current: TableDef, path: string[]) => {
      const f = fieldOf(current, path[0]!);
      if (!f || f.type !== 'ref' || !f.ref) return;
      const target = tableOf(this.config, f.ref);
      if (!target) return;
      if (!out.has(f.ref)) out.set(f.ref, await this.rowsById(f.ref));
      if (path.length > 2) await visit(target, path.slice(1));
    };
    for (const name of new Set(fields)) await visit(tb, name.split('.'));
    return out;
  }

  /** Rows with 'a.b' path values materialised as flat keys, for client-side filtering and sorting. */
  private async withPaths(tb: TableDef, rows: Row[], paths: string[]): Promise<Row[]> {
    const deep = [...new Set(paths.filter((p) => p.includes('.')))];
    if (!deep.length) return rows;
    const maps = await this.refMaps(tb, deep);
    return rows.map((row) => {
      const copy: Row = { ...row };
      for (const p of deep) copy[p] = this.walk(tb, row, p.split('.'), maps);
      return copy;
    });
  }

  /** The value at a path through references, with the referenced rows already loaded. */
  walk(tb: TableDef, row: Record<string, unknown>, path: string[], maps: Map<string, Map<string, Row>>): unknown {
    let current: TableDef | undefined = tb;
    let value: unknown = row;
    for (let i = 0; i < path.length; i++) {
      if (value === null || value === undefined) return null;
      if (Array.isArray(value)) {
        const rest = path.slice(i);
        const part: TableDef | undefined = current;
        return value.map((item) => (part ? this.walk(part, item as Row, rest, maps) : null));
      }
      const name = path[i]!;
      const f: FieldDef | undefined = current ? fieldOf(current, name) ?? partAsField(current, name) : undefined;
      value = (value as Record<string, unknown>)[name];
      if (i < path.length - 1 && f?.type === 'ref' && f.ref) {
        value = maps.get(f.ref)?.get(String(value)) ?? null;
        current = tableOf(this.config, f.ref);
      } else if (i < path.length - 1 && f && (f as { part?: TableDef }).part) {
        current = (f as { part?: TableDef }).part;
      }
    }
    return value ?? null;
  }

  /* ---------------------------------------------------------------- *
   * Expressions
   * ---------------------------------------------------------------- */

  /**
   * Everything the expressions of `tb` will reach, loaded: referenced tables,
   * registers, tables aggregated over, constants (core/scope.ts). Returns a
   * factory of evaluation environments over one row. `trail` is the tables
   * being computed further up, so a table aggregating itself stops there.
   */
  scope(tb: TableDef, sources: string[], vars: Record<string, unknown> = {}, docTable?: TableDef, trail: string[] = []): Promise<(row: Record<string, unknown>, extra?: Record<string, unknown>) => Env> {
    return buildScope(this, tb, sources, vars, docTable, trail);
  }

  /** Every computed field of `tb` evaluated on each row (in place, returns the rows). */
  async compute<R extends Record<string, unknown>>(tb: TableDef, rows: R[], vars: Record<string, unknown> = {}, trail: string[] = []): Promise<R[]> {
    // Read by an aggregate in its own computation: the fields that aggregate tables are left out, or it would never end.
    const nested = trail.includes(tb.name);
    const wanted = (f: FieldDef) => !!f.computed && !(nested && aggregatesTables(f.computed));
    const computed = allFields(tb).filter(wanted);
    const partComputed = (tb.parts ?? []).map((p) => ({ part: p, fields: p.fields.filter(wanted) })).filter((p) => p.fields.length);
    if (!computed.length && !partComputed.length) return rows;
    const below = nested ? trail : [...trail, tb.name];
    const envOf = await this.scope(tb, computed.map((f) => f.computed!), vars, undefined, below);
    const partEnvs = await Promise.all(partComputed.map(({ part, fields }) => this.scope(partTableOf(tb, part.name), fields.map((f) => f.computed!), vars, tb, below)));
    for (const row of rows) {
      // Lines first: the header's sum(lines.amount) reads them.
      for (const [i, { part, fields }] of partComputed.entries()) {
        const lines = row[part.name];
        if (!Array.isArray(lines)) continue;
        const partEnv = partEnvs[i]!;
        for (const line of lines as Record<string, unknown>[]) {
          for (const f of fields) line[f.name] = safeEval(f.computed!, partEnv(line, { doc: row, docTable: tb }), scaled(f, line));
        }
      }
      const env = envOf(row);
      for (const f of computed) (row as Record<string, unknown>)[f.name] = safeEval(f.computed!, env, scaled(f, row));
    }
    return rows;
  }

  /** A new record with every default evaluated, and the parts that say where their lines come from filled. */
  async newRecord(tb: TableDef, init: Record<string, unknown> = {}, vars: Record<string, unknown> = {}): Promise<Row> {
    const row: Row = { id: '', ...init };
    const fields = allFields(tb).filter((f) => f.default && !(f.name in init));
    const envOf = await this.scope(tb, fields.map((f) => f.default!), vars);
    const env = envOf(row);
    for (const f of fields) row[f.name] = safeEval(f.default!, env, f);
    for (const part of tb.parts ?? []) {
      if (Array.isArray(row[part.name])) continue;
      row[part.name] = part.fill ? await this.fillPart(tb, part.name, row) : [];
    }
    if (tb.kind === 'document' && row.posted === undefined) row.posted = false;
    return row;
  }

  /** A new line of a part with its defaults; `doc` is the document it goes into. */
  async newLine(tb: TableDef, part: string, doc: Row, init: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const partTable = partTableOf(tb, part);
    const line: Record<string, unknown> = { ...init };
    const fields = partTable.fields.filter((f) => f.default && !(f.name in init));
    const envOf = await this.scope(partTable, fields.map((f) => f.default!), {}, tb);
    const env = envOf(line, { doc, docTable: tb });
    for (const f of fields) line[f.name] = safeEval(f.default!, env, f);
    return line;
  }

  /**
   * The lines a part's `fill` gives the record `doc`: one per row of the
   * source the condition lets through, in its order, each with the values of
   * `set` (over the source row, `doc.x` for the record) and the line's own
   * defaults for the rest.
   */
  async fillPart(tb: TableDef, part: string, doc: Row): Promise<Record<string, unknown>[]> {
    const fill = (tb.parts ?? []).find((p) => p.name === part)?.fill;
    if (!fill) return [];
    const src = this.table(fill.from);
    const now = isoDateTime(this.context.now());
    let rows = (await this.all(src.name)).filter((r) => inForce(src, r, now));
    await this.compute(src, rows);
    const sources = [...(fill.where ? [fill.where] : []), ...Object.values(fill.set)];
    const envOf = await this.scope(src, sources, {}, tb);
    const envs = new Map(rows.map((r) => [r, envOf(r, { doc, docTable: tb })]));
    if (fill.where) {
      const where = parseCached(fill.where);
      rows = rows.filter((r) => {
        try {
          return truthy(evaluate(where, envs.get(r)!));
        } catch {
          return false;
        }
      });
    }
    const sort = fill.sort?.length ? fill.sort : src.orderable ? [{ field: '_order' }] : [];
    if (sort.length) rows = runQuery(rows, { table: src.name, orderBy: sort }).rows;
    const lines: Record<string, unknown>[] = [];
    for (const r of rows) {
      const init: Record<string, unknown> = {};
      for (const [name, source] of Object.entries(fill.set)) {
        try {
          init[name] = evaluate(parseCached(source), envs.get(r)!);
        } catch {
          init[name] = null;
        }
      }
      lines.push(await this.newLine(tb, part, doc, init));
    }
    return lines;
  }

  /** Re-evaluates the defaults of a line that depend on `changed` (price ← product.price), only where the line has no value yet or had the old default. */
  async refreshLineDefaults(tb: TableDef, part: string, doc: Row, line: Record<string, unknown>, changed: string): Promise<void> {
    const partTable = partTableOf(tb, part);
    const fields = partTable.fields.filter((f) => f.default && f.default.split(/[^A-Za-z0-9_.]/).some((w) => w === changed || w.startsWith(`${changed}.`)));
    if (!fields.length) return;
    const envOf = await this.scope(partTable, fields.map((f) => f.default!), {}, tb);
    const env = envOf(line, { doc, docTable: tb });
    for (const f of fields) line[f.name] = safeEval(f.default!, env, f);
  }

  /* ---------------------------------------------------------------- *
   * Checking and writing
   * ---------------------------------------------------------------- */

  async validate(tb: TableDef, row: Row): Promise<Problem[]> {
    const problems: Problem[] = [];
    const checkField = (f: FieldDef, value: unknown, at: Omit<Problem, 'message'>) => {
      const title = f.title || f.name;
      const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
      if (f.required && empty && !f.computed) problems.push({ ...at, field: f.name, message: t('data', '“{field}” is required', { field: title }) });
      if (empty) return;
      if ((f.type === 'integer' || f.type === 'decimal') && typeof value !== 'number') problems.push({ ...at, field: f.name, message: t('data', '“{field}” must be a number', { field: title }) });
      if (f.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) problems.push({ ...at, field: f.name, message: t('data', '“{field}” must be a whole number', { field: title }) });
      if (typeof value === 'number' && f.min !== undefined && value < f.min) problems.push({ ...at, field: f.name, message: t('data', '“{field}” must be at least {min}', { field: title, min: f.min }) });
      if (typeof value === 'number' && f.max !== undefined && value > f.max) problems.push({ ...at, field: f.name, message: t('data', '“{field}” must be at most {max}', { field: title, max: f.max }) });
      if (typeof value === 'string' && f.maxLength && value.length > f.maxLength) problems.push({ ...at, field: f.name, message: t('data', '“{field}” is longer than {max} characters', { field: title, max: f.maxLength }) });
      if (typeof value === 'string' && f.pattern) {
        try {
          if (!new RegExp(f.pattern).test(value)) problems.push({ ...at, field: f.name, message: t('data', '“{field}” has a wrong format', { field: title }) });
        } catch {
          // A broken pattern is the configuration's problem, shown by the designer.
        }
      }
      if (f.type === 'email' && typeof value === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) problems.push({ ...at, field: f.name, message: t('data', '“{field}” is not an e-mail address', { field: title }) });
    };
    for (const f of allFields(tb)) if (!f.readonly || f.required) checkField(f, row[f.name], {});
    for (const part of tb.parts ?? []) {
      const lines = Array.isArray(row[part.name]) ? (row[part.name] as Record<string, unknown>[]) : [];
      lines.forEach((line, i) => {
        for (const f of part.fields) checkField(f, line[f.name], { part: part.name, line: i + 1 });
      });
    }
    const unique = allFields(tb).filter((f) => f.unique);
    if (unique.length) {
      const rows = await this.rowsById(tb.name);
      for (const f of unique) {
        const v = row[f.name];
        if (v === null || v === undefined || v === '') continue;
        for (const other of rows.values()) {
          if (other.id !== row.id && other[f.name] === v) {
            problems.push({ field: f.name, message: t('data', '“{field}” must be unique: “{value}” is already used', { field: f.title || f.name, value: String(v) }) });
            break;
          }
        }
      }
    }
    if (tb.validations?.length) {
      const envOf = await this.scope(tb, tb.validations.map((v) => v.when));
      const env = envOf(row);
      for (const v of tb.validations) {
        try {
          if (truthy(evaluate(parseCached(v.when), env))) problems.push({ message: v.message, ...(v.level === 'warning' ? { warning: true } : {}) });
        } catch (error) {
          problems.push({ message: t('data', 'A check of the table failed: {error}', { error: error instanceof Error ? error.message : String(error) }) });
        }
      }
    }
    return problems;
  }

  /** The values a source stores: no computed fields (unless stored), no client-side helpers. */
  storable(tb: TableDef, row: Row): Row {
    const out: Row = { id: row.id };
    if (row._rev !== undefined) out._rev = row._rev;
    const skip = new Set(allFields(tb).filter((f) => f.computed && !f.stored).map((f) => f.name));
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id' || k === '_rev' || skip.has(k) || k.startsWith('__')) continue;
      if (v === undefined) continue;
      out[k] = v;
    }
    for (const part of tb.parts ?? []) {
      const skipPart = new Set(part.fields.filter((f) => f.computed && !f.stored).map((f) => f.name));
      if (Array.isArray(out[part.name])) {
        out[part.name] = (out[part.name] as Record<string, unknown>[]).map((line) => Object.fromEntries(Object.entries(line).filter(([k, v]) => !skipPart.has(k) && !k.startsWith('__') && v !== undefined)));
      }
    }
    return out;
  }

  async nextNumber(tb: TableDef): Promise<string> {
    const numbering = tb.numbering ?? { sequence: tb.name, format: '{000000}' };
    const { connection, caps } = this.linkOf(tb);
    let n: number;
    if (caps.sequences && connection.nextNumber) n = await connection.nextNumber(numbering.sequence);
    else {
      // Best effort without a sequence: one more than the largest number seen.
      const rows = await this.all(tb.name);
      n = rows.reduce((max, r) => Math.max(max, Number(String(r.number ?? '').replace(/\D/g, '')) || 0), 0) + 1;
    }
    return numbering.format.replace(/\{(0+)\}/, (_, zeros: string) => String(n).padStart(zeros.length, '0'));
  }

  /**
   * Checks, numbers, stamps and writes a record; posts a posted document's
   * movements in the same batch when the source has batches. Returns the
   * stored record, computed fields filled.
   */
  async save(tb: TableDef, input: Row, previous: Row | null): Promise<Row> {
    if (!this.writable(tb)) throw new PluginError('forbidden', t('data', '“{table}” is read-only', { table: tb.title }));
    const row: Row = structuredClone(input);
    if (!row.id) row.id = uuid();
    await this.compute(tb, [row]);
    for (const hook of this.hooks) await hook('beforeSave', tb, row, previous);
    // A trigger may have changed what the computed fields depend on.
    if (this.hooks.length) await this.compute(tb, [row]);
    const problems = await this.validate(tb, row);
    const errors = problems.filter((p) => !p.warning);
    if (errors.length) throw new ValidationError(errors);
    await this.checkLock(tb, row, previous);
    const now = isoDateTime(this.context.now());
    const user = this.context.user();
    const before = previous;
    // A versioned record: an edit closes the version in force and opens the next one from now.
    let closing: BatchOp | null = null;
    if (tb.versioned) {
      if (!previous) {
        row.seriesId ||= row.id;
        row.validFrom ||= now;
        row.validTo ??= null;
      } else {
        if (previous.validTo) throw new ValidationError([{ message: t('data', 'This version is closed: it is history and cannot be changed') }]);
        if (String(previous.validFrom ?? '') < now && this.differs(tb, row, previous)) {
          closing = { op: 'update', table: tb.name, id: previous.id, patch: { validTo: now }, ...(previous._rev ? { expectedRev: previous._rev } : {}) };
          row.id = uuid();
          row.seriesId = previous.seriesId || previous.id;
          row.validFrom = now;
          row.validTo = null;
          delete row._rev;
          previous = null;
        }
      }
    }
    if (!previous) {
      row._createdAt = now;
      row._createdBy = user;
    }
    // A record of an ordered table comes last until moved.
    if (tb.orderable && typeof row._order !== 'number') row._order = [...(await this.rowsById(tb.name)).values()].reduce((max, r) => Math.max(max, Number(r._order) || 0), 0) + 1;
    row._updatedAt = now;
    row._updatedBy = user;
    // Movements first: a document that cannot be posted (not enough in stock) must not use up a number.
    const movements = tb.posting?.length && this.poster ? await this.poster(tb, row) : [];
    if (tb.kind === 'document' && !row.number) row.number = await this.nextNumber(tb);
    const { connection, caps } = this.linkOf(tb);
    const stored = this.storable(tb, row);
    let saved: Row;
    const first = closing ? [closing] : [];
    if ((movements.length || closing) && caps.batch && connection.batch) {
      const write: BatchOp = previous
        ? { op: 'update', table: tb.name, id: row.id, patch: stored, ...(previous._rev ? { expectedRev: previous._rev } : {}) }
        : { op: 'insert', table: tb.name, row: stored };
      const result = await connection.batch([...first, write, ...movements]);
      saved = result.results[first.length] as Row;
      this.changed([tb.name, ...new Set(movements.map((m) => m.table))]);
    } else {
      if (closing) await this.applyOps(connection, [closing]);
      if (previous) saved = await connection.update!(tb.name, row.id, stored, previous._rev);
      else saved = await connection.insert!(tb.name, stored);
      if (movements.length) await this.applyOps(connection, movements);
      this.changed([tb.name, ...new Set(movements.map((m) => m.table))]);
    }
    await this.after('afterSave', tb, saved, before);
    await this.compute(tb, [saved]);
    const warnings = problems.filter((p) => p.warning);
    if (warnings.length) this.onNotice?.(warnings.map((p) => p.message));
    return saved;
  }

  /** Whether an edit changes what a version holds (not who saved it when). */
  private differs(tb: TableDef, row: Row, previous: Row): boolean {
    const skip = new Set(['_rev', '_createdAt', '_createdBy', '_updatedAt', '_updatedBy', 'seriesId', 'validFrom', 'validTo']);
    const content = (r: Row) => JSON.stringify(Object.entries(this.storable(tb, r)).filter(([k]) => !skip.has(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return content(row) !== content(previous);
  }

  /**
   * The movements of a register in (from, to]: those stored, and the planned
   * ones its scheduled sources make (core/planned.ts) — up to now when no
   * end is given. A register no schedule posts into is what is stored.
   */
  async movements(register: string, to: string | null = null, from: string | null = null): Promise<Row[]> {
    const stored = await this.all(register);
    if (!scheduledRules(this.config.tables, register).length) return stored;
    const plans = await planSources(this, register);
    return [...stored, ...expand(plans, from, to ?? isoDateTime(this.context.now()))];
  }

  /** Runs a plugin's report (core/reports.ts); set by the page, which runs the plugins. */
  pluginReport: ((plugin: string, report: string, params: Record<string, unknown>) => Promise<PluginReportResult>) | null = null;

  /** Told about the warnings of a record that was saved all the same. */
  onNotice: ((messages: string[]) => void) | null = null;

  /** Whether the record is in its table's closed period (`lockedWhen`). */
  async locked(tb: TableDef, row: Row): Promise<boolean> {
    if (!tb.lockedWhen) return false;
    const envOf = await this.scope(tb, [tb.lockedWhen]);
    try {
      return truthy(evaluate(parseCached(tb.lockedWhen), envOf(row)));
    } catch {
      return false;
    }
  }

  /**
   * A closed period: nothing posted in it changes, and nothing is posted into
   * it. A record that moves no register there is free — kept as a note.
   */
  private async checkLock(tb: TableDef, row: Row | null, previous: Row | null): Promise<void> {
    if (!tb.lockedWhen || !tb.posting?.length) return;
    const message = tb.lockedMessage || t('data', 'The record is in a closed period: it cannot be posted, and what is posted there cannot be changed');
    const moves = (r: Row) => (tb.kind === 'document' ? r.posted === true : true);
    if (previous && moves(previous) && (await this.locked(tb, previous))) {
      // Saving it unchanged (a trigger touching an unrelated field aside) is the only thing allowed.
      const same = row !== null && JSON.stringify(this.storable(tb, { ...row, _rev: undefined, _updatedAt: undefined, _updatedBy: undefined } as Row)) === JSON.stringify(this.storable(tb, { ...previous, _rev: undefined, _updatedAt: undefined, _updatedBy: undefined } as Row));
      if (!same) throw new ValidationError([{ message }]);
    }
    if (row && moves(row) && (await this.locked(tb, row))) {
      if (!previous || !moves(previous) || !(await this.locked(tb, previous))) throw new ValidationError([{ message }]);
    }
  }

  /** Without batches, one by one — not atomic, as Task.md 9.5 says. */
  private async applyOps(connection: Connection, ops: BatchOp[]): Promise<void> {
    for (const op of ops) {
      if (op.op === 'insert') await connection.insert!(op.table, op.row);
      else if (op.op === 'update') await connection.update!(op.table, op.id, op.patch, op.expectedRev);
      else if (op.op === 'delete') await connection.delete!(op.table, op.id, op.expectedRev);
      else for (const r of (await connection.query({ table: op.table, where: op.where })).rows) await connection.delete!(op.table, r.id);
    }
  }

  async remove(tb: TableDef, row: Row): Promise<void> {
    if (!this.writable(tb)) throw new PluginError('forbidden', t('data', '“{table}” is read-only', { table: tb.title }));
    await this.checkLock(tb, null, row);
    for (const hook of this.hooks) await hook('beforeDelete', tb, row, row);
    const { connection, caps } = this.linkOf(tb);
    // A version in force since before now is closed, not deleted: what it planned until now stays.
    const now = isoDateTime(this.context.now());
    if (tb.versioned && !row.validTo && String(row.validFrom ?? '') < now) {
      await connection.update!(tb.name, row.id, { validTo: now }, row._rev);
      this.changed([tb.name]);
      await this.after('afterDelete', tb, row, row);
      return;
    }
    const registers = [...new Set((tb.posting ?? []).map((p) => p.register))];
    if (registers.length && caps.batch && connection.batch) {
      await connection.batch([
        { op: 'delete', table: tb.name, id: row.id, ...(row._rev ? { expectedRev: row._rev } : {}) },
        ...registers.map((r): BatchOp => ({ op: 'deleteWhere', table: r, where: { field: 'recorder', op: 'eq', value: row.id } })),
      ]);
    } else {
      await connection.delete!(tb.name, row.id, row._rev);
      for (const r of registers) await this.applyOps(connection, [{ op: 'deleteWhere', table: r, where: { field: 'recorder', op: 'eq', value: row.id } }]);
    }
    this.changed([tb.name, ...registers]);
    await this.after('afterDelete', tb, row, row);
  }

  /** Told about what failed after a write had already landed (an afterSave trigger). */
  onWarning: ((error: unknown) => void) | null = null;

  /**
   * The write is done when these run: their failure must not make the caller
   * think it was not — a retry would save the record a second time.
   */
  private async after(event: 'afterSave' | 'afterDelete', tb: TableDef, row: Row, previous: Row | null): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook(event, tb, row, previous);
      } catch (error) {
        if (this.onWarning) this.onWarning(error);
        else console.warn(error);
      }
    }
  }

  /** Writes ops to the connection of their first table, as a batch when it can. */
  async writeBatch(ops: BatchOp[]): Promise<void> {
    if (!ops.length) return;
    const tb = this.table(ops[0]!.table);
    const { connection, caps } = this.linkOf(tb);
    if (caps.batch && connection.batch) await connection.batch(ops);
    else await this.applyOps(connection, ops);
    this.changed([...new Set(ops.map((o) => o.table))]);
  }
}

/** A part's fields seen as a table, so expressions over lines resolve their references. */
export function partTableOf(tb: TableDef, part: string): TableDef {
  const p = (tb.parts ?? []).find((x) => x.name === part);
  return { key: `${tb.key}.${p?.key ?? part}`, name: `${tb.name}.${part}`, kind: 'table', title: p?.title ?? part, fields: p?.fields ?? [] };
}

function partAsField(tb: TableDef, name: string): (FieldDef & { part: TableDef }) | undefined {
  const p = (tb.parts ?? []).find((x) => x.name === name);
  return p ? { key: p.key, name: p.name, type: 'json', part: partTableOf(tb, name) } : undefined;
}

export function truthy(v: unknown): boolean {
  return !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));
}

/** A computed value; an expression that fails yields null rather than breaking the whole list. */
function safeEval(source: string, env: Env, f: FieldDef): unknown {
  try {
    const v = evaluate(parseCached(source), env);
    if (f.type === 'decimal' && typeof v === 'number') return Number(v.toFixed(f.scale ?? 2));
    if (f.type === 'integer' && typeof v === 'number') return Math.round(v);
    return v;
  } catch {
    return null;
  }
}

function containsPath(filter: Filter): boolean {
  return filterPaths(filter).some((p) => p.includes('.'));
}

function filterPaths(filter: Filter): string[] {
  if ('and' in filter) return filter.and.flatMap(filterPaths);
  if ('or' in filter) return filter.or.flatMap(filterPaths);
  if ('not' in filter) return filterPaths(filter.not);
  return [filter.field];
}

function stripPaths(row: Row): Row {
  let out: Row | null = null;
  for (const k of Object.keys(row)) {
    if (k.includes('.')) {
      out ??= { ...row };
      delete out[k];
    }
  }
  return out ?? row;
}
