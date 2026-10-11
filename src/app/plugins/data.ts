/**
 * The application's data for the plugins approved to read it (Task_next.md H):
 * what `host.data` in a plugin's worker asks, answered from the DataService —
 * rows with their computed fields, a register's movements with the planned
 * ones, the configuration, an expression over no record. Read-only: nothing
 * here writes.
 */
import { DATA_METHODS, PluginError } from '../../core/plugin-protocol';
import type { DataService } from '../../core/data';
import type { Query } from '../../core/query/types';
import { evaluator } from '../../core/reports';

export async function answerData(data: DataService, method: string, args: unknown[]): Promise<unknown> {
  if (!(DATA_METHODS as readonly string[]).includes(method)) throw new PluginError('unsupported', `host.data.${method}() does not exist`);
  switch (method) {
    case 'query': {
      const q = args[0] as Query;
      const tb = data.table(q?.table);
      const result = await data.query(q);
      await data.compute(tb, result.rows);
      return result;
    }
    case 'movements': {
      const [register, to, from] = args as [string, string | null | undefined, string | null | undefined];
      const tb = data.table(register);
      if (tb.kind !== 'register') throw new PluginError('validation', `“${register}” is not a register`);
      const rows = await data.movements(register, to ?? null, from ?? null);
      await data.compute(tb, rows);
      return rows;
    }
    case 'config':
      return structuredClone(data.config);
    default: {
      const expression = String(args[0] ?? '');
      return (await evaluator(data, [expression]))(expression);
    }
  }
}
