/**
 * The expression language (Task.md 7): a safe interpreter — no eval, the page's
 * CSP forbids it — for computed fields, defaults, conditions and filters.
 */
import { t } from '../i18n';
import { arityError, builtin, FUNCTIONS } from './functions';
import { ExprError } from './lexer';
import { parseExpr, type Expr } from './parser';

export { ExprError } from './lexer';
export { parseExpr, type Expr, type BinaryOp } from './parser';
export { evaluate, evalSource, rowEnv, type Env, type Value } from './eval';
export { FUNCTIONS } from './functions';

/** Calls every node of the tree, parents before children, in source order. */
export function visit(expr: Expr, f: (node: Expr) => void): void {
  f(expr);
  switch (expr.type) {
    case 'member':
      visit(expr.object, f);
      break;
    case 'call':
      for (const a of expr.args) visit(a, f);
      break;
    case 'unary':
      visit(expr.arg, f);
      break;
    case 'binary':
      visit(expr.left, f);
      visit(expr.right, f);
      break;
    case 'in':
      visit(expr.arg, f);
      for (const a of expr.list) visit(a, f);
      break;
    case 'between':
      visit(expr.arg, f);
      visit(expr.low, f);
      visit(expr.high, f);
      break;
  }
}

/**
 * Every name path the expression reads, once each — what the core loads in one
 * batch before evaluating over many rows. Function names are not paths.
 */
export function collectPaths(expr: Expr): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  visit(expr, (node) => {
    if (node.type !== 'path') return;
    const key = node.path.join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(node.path);
  });
  return out;
}

/**
 * Checks an expression for the designer: syntax, that every name's first segment
 * is one of `names` (context names starting with '$' always pass), and that
 * every function exists and gets a fitting number of arguments.
 */
export function checkExpr(source: string, names: string[], extraFunctions: string[] = []): { error?: { message: string; pos: number; end: number } } {
  let expr: Expr;
  try {
    expr = parseExpr(source);
  } catch (e) {
    if (e instanceof ExprError) return { error: { message: e.message, pos: e.pos, end: e.end } };
    throw e;
  }
  const known = new Set(names);
  const extra = new Set(extraFunctions.map((f) => f.toLowerCase()));
  let error: { message: string; pos: number; end: number } | undefined;
  visit(expr, (node) => {
    if (error) return;
    if (node.type === 'path') {
      const first = node.path[0] as string;
      if (first.startsWith('$') || known.has(first)) return;
      const near = suggest(first, names);
      const message = near
        ? t('expr', 'Field “{name}” is not found. Did you mean “{suggestion}”?', { name: first, suggestion: near })
        : t('expr', 'Field “{name}” is not found', { name: first });
      error = { message, pos: node.pos, end: node.pos + first.length };
    } else if (node.type === 'call') {
      const f = builtin(node.name);
      if (f) {
        const wrong = arityError(f, node.args.length);
        if (wrong) error = { message: wrong, pos: node.pos, end: node.end };
        return;
      }
      if (extra.has(node.name.toLowerCase())) return;
      const near = suggest(node.name, [...FUNCTIONS, ...extraFunctions], true);
      const message = near
        ? t('expr', 'Function “{name}” is not found. Did you mean “{suggestion}”?', { name: node.name, suggestion: near })
        : t('expr', 'Function “{name}” is not found', { name: node.name });
      error = { message, pos: node.pos, end: node.pos + node.name.length };
    }
  });
  return error ? { error } : {};
}

/** The closest candidate within two edits, if any. */
function suggest(word: string, candidates: readonly string[], ignoreCase = false): string | undefined {
  const w = ignoreCase ? word.toLowerCase() : word;
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of candidates) {
    const d = levenshtein(w, ignoreCase ? c.toLowerCase() : c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost));
    }
    prev = row;
  }
  return prev[b.length] as number;
}
