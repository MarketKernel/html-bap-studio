/**
 * Posting into accumulation registers (Task.md 10).
 *
 * A posted document's movements are recomputed on every save: the old ones
 * are deleted and the new ones written in the same batch as the document
 * itself, so a document and its movements never disagree. An unposted
 * document has none. A catalog or a plain table with posting rules has the
 * movements of every record — an account's opening balance, say.
 *
 * Movements carry `recorder` (the record's id), `date` and `direction`; the
 * register's dimensions and resources come from the rule's expressions,
 * evaluated over each line (or the header), with `doc.x` for the record. A
 * rule with `when` makes movements only where it holds: an income goes in, an
 * expense out, a transfer both, from one document.
 */
import { t } from './i18n';
import type { PostingRule, TableDef } from './config/types';
import { table as tableOf } from './config/model';
import { DataService, parseCached, partTableOf, truthy, ValidationError, type Problem } from './data';
import { evaluate } from './expr/index';
import type { BatchOp } from './plugin-protocol';
import type { Row } from './query/types';
import { uuid } from './ids';

export function installPosting(data: DataService): void {
  data.poster = (tb, row) => movementsFor(data, tb, row);
}

export async function movementsFor(data: DataService, tb: TableDef, row: Row): Promise<BatchOp[]> {
  // Movements from a schedule are planned, never stored (core/planned.ts).
  const rules = (tb.posting ?? []).filter((r) => r.from !== 'schedule');
  if (!rules.length) return [];
  const registers = [...new Set(rules.map((r) => r.register))];
  const ops: BatchOp[] = registers.map((register) => ({ op: 'deleteWhere', table: register, where: { field: 'recorder', op: 'eq', value: row.id } }));
  if (!isPosted(tb, row)) return ops;
  if (!row.id) row.id = uuid();
  const created = new Map<string, Row[]>();
  for (const rule of rules) {
    const register = tableOf(data.config, rule.register);
    if (!register) continue;
    for (const movement of await movementsOfRule(data, tb, row, rule)) {
      created.set(register.name, [...(created.get(register.name) ?? []), movement]);
      ops.push({ op: 'insert', table: register.name, row: movement });
    }
  }
  await checkNegative(data, row, created);
  return ops;
}

/** A document moves registers once posted; a record of any other kind always does. */
export function isPosted(tb: TableDef, row: Row): boolean {
  return tb.kind === 'document' ? row.posted === true : !!tb.posting?.length;
}

async function movementsOfRule(data: DataService, tb: TableDef, row: Row, rule: PostingRule): Promise<Row[]> {
  const fromLines = rule.from !== 'header';
  const source = fromLines ? partTableOf(tb, rule.from) : tb;
  const items: Record<string, unknown>[] = fromLines ? (Array.isArray(row[rule.from]) ? (row[rule.from] as Record<string, unknown>[]) : []) : [row];
  const extra = [rule.when, rule.date].filter((x): x is string => !!x);
  const envOf = await data.scope(source, [...Object.values(rule.set), ...extra], {}, fromLines ? tb : undefined);
  const fail = (what: string, error: unknown) =>
    new ValidationError([{ message: t('registers', 'Posting rule for “{register}”, field “{field}”: {error}', { register: rule.register, field: what, error: error instanceof Error ? error.message : String(error) }) }]);
  const out: Row[] = [];
  for (const item of items) {
    const env = envOf(item, { doc: row, docTable: tb });
    if (rule.when) {
      let ok: unknown;
      try {
        ok = evaluate(parseCached(rule.when), env);
      } catch (error) {
        throw fail('when', error);
      }
      if (!truthy(ok)) continue;
    }
    let date: unknown = row.date ?? row._createdAt ?? null;
    if (rule.date) {
      try {
        date = evaluate(parseCached(rule.date), env);
      } catch (error) {
        throw fail('date', error);
      }
    }
    const movement: Row = { id: uuid(), recorder: row.id, date: date ?? null, direction: rule.direction };
    for (const [target, expr] of Object.entries(rule.set)) {
      try {
        movement[target] = evaluate(parseCached(expr), env);
      } catch (error) {
        throw fail(target, error);
      }
    }
    out.push(movement);
  }
  return out;
}

/**
 * The register's balances after this document replaces its old movements may
 * not go below zero for the resources the register guards — on the
 * document's date and after it.
 */
async function checkNegative(data: DataService, row: Row, created: Map<string, Row[]>): Promise<void> {
  const problems: Problem[] = [];
  for (const [name, mine] of created) {
    const register = tableOf(data.config, name);
    if (!register?.denyNegative?.length) continue;
    const dims = register.fields.filter((f) => f.role === 'dimension').map((f) => f.name);
    const others = [...(await data.rowsById(name)).values()].filter((m) => m.recorder !== row.id);
    const all = [...others, ...mine];
    const keyOf = (m: Row) => JSON.stringify(dims.map((d) => m[d] ?? null));
    const touched = new Set(mine.filter((m) => m.direction === 'out').map(keyOf));
    for (const key of touched) {
      const series = all.filter((m) => keyOf(m) === key).sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || (a.direction === 'in' ? -1 : 1));
      for (const resource of register.denyNegative) {
        let balance = 0;
        let lowest = 0;
        for (const m of series) {
          const v = Number(m[resource]) || 0;
          balance = Number((balance + (m.direction === 'out' ? -v : v)).toPrecision(15));
          if (String(m.date ?? '') >= String(row.date ?? '')) lowest = Math.min(lowest, balance);
        }
        if (lowest < 0) {
          const sample = series[0]!;
          const labels = await Promise.all(
            dims.map(async (d) => {
              const f = register.fields.find((x) => x.name === d);
              return f?.type === 'ref' && f.ref ? data.label(f.ref, sample[d]) : String(sample[d] ?? '');
            }),
          );
          const resourceTitle = register.fields.find((f) => f.name === resource)?.title ?? resource;
          problems.push({
            message: t('registers', 'Not enough in “{register}” for {what}: {resource} would be {balance}', {
              register: register.title,
              what: labels.filter(Boolean).join(', '),
              resource: resourceTitle,
              balance: lowest,
            }),
          });
        }
      }
    }
  }
  if (problems.length) throw new ValidationError(problems);
}

/** Re-posts every posted record of `tb` (after posting rules change), reporting progress. */
export async function repost(data: DataService, tb: TableDef, progress?: (done: number, total: number) => void): Promise<number> {
  const docs = (await data.all(tb.name)).filter((d) => isPosted(tb, d));
  let done = 0;
  for (const doc of docs) {
    await data.compute(tb, [doc]);
    const ops = await movementsFor(data, tb, doc);
    await data.writeBatch(ops);
    progress?.(++done, docs.length);
  }
  return done;
}
