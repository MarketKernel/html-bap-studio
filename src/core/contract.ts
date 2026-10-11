/**
 * The data source contract check (Task.md 5.7): the scenarios any source must
 * pass, run against a live connection. The same code runs in Node
 * (tests/contract.mjs) and in the browser, from the plugin manager — that is
 * how the author of a plugin checks it.
 *
 * It works in a scratch table of its own and removes it at the end. The
 * configuration is touched only with `config: true` (a scratch database):
 * on a real source it would replace the application.
 */
import { normalizeCapabilities, PluginError, type Capabilities, type Connection } from './plugin-protocol';
import type { Filter, Row } from './query/types';

export interface ContractLine {
  name: string;
  ok: boolean;
  skipped?: boolean;
  message?: string;
}

export interface ContractReport {
  passed: number;
  failed: number;
  skipped: number;
  lines: ContractLine[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function runContract(conn: Connection, report: (line: ContractLine) => void = () => {}, opts: { config?: boolean } = {}): Promise<ContractReport> {
  const lines: ContractLine[] = [];
  const add = (line: ContractLine) => {
    lines.push(line);
    report(line);
  };
  const check = async (name: string, run: () => Promise<void | string>, skip?: string | false) => {
    if (skip) return add({ name, ok: true, skipped: true, message: skip });
    try {
      const problem = await run();
      add(problem ? { name, ok: false, message: problem } : { name, ok: true });
    } catch (error) {
      add({ name, ok: false, message: error instanceof Error ? `${(error as PluginError).code ?? error.name}: ${error.message}` : String(error) });
    }
  };
  let caps: Capabilities = normalizeCapabilities(null);
  await check('capabilities() answers', async () => {
    caps = normalizeCapabilities(await conn.capabilities());
  });
  const table = `contract_${Date.now().toString(36)}`;
  const noWrite = !caps.write && 'read-only source';
  if (caps.schema === 'managed' && conn.applySchema) {
    await check('applySchema(createTable)', async () => {
      await conn.applySchema!([{ op: 'createTable', table }, { op: 'addField', table, field: 'name', type: 'string' }]);
    });
  }
  let first: Row | null = null;
  await check(
    'insert() returns the row with id and _rev',
    async () => {
      first = await conn.insert!(table, { id: '', name: 'Ёлка “tree” 🌲', qty: 1.5, active: true, note: null, day: '2026-10-08' } as Row);
      if (!first?.id) return 'no id';
      if (!first._rev) return 'no _rev';
      if (first.name !== 'Ёлка “tree” 🌲') return `text changed: ${String(first.name)}`;
    },
    noWrite,
  );
  await check(
    'get() returns the same values (types survive)',
    async () => {
      if (!first) return 'nothing inserted';
      const got = conn.get ? await conn.get(table, first.id) : (await conn.query({ table, where: { field: 'id', op: 'eq', value: first.id } })).rows[0];
      if (!got) return 'not found';
      for (const k of ['name', 'qty', 'active', 'day']) if (!same(got[k], (first as Row)[k])) return `${k}: ${JSON.stringify(got[k])} ≠ ${JSON.stringify((first as Row)[k])}`;
      if (got.note !== null && got.note !== undefined) return 'null came back as a value';
    },
    noWrite,
  );
  await check(
    'update() with the right _rev changes the record and its _rev',
    async () => {
      if (!first) return 'nothing inserted';
      const updated = await conn.update!(table, first.id, { qty: 2 }, first._rev);
      if (updated.qty !== 2) return 'qty not changed';
      if (updated.name !== (first as Row).name) return 'other fields lost';
      if (updated._rev === (first as Row)._rev) return '_rev did not change';
      first = updated;
    },
    noWrite,
  );
  await check(
    'update() with a stale _rev fails with "conflict"',
    async () => {
      if (!first) return 'nothing inserted';
      try {
        await conn.update!(table, first.id, { qty: 3 }, 'stale-rev');
        return 'no error';
      } catch (error) {
        if ((error as PluginError).code !== 'conflict') return `code ${(error as PluginError).code}, not conflict`;
      }
    },
    noWrite,
  );
  await check(
    'delete() with a stale _rev fails with "conflict"',
    async () => {
      if (!first) return 'nothing inserted';
      try {
        await conn.delete!(table, first.id, 'stale-rev');
        return 'no error';
      } catch (error) {
        if ((error as PluginError).code !== 'conflict') return `code ${(error as PluginError).code}, not conflict`;
      }
    },
    noWrite,
  );
  await check(
    'delete() removes the record',
    async () => {
      if (!first) return 'nothing inserted';
      await conn.delete!(table, first.id, first._rev);
      const left = (await conn.query({ table, where: { field: 'id', op: 'eq', value: first.id } })).rows;
      if (left.length) return 'still there';
    },
    noWrite,
  );
  // Twenty rows for queries.
  const names = ['apple', 'Banana', 'cherry', 'date', 'Elder', 'fig', 'grape', 'Honeydew', 'iris', 'jam', 'kiwi', 'Lemon', 'mango', 'nectar', 'olive', 'pear', 'quince', 'raisin', 'Sloe', 'tomato'];
  let seeded = false;
  await check(
    'insert() of 20 rows',
    async () => {
      const rows = names.map((name, i) => ({ id: `r${String(i).padStart(2, '0')}`, name, n: i, even: i % 2 === 0, group: i < 10 ? 'a' : 'b', when: `2026-01-${String(i + 1).padStart(2, '0')}`, maybe: i % 5 === 0 ? null : i }));
      if (caps.batch && conn.batch) await conn.batch(rows.map((row) => ({ op: 'insert' as const, table, row: row as Row })));
      else for (const row of rows) await conn.insert!(table, row as Row);
      seeded = true;
    },
    noWrite,
  );
  const q = async (where: Filter) => (await conn.query({ table, where, orderBy: [{ field: 'n' }] })).rows.map((r) => r.n);
  const noWhere = (!caps.query.where && 'the core filters for this source') || (!seeded && 'no rows');
  const filters: [string, Filter, number[]][] = [
    ['eq', { field: 'name', op: 'eq', value: 'fig' }, [5]],
    ['ne', { field: 'group', op: 'ne', value: 'a' }, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]],
    ['lt / ge', { and: [{ field: 'n', op: 'ge', value: 3 }, { field: 'n', op: 'lt', value: 6 }] }, [3, 4, 5]],
    ['in', { field: 'name', op: 'in', value: ['kiwi', 'olive', 'none'] }, [10, 14]],
    ['contains is case-insensitive', { field: 'name', op: 'contains', value: 'AN' }, [1, 12]],
    ['startsWith', { field: 'name', op: 'startsWith', value: 'l' }, [11]],
    ['between dates', { field: 'when', op: 'between', value: ['2026-01-18', '2026-01-20'] }, [17, 18, 19]],
    ['isNull', { field: 'maybe', op: 'isNull' }, [0, 5, 10, 15]],
    ['or / not', { or: [{ field: 'n', op: 'eq', value: 1 }, { not: { field: 'n', op: 'lt', value: 19 } }] }, [1, 19]],
    ['boolean eq', { and: [{ field: 'even', op: 'eq', value: true }, { field: 'n', op: 'lt', value: 5 }] }, [0, 2, 4]],
  ];
  for (const [name, where, expected] of filters) {
    await check(`query: ${name}`, async () => {
      const got = await q(where);
      if (!same(got, expected)) return `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`;
    }, noWhere);
  }
  const noSort = (!caps.query.orderBy && 'the core sorts for this source') || (!seeded && 'no rows');
  await check('query: orderBy desc', async () => {
    const got = (await conn.query({ table, orderBy: [{ field: 'n', desc: true }], ...(caps.query.paging ? { limit: 3 } : {}) })).rows.slice(0, 3).map((r) => r.n);
    if (!same(got, [19, 18, 17])) return `got ${JSON.stringify(got)}`;
  }, noSort);
  await check('query: orderBy two keys', async () => {
    const got = (await conn.query({ table, orderBy: [{ field: 'group', desc: true }, { field: 'n' }] })).rows.map((r) => r.n).slice(0, 2);
    if (!same(got, [10, 11])) return `got ${JSON.stringify(got)}`;
  }, noSort);
  await check('query: limit, offset and total', async () => {
    const r = await conn.query({ table, orderBy: [{ field: 'n' }], limit: 5, offset: 5, count: true });
    if (!same(r.rows.map((x) => x.n), [5, 6, 7, 8, 9])) return `rows ${JSON.stringify(r.rows.map((x) => x.n))}`;
    if (caps.query.count && r.total !== 20) return `total ${String(r.total)}`;
  }, (!caps.query.paging && 'the core pages for this source') || (!seeded && 'no rows'));
  await check('aggregate(): sum and count by group', async () => {
    const r = await conn.aggregate!({ table, groupBy: ['group'], measures: [{ name: 'total', fn: 'sum', field: 'n' }, { name: 'rows', fn: 'count' }], orderBy: [{ field: 'group' }] });
    if (!same(r.rows.map((x) => [x.group, x.total, x.rows]), [['a', 45, 10], ['b', 145, 10]])) return JSON.stringify(r.rows);
  }, (!caps.query.aggregate && 'the core aggregates for this source') || (!seeded && 'no rows'));
  await check('batch(): all or nothing', async () => {
    try {
      await conn.batch!([
        { op: 'insert', table, row: { id: 'batch-1', name: 'should vanish', n: 100 } },
        { op: 'update', table, id: 'r00', patch: { n: -1 }, expectedRev: 'stale-rev' },
      ]);
      return 'the batch with a stale _rev succeeded';
    } catch (error) {
      if ((error as PluginError).code !== 'conflict') return `code ${(error as PluginError).code}`;
    }
    const left = (await conn.query({ table, where: { field: 'id', op: 'eq', value: 'batch-1' } })).rows;
    if (left.length) return 'the first operation stayed';
  }, (!caps.batch && 'no batches') || noWrite || (!seeded && 'no rows'));
  await check('batch(): deleteWhere', async () => {
    await conn.batch!([{ op: 'deleteWhere', table, where: { field: 'group', op: 'eq', value: 'b' } }]);
    const left = (await conn.query({ table })).rows.length;
    if (left !== 10) return `${left} rows left, expected 10`;
  }, (!caps.batch && 'no batches') || noWrite || (!seeded && 'no rows'));
  await check('nextNumber() counts up', async () => {
    const seq = `${table}_seq`;
    const a = await conn.nextNumber!(seq);
    const b = await conn.nextNumber!(seq);
    if (b !== a + 1) return `${a} then ${b}`;
  }, !caps.sequences && 'no sequences');
  await check('saveConfig() / loadConfig() with revisions', async () => {
    const before = await conn.loadConfig!();
    const { rev } = await conn.saveConfig!({ app: { name: 'contract' } }, before?.rev ?? null);
    const after = await conn.loadConfig!();
    if (!after || after.rev !== rev) return 'revision not kept';
    try {
      await conn.saveConfig!({ app: { name: 'stale' } }, 'stale-rev');
      return 'a stale revision was accepted';
    } catch (error) {
      if ((error as PluginError).code !== 'conflict') return `code ${(error as PluginError).code}`;
    }
  }, (!caps.config && 'does not keep configurations') || (!opts.config && 'skipped on a live source'));
  await check('1000 rows round-trip', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ op: 'insert' as const, table, row: { id: `big${i}`, n: i, name: `Row ${i}` } as Row }));
    if (caps.batch && conn.batch) await conn.batch(big);
    else for (const op of big) await conn.insert!(table, op.row);
    const all = (await conn.query({ table, where: { field: 'name', op: 'startsWith', value: 'Row ' } })).rows;
    const count = caps.query.where ? all.length : all.filter((r) => String(r.name).startsWith('Row ')).length;
    if (count !== 1000) return `${count} rows`;
  }, noWrite);
  // Cleanup.
  if (caps.write) {
    try {
      if (caps.schema === 'managed' && conn.applySchema) await conn.applySchema([{ op: 'dropTable', table }]);
      else for (const r of (await conn.query({ table })).rows) await conn.delete?.(table, r.id, r._rev);
    } catch {
      // A source that cannot drop tables keeps a scratch table: harmless.
    }
  }
  const passed = lines.filter((l) => l.ok && !l.skipped).length;
  const skipped = lines.filter((l) => l.skipped).length;
  return { passed, failed: lines.length - passed - skipped, skipped, lines };
}
