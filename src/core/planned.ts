/**
 * Planned movements (Task_next.md 3.3): a posting rule `from: 'schedule'`
 * makes a register movement each time a record's schedule comes round — a
 * salary on the 15th, rent on the last day — within the time the record (or
 * its version) is in force. They are never stored: a balance on a date or a
 * report over a period asks for those up to its end, and they are made then,
 * the same every time, from the records as they are.
 *
 * So a recurring payment counts as made once its moment has passed, and the
 * future is the same movements further on: a forecast is a balance at a
 * later date. A version closed by an edit keeps planning what it planned
 * until then; the next one plans from then on.
 */
import { evaluate, type Expr } from './expr/index';
import type { PostingRule, TableDef } from './config/types';
import type { Row } from './query/types';
import { occurrences, readSchedule } from './schedule';
import { isoDateTime, parseCached, truthy, type DataService } from './data';
import type { EnvFactory } from './scope';

export interface PlanSource {
  table: TableDef;
  rule: PostingRule;
  rows: Row[];
  envOf: EnvFactory;
  when: Expr | null;
  set: [string, Expr][];
}

/** The tables whose schedules post into `register`, each with its rule. */
export function scheduledRules(tables: TableDef[], register: string): { table: TableDef; rule: PostingRule }[] {
  const out: { table: TableDef; rule: PostingRule }[] = [];
  for (const table of tables) for (const rule of table.posting ?? []) if (rule.from === 'schedule' && rule.register === register && rule.schedule) out.push({ table, rule });
  return out;
}

/**
 * The records that plan movements into `register`, loaded with what their
 * rules' expressions reach. `trail` stops a loop: a scheduled table whose
 * computed fields read this very register gets its rows as stored.
 */
export async function planSources(data: DataService, register: string, trail: string[] = []): Promise<PlanSource[]> {
  const mark = `plan:${register}`;
  if (trail.includes(mark)) return [];
  const below = [...trail, mark];
  const out: PlanSource[] = [];
  for (const { table, rule } of scheduledRules(data.config.tables, register)) {
    const rows = await data.all(table.name);
    await data.compute(table, rows, {}, below);
    const sources = [...Object.values(rule.set), ...(rule.when ? [rule.when] : [])];
    const envOf = await data.scope(table, sources, {}, undefined, below);
    let when: Expr | null = null;
    const set: [string, Expr][] = [];
    try {
      when = rule.when ? parseCached(rule.when) : null;
      for (const [k, source] of Object.entries(rule.set)) set.push([k, parseCached(source)]);
    } catch {
      // A broken rule is the configuration's problem, shown by the designer: it plans nothing.
      continue;
    }
    out.push({ table, rule, rows, envOf, when, set });
  }
  return out;
}

/**
 * The movements planned in (from, to]: one per moment a record's schedule
 * comes round while it is in force — from `validFrom` (or its creation) up to
 * `validTo`. `$date` in the rule's expressions is that moment.
 */
export function expand(sources: PlanSource[], from: string | null, to: string): Row[] {
  const out: Row[] = [];
  for (const src of sources) {
    for (const row of src.rows) {
      const schedule = readSchedule(row[src.rule.schedule!]);
      const start = typeof row.validFrom === 'string' ? row.validFrom : typeof row._createdAt === 'string' ? row._createdAt : null;
      if (!schedule || !start) continue;
      const end = typeof row.validTo === 'string' && row.validTo ? row.validTo : null;
      const upTo = end && end <= to ? end : to;
      // From the version's start, taking in a moment exactly then; or after `from`, if that is later.
      const moments = from && from >= start ? occurrences(schedule, from, upTo) : occurrences(schedule, start, upTo, 100_000, true);
      for (const at of moments) {
        if (end && at >= end) break;
        const env = src.envOf(row, { date: at });
        try {
          if (src.when && !truthy(evaluate(src.when, env))) continue;
          const movement: Row = { id: `${row.id}@${at}@${src.rule.key}`, recorder: row.id, date: at, direction: src.rule.direction, planned: true };
          for (const [k, expr] of src.set) movement[k] = evaluate(expr, env);
          out.push(movement);
        } catch {
          // An expression that fails on one record plans nothing for it, rather than nothing at all.
        }
      }
    }
  }
  return out;
}

/** Now, as movements are dated. */
export const nowText = (data: DataService): string => isoDateTime(data.context.now());
