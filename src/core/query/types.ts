/**
 * The query language shared by the core, the page and every data source plugin.
 * It crosses the worker boundary as plain data, so it is all JSON: no functions,
 * no classes, no Dates.
 *
 * Values follow one convention everywhere (Task.md 5.4): numbers are numbers,
 * a date is 'YYYY-MM-DD', a date-time 'YYYY-MM-DDTHH:mm:ss' (local, no zone),
 * a reference is the referenced record's id as a string. ISO strings compare
 * correctly as strings, which is why dates are kept that way.
 */

export type Scalar = string | number | boolean | null;
export type Row = Record<string, unknown> & { id: string; _rev?: string };

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'between'
  | 'isNull'
  | 'isNotNull';

export interface Condition {
  /** A field name; 'a.b' paths are for the core's own client-side use, sources see plain names. */
  field: string;
  op: FilterOp;
  /** `in`/`notIn`: an array; `between`: [from, to], both inclusive; `isNull`/`isNotNull`: unused. */
  value?: unknown;
}

export type Filter = Condition | { and: Filter[] } | { or: Filter[] } | { not: Filter };

export interface OrderBy {
  field: string;
  desc?: boolean;
}

export interface Query {
  table: string;
  select?: string[];
  where?: Filter;
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
  cursor?: string;
  /** Ask for `total`: the count of all matching rows, ignoring limit and offset. */
  count?: boolean;
}

export interface QueryResult {
  rows: Row[];
  total?: number;
  cursor?: string;
}

export type AggregateFn = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'countDistinct';

export interface Measure {
  /** The output column. */
  name: string;
  fn: AggregateFn;
  /** The field aggregated; for `count` it may be left out (count rows). */
  field?: string;
}

export interface AggregateQuery {
  table: string;
  where?: Filter;
  groupBy: string[];
  measures: Measure[];
  orderBy?: OrderBy[];
}
