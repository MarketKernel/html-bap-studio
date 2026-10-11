/**
 * The schema change between two revisions of a configuration (Task.md 6.3),
 * for the sources that store what the configuration describes. Tables and
 * fields are matched by their `key`, which never changes: a different name
 * with the same key is a rename, and the data moves with it.
 */
import type { SchemaChange } from '../plugin-protocol';
import { constantsTable } from './model';
import type { Config, FieldDef, TableDef } from './types';

function fieldsOf(tb: TableDef): FieldDef[] {
  // Parts live inside their document's record: a change to them is the document's own business.
  return tb.fields.filter((f) => !f.computed || f.stored);
}

export function schemaDiff(before: Config, after: Config): SchemaChange[] {
  const out: SchemaChange[] = [];
  // The constants' record lives in a table of its own, which changes like any other.
  const tablesOf = (c: Config) => [...c.tables, ...[constantsTable(c)].filter((x): x is TableDef => !!x)];
  const old = new Map(tablesOf(before).map((tb) => [tb.key, tb]));
  const next = new Map(tablesOf(after).map((tb) => [tb.key, tb]));
  for (const [key, tb] of old) if (!next.has(key)) out.push({ op: 'dropTable', table: tb.name });
  for (const [key, tb] of next) {
    const prev = old.get(key);
    if (!prev) {
      out.push({ op: 'createTable', table: tb.name });
      continue;
    }
    if (prev.name !== tb.name) out.push({ op: 'renameTable', from: prev.name, to: tb.name });
    const prevFields = new Map(fieldsOf(prev).map((f) => [f.key, f]));
    const nextFields = new Map(fieldsOf(tb).map((f) => [f.key, f]));
    for (const [fk, f] of prevFields) if (!nextFields.has(fk)) out.push({ op: 'dropField', table: tb.name, field: f.name });
    for (const [fk, f] of nextFields) {
      const pf = prevFields.get(fk);
      if (!pf) out.push({ op: 'addField', table: tb.name, field: f.name, type: f.type });
      else {
        if (pf.name !== f.name) out.push({ op: 'renameField', table: tb.name, from: pf.name, to: f.name });
        if (pf.type !== f.type) out.push({ op: 'changeType', table: tb.name, field: f.name, from: pf.type, to: f.type });
      }
    }
  }
  return out;
}

/** The changes that lose data: shown in a confirmation before saving. */
export function destructive(changes: SchemaChange[]): SchemaChange[] {
  return changes.filter((c) => c.op === 'dropTable' || c.op === 'dropField' || c.op === 'changeType');
}
