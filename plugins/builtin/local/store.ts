/**
 * A complete data source over a dumb key-value adapter: revisions, conflicts,
 * all-or-nothing batches, sequences, the configuration, schema changes — and
 * queries, run by the core's own engine, so a source built on this behaves to
 * the letter like the core's client-side fallback.
 *
 * Two adapters use it: IndexedDB (the `local` plugin, in the browser) and
 * memory (tests in Node, and the `json-file` plugin, which saves the memory to
 * a file).
 */
import { uuid } from '../../../src/core/ids';
import { aggregate, runQuery } from '../../../src/core/query/index';
import type { AggregateQuery, Query, QueryResult, Row } from '../../../src/core/query/types';
import {
  PluginError,
  type BatchOp,
  type BatchResult,
  type Capabilities,
  type Connection,
  type SchemaChange,
} from '../../../src/core/plugin-protocol';

export interface Tx {
  all(table: string): Promise<Row[]>;
  get(table: string, id: string): Promise<Row | undefined>;
  put(table: string, row: Row): Promise<void>;
  remove(table: string, id: string): Promise<void>;
  tables(): Promise<string[]>;
  meta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export interface Adapter {
  /** Runs `work` in one transaction: all its writes land, or none. */
  transact<T>(write: boolean, work: (tx: Tx) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

const nextRev = (rev: unknown) => String((Number(rev) || 0) + 1);

/** Rows are copied in and out: the caller may not change what the store holds. */
const copy = <T>(value: T): T => structuredClone(value);

export class Store implements Connection {
  /** Rows per table as last read; dropped for a table on every write to it. */
  private cache = new Map<string, Row[]>();
  constructor(
    private readonly adapter: Adapter,
    private readonly onWrite?: (tables: string[]) => void,
  ) {}

  capabilities(): Capabilities {
    return {
      write: true,
      schema: 'managed',
      query: { where: true, orderBy: true, paging: true, count: true, aggregate: true },
      batch: true,
      config: true,
      files: false,
      sequences: true,
      changes: false,
    };
  }

  /** Another tab wrote: forget what was read. */
  invalidate(tables?: string[]): void {
    if (!tables) this.cache.clear();
    else for (const t of tables) this.cache.delete(t);
  }

  private async rows(table: string): Promise<Row[]> {
    let rows = this.cache.get(table);
    if (!rows) {
      rows = await this.adapter.transact(false, (tx) => tx.all(table));
      this.cache.set(table, rows);
    }
    return rows;
  }

  async query(q: Query): Promise<QueryResult> {
    return copy(runQuery(await this.rows(q.table), q));
  }

  async aggregate(q: AggregateQuery): Promise<{ rows: Record<string, unknown>[] }> {
    return { rows: copy(aggregate(await this.rows(q.table), q)) };
  }

  async get(table: string, id: string): Promise<Row | null> {
    const row = (await this.rows(table)).find((r) => r.id === id);
    return row ? copy(row) : null;
  }

  insert(table: string, row: Row): Promise<Row> {
    return this.batch([{ op: 'insert', table, row }]).then((r) => r.results[0] as Row);
  }

  update(table: string, id: string, patch: Record<string, unknown>, expectedRev?: string): Promise<Row> {
    return this.batch([expectedRev === undefined ? { op: 'update', table, id, patch } : { op: 'update', table, id, patch, expectedRev }]).then((r) => r.results[0] as Row);
  }

  async delete(table: string, id: string, expectedRev?: string): Promise<void> {
    await this.batch([expectedRev === undefined ? { op: 'delete', table, id } : { op: 'delete', table, id, expectedRev }]);
  }

  async batch(ops: BatchOp[]): Promise<BatchResult> {
    const touched = new Set<string>();
    const results = await this.adapter.transact(true, async (tx) => {
      const out: (Row | null)[] = [];
      for (const op of ops) {
        touched.add(op.table);
        if (op.op === 'insert') {
          const row = copy(op.row);
          if (!row.id) row.id = uuid();
          if (await tx.get(op.table, row.id)) throw new PluginError('conflict', `${op.table}: a record with id ${row.id} already exists`, { table: op.table, id: row.id });
          row._rev = '1';
          await tx.put(op.table, row);
          out.push(row);
        } else if (op.op === 'update') {
          const current = await tx.get(op.table, op.id);
          if (!current) throw new PluginError('not_found', `${op.table}: no record ${op.id}`, { table: op.table, id: op.id });
          if (op.expectedRev !== undefined && current._rev !== op.expectedRev) {
            throw new PluginError('conflict', `${op.table}: the record was changed by someone else`, { table: op.table, id: op.id, rev: current._rev });
          }
          const { id: _id, _rev: _r, ...patch } = op.patch as Row;
          const row = { ...current, ...copy(patch), id: op.id, _rev: nextRev(current._rev) } as Row;
          await tx.put(op.table, row);
          out.push(row);
        } else if (op.op === 'delete') {
          const current = await tx.get(op.table, op.id);
          if (!current) throw new PluginError('not_found', `${op.table}: no record ${op.id}`, { table: op.table, id: op.id });
          if (op.expectedRev !== undefined && current._rev !== op.expectedRev) {
            throw new PluginError('conflict', `${op.table}: the record was changed by someone else`, { table: op.table, id: op.id, rev: current._rev });
          }
          await tx.remove(op.table, op.id);
          out.push(null);
        } else {
          const doomed = runQuery(await tx.all(op.table), { table: op.table, where: op.where }).rows;
          for (const row of doomed) await tx.remove(op.table, row.id);
          out.push(null);
        }
      }
      return out;
    });
    const tables = [...touched];
    this.invalidate(tables);
    this.onWrite?.(tables);
    return { results: copy(results) };
  }

  nextNumber(sequence: string): Promise<number> {
    return this.adapter.transact(true, async (tx) => {
      const n = (Number(await tx.meta(`seq:${sequence}`)) || 0) + 1;
      await tx.setMeta(`seq:${sequence}`, n);
      return n;
    });
  }

  async loadConfig(): Promise<{ doc: unknown; rev: string } | null> {
    const stored = (await this.adapter.transact(false, (tx) => tx.meta('config'))) as { doc: unknown; rev: string } | undefined;
    return stored ? copy(stored) : null;
  }

  saveConfig(doc: unknown, expectedRev: string | null): Promise<{ rev: string }> {
    return this.adapter.transact(true, async (tx) => {
      const stored = (await tx.meta('config')) as { rev: string } | undefined;
      if (expectedRev !== null && stored && stored.rev !== expectedRev) {
        throw new PluginError('conflict', 'The configuration was changed elsewhere', { rev: stored.rev });
      }
      const rev = nextRev(stored?.rev);
      await tx.setMeta('config', { doc: copy(doc), rev });
      return { rev };
    });
  }

  async applySchema(changes: SchemaChange[]): Promise<void> {
    await this.adapter.transact(true, async (tx) => {
      for (const change of changes) {
        if (change.op === 'renameTable') {
          for (const row of await tx.all(change.from)) {
            await tx.put(change.to, row);
            await tx.remove(change.from, row.id);
          }
        } else if (change.op === 'dropTable') {
          for (const row of await tx.all(change.table)) await tx.remove(change.table, row.id);
        } else if (change.op === 'renameField' || change.op === 'dropField') {
          for (const row of await tx.all(change.table)) {
            const field = change.op === 'renameField' ? change.from : change.field;
            if (!Object.hasOwn(row, field)) continue;
            const next: Row = { ...row };
            if (change.op === 'renameField') next[change.to] = next[field];
            delete next[field];
            await tx.put(change.table, next);
          }
        }
        // createTable, addField and changeType need nothing: rows are schemaless here.
      }
    });
    this.invalidate();
  }

  async close(): Promise<void> {
    this.cache.clear();
    await this.adapter.close?.();
  }
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

export interface MemoryState {
  tables: Record<string, Record<string, Row>>;
  meta: Record<string, unknown>;
}

/**
 * Writes go to copies of the tables they touch, swapped in when the
 * transaction's work resolves; a throw leaves the state as it was.
 */
export function memoryAdapter(state: MemoryState = { tables: {}, meta: {} }, onCommit?: (state: MemoryState) => void | Promise<void>): Adapter & { state: MemoryState } {
  // One transaction at a time: each works on copies and swaps them in, so two overlapping ones
  // would each keep only their own writes (and both pass the same _rev check).
  let queue: Promise<unknown> = Promise.resolve();
  const adapter = {
    state,
    transact<T>(write: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
      const run = queue.then(() => adapter.run(write, work));
      queue = run.catch(() => undefined);
      return run;
    },
    async run<T>(write: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
      const staged = new Map<string, Record<string, Row>>();
      const meta = { ...adapter.state.meta };
      const read = (table: string) => staged.get(table) ?? adapter.state.tables[table] ?? {};
      const writable = (table: string) => {
        let rows = staged.get(table);
        if (!rows) {
          rows = { ...(adapter.state.tables[table] ?? {}) };
          staged.set(table, rows);
        }
        return rows;
      };
      const tx: Tx = {
        all: async (table) => Object.values(read(table)),
        get: async (table, id) => read(table)[id],
        put: async (table, row) => {
          if (!write) throw new Error('read-only transaction');
          writable(table)[row.id] = row;
        },
        remove: async (table, id) => {
          if (!write) throw new Error('read-only transaction');
          delete writable(table)[id];
        },
        tables: async () => [...new Set([...Object.keys(adapter.state.tables), ...staged.keys()])],
        meta: async (key) => meta[key],
        setMeta: async (key, value) => {
          meta[key] = value;
        },
      };
      const result = await work(tx);
      if (write) {
        const tables = { ...adapter.state.tables };
        for (const [name, rows] of staged) {
          if (Object.keys(rows).length) tables[name] = rows;
          else delete tables[name];
        }
        adapter.state = { tables, meta };
        await onCommit?.(adapter.state);
      }
      return result;
    },
  };
  return adapter;
}
