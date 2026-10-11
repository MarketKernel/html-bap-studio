/**
 * Evaluates an AST against an environment. Synchronous by design (Task.md 7):
 * whatever a host function needs from the data is loaded before evaluation.
 */
import { t } from '../i18n';
import { ExprError } from './lexer';
import { parseExpr, type Expr } from './parser';
import {
  addDays,
  arityError,
  builtin,
  clean,
  compare,
  daysBetween,
  equals,
  parseDate,
  toNumber,
  toText,
  truthy,
  type CallContext,
} from './functions';

export type Value = string | number | boolean | null | Value[] | { [k: string]: unknown };

export interface Env {
  /** The value of a name path; undefined counts as null. */
  resolve(path: string[]): unknown;
  /**
   * Host functions (lookup, balance, currentUser…), called with `name` as written
   * and eagerly evaluated arguments; undefined means "not mine". `nodes` are the
   * argument expressions, for a host that evaluates a condition in its own env.
   */
  call?(name: string, args: Value[], env: Env, nodes?: Expr[]): Value | undefined;
  /** The clock for today() and now(). */
  now?: () => Date;
}

export function evaluate(expr: Expr, env: Env): Value {
  switch (expr.type) {
    case 'literal':
      return expr.value;
    case 'path':
      return normalize(env.resolve(expr.path));
    case 'member':
      return normalize(walk(evaluate(expr.object, env), [expr.name]));
    case 'unary': {
      const v = evaluate(expr.arg, env);
      if (expr.op === 'not') return !truthy(v);
      const n = toNumber(v);
      return n === null ? null : clean(-n);
    }
    case 'binary':
      return binary(expr, env);
    case 'in': {
      const v = evaluate(expr.arg, env);
      let found = false;
      for (const item of expr.list) {
        const w = evaluate(item, env);
        // A list given as one array value (`x in ($selected)`) is searched inside.
        if (Array.isArray(w) && !Array.isArray(v) ? w.some((x) => equals(v, x)) : equals(v, w)) {
          found = true;
          break;
        }
      }
      return found !== expr.negated;
    }
    case 'between': {
      const v = evaluate(expr.arg, env);
      const lo = compare(v, evaluate(expr.low, env));
      const hi = compare(v, evaluate(expr.high, env));
      const inside = lo !== null && hi !== null && lo >= 0 && hi <= 0;
      return inside !== expr.negated;
    }
    case 'call':
      return call(expr, env);
  }
}

function binary(expr: Extract<Expr, { type: 'binary' }>, env: Env): Value {
  const { op } = expr;
  if (op === 'and') return truthy(evaluate(expr.left, env)) && truthy(evaluate(expr.right, env));
  if (op === 'or') return truthy(evaluate(expr.left, env)) || truthy(evaluate(expr.right, env));
  const a = evaluate(expr.left, env);
  const b = evaluate(expr.right, env);
  switch (op) {
    case '=':
      return equals(a, b);
    case '<>':
      return !equals(a, b);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const c = compare(a, b);
      if (c === null) return false;
      return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
    }
    case '&':
      return toText(a) + toText(b);
    case '+': {
      if (a === null || b === null) return null;
      const da = parseDate(a);
      const db = parseDate(b);
      if (da && typeof b === 'number') return addDays(da, b);
      if (db && typeof a === 'number') return addDays(db, a);
      if (typeof a === 'string' || typeof b === 'string') return toText(a) + toText(b);
      return arithmetic(op, a, b);
    }
    case '-': {
      if (a === null || b === null) return null;
      const da = parseDate(a);
      const db = parseDate(b);
      if (da && db) return daysBetween(db, da);
      if (da && typeof b === 'number') return addDays(da, -b);
      return arithmetic(op, a, b);
    }
    default:
      return arithmetic(op, a, b);
  }
}

function arithmetic(op: '+' | '-' | '*' | '/' | '%', a: Value, b: Value): Value {
  const x = toNumber(a);
  const y = toNumber(b);
  if (x === null || y === null) return null;
  switch (op) {
    case '+':
      return clean(x + y);
    case '-':
      return clean(x - y);
    case '*':
      return clean(x * y);
    case '/':
      return y === 0 ? null : clean(x / y);
    case '%':
      return y === 0 ? null : clean(x % y);
  }
}

function call(expr: Extract<Expr, { type: 'call' }>, env: Env): Value {
  const f = builtin(expr.name);
  if (f) {
    const wrong = arityError(f, expr.args.length);
    if (wrong) throw new ExprError(wrong, expr.pos, expr.end);
    const ctx: CallContext = {
      env,
      args: expr.args,
      evaluate: (e) => evaluate(e, env),
      fail(message, index) {
        const node = index === undefined ? expr : expr.args[index] ?? expr;
        throw new ExprError(message, node.pos, node.end);
      },
    };
    return f.fn(f.lazy ? [] : expr.args.map((a) => evaluate(a, env)), ctx);
  }
  if (env.call) {
    const result = env.call(expr.name, expr.args.map((a) => evaluate(a, env)), env, expr.args);
    if (result !== undefined) return normalize(result);
  }
  throw new ExprError(t('expr', 'Unknown function “{name}”', { name: expr.name }), expr.pos, expr.end);
}

function normalize(v: unknown): Value {
  return v === undefined ? null : (v as Value);
}

/**
 * Follows a path through objects; through an array it maps over the items and
 * flattens one level, so `lines.amount` is the column of amounts.
 */
export function walk(value: unknown, path: readonly string[]): unknown {
  let v = value;
  for (let i = 0; i < path.length; i += 1) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) {
      const rest = path.slice(i);
      return v.flatMap((item) => {
        const r = walk(item, rest);
        return Array.isArray(r) ? r : [r ?? null];
      });
    }
    if (typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[path[i] as string];
  }
  return v;
}

const cache = new Map<string, Expr>();
const CACHE_SIZE = 500;

/** Parses (once per distinct source, while it stays among the last 500) and evaluates. */
export function evalSource(source: string, env: Env): Value {
  let expr = cache.get(source);
  if (!expr) {
    expr = parseExpr(source);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    cache.set(source, expr);
  }
  return evaluate(expr, env);
}

/** An Env over one row: paths walk its fields, `$name` comes from `vars` ($this defaults to the row). */
export function rowEnv(row: Record<string, unknown>, extra?: Partial<Env> & { vars?: Record<string, unknown> }): Env {
  const vars = extra?.vars ?? {};
  const env: Env = {
    resolve(path) {
      const [first, ...rest] = path;
      if (first === undefined) return null;
      if (first.startsWith('$')) {
        const name = first.slice(1);
        const base = Object.hasOwn(vars, first) ? vars[first] : Object.hasOwn(vars, name) ? vars[name] : first === '$this' ? row : undefined;
        return walk(base, rest);
      }
      return walk(row, path);
    },
  };
  if (extra?.call) env.call = extra.call;
  if (extra?.now) env.now = extra.now;
  if (extra?.resolve) {
    // A given resolver answers first; the row is the fallback.
    const own = env.resolve;
    const given = extra.resolve;
    env.resolve = (path) => {
      const v = given(path);
      return v === undefined ? own(path) : v;
    };
  }
  return env;
}
