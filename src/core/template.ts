/**
 * Print templates (Task.md 11.4): HTML with `{{path}}`, `{{#each part}}…{{/each}}`,
 * `{{#if path}}…{{else}}…{{/if}}`, `{{format path "money"}}`,
 * `{{amountInWords path}}`, `{{t "Text"}}` and `{{@number}}` inside each.
 *
 * Every substituted value is escaped: the template's author writes HTML, the
 * data never becomes HTML. The result is shown in a sandboxed iframe that
 * runs no scripts anyway (Task.md 3).
 */

export interface TemplateHelpers {
  /** The value at a dotted path, from the current scope (a line inside each, else the record). */
  format(value: unknown, kind: string): string;
  words(value: unknown): string;
  translate(text: string): string;
}

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; expr: string }
  | { kind: 'each'; path: string; body: Node[] }
  | { kind: 'if'; path: string; body: Node[]; otherwise: Node[] };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function parse(source: string): Node[] {
  const tokens = source.split(/(\{\{[^}]*\}\})/);
  let i = 0;
  const block = (until: string[]): { nodes: Node[]; end: string } => {
    const nodes: Node[] = [];
    while (i < tokens.length) {
      const token = tokens[i++]!;
      const m = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(token);
      if (!m) {
        if (token) nodes.push({ kind: 'text', text: token });
        continue;
      }
      const inner = m[1]!;
      if (until.includes(inner)) return { nodes, end: inner };
      const each = /^#each\s+([\w.@$]+)$/.exec(inner);
      const cond = /^#if\s+([\w.@$]+)$/.exec(inner);
      if (each) nodes.push({ kind: 'each', path: each[1]!, body: block(['/each']).nodes });
      else if (cond) {
        const yes = block(['else', '/if']);
        const no = yes.end === 'else' ? block(['/if']).nodes : [];
        nodes.push({ kind: 'if', path: cond[1]!, body: yes.nodes, otherwise: no });
      } else nodes.push({ kind: 'value', expr: inner });
    }
    return { nodes, end: '' };
  };
  return block([]).nodes;
}

const cache = new Map<string, Node[]>();

export function renderTemplate(source: string, record: Record<string, unknown>, helpers: TemplateHelpers): string {
  let nodes = cache.get(source);
  if (!nodes) {
    nodes = parse(source);
    if (cache.size > 100) cache.clear();
    cache.set(source, nodes);
  }
  return run(nodes, [record], helpers, {});
}

function lookup(scopes: Record<string, unknown>[], path: string, locals: Record<string, unknown>): unknown {
  if (path.startsWith('@')) return locals[path];
  const parts = path.split('.');
  for (let s = scopes.length - 1; s >= 0; s--) {
    const scope = scopes[s]!;
    if (!(parts[0]! in scope)) continue;
    let v: unknown = scope;
    for (const p of parts) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined;
    return v;
  }
  return undefined;
}

function run(nodes: Node[], scopes: Record<string, unknown>[], helpers: TemplateHelpers, locals: Record<string, unknown>): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (node.kind === 'each') {
      const list = lookup(scopes, node.path, locals);
      if (Array.isArray(list)) {
        list.forEach((item, index) => {
          out += run(node.body, [...scopes, (item ?? {}) as Record<string, unknown>], helpers, { '@index': index, '@number': index + 1 });
        });
      }
    } else if (node.kind === 'if') {
      const v = lookup(scopes, node.path, locals);
      const yes = !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length));
      out += run(yes ? node.body : node.otherwise, scopes, helpers, locals);
    } else out += escapeHtml(value(node.expr, scopes, helpers, locals));
  }
  return out;
}

function value(expr: string, scopes: Record<string, unknown>[], helpers: TemplateHelpers, locals: Record<string, unknown>): string {
  const args = [...expr.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? m[3])!);
  const quoted = [...expr.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] !== undefined || m[2] !== undefined);
  const arg = (i: number) => (quoted[i] ? args[i] : lookup(scopes, args[i] ?? '', locals));
  switch (args[0]) {
    case 't':
      return helpers.translate(String(args[1] ?? ''));
    case 'format':
      return helpers.format(arg(1), String(args[2] ?? ''));
    case 'amountInWords':
      return helpers.words(arg(1));
    default: {
      const v = lookup(scopes, args[0] ?? '', locals);
      if (v === null || v === undefined) return '';
      return typeof v === 'object' ? '' : helpers.format(v, '');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Text with expressions: a dashboard's words
 * ------------------------------------------------------------------ */

type TextNode = { kind: 'text'; text: string } | { kind: 'expr'; expr: string; format: string } | { kind: 'if'; expr: string; body: TextNode[]; otherwise: TextNode[] };

/**
 * Plain text with `{{expression}}`, `{{expression | money}}` and
 * `{{#if expression}}…{{else}}…{{/if}}` — the words of a dashboard: “the
 * money lasts until {{reach('Forecast', 'assets', '<=', 0) | date}}”. No HTML:
 * what comes out is text, set as text.
 */
export function parseText(source: string): TextNode[] {
  const tokens = source.split(/(\{\{[\s\S]*?\}\})/);
  let i = 0;
  const block = (until: string[]): { nodes: TextNode[]; end: string } => {
    const nodes: TextNode[] = [];
    while (i < tokens.length) {
      const token = tokens[i++]!;
      const m = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(token);
      if (!m) {
        if (token) nodes.push({ kind: 'text', text: token });
        continue;
      }
      const inner = m[1]!;
      if (until.includes(inner)) return { nodes, end: inner };
      const cond = /^#if\s+([\s\S]+)$/.exec(inner);
      if (cond) {
        const yes = block(['else', '/if']);
        const no = yes.end === 'else' ? block(['/if']).nodes : [];
        nodes.push({ kind: 'if', expr: cond[1]!, body: yes.nodes, otherwise: no });
        continue;
      }
      // A format after the last bar that is not part of `||`: {{x | money}}.
      const f = /^([\s\S]*?)\s*\|\s*(money|number|integer|percent|date|datetime)$/.exec(inner);
      nodes.push({ kind: 'expr', expr: f ? f[1]! : inner, format: f ? f[2]! : '' });
    }
    return { nodes, end: '' };
  };
  return block([]).nodes;
}

/** Every expression a text names, to load what they reach before rendering. */
export function textExpressions(nodes: TextNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === 'expr' ? [n.expr] : n.kind === 'if' ? [n.expr, ...textExpressions(n.body), ...textExpressions(n.otherwise)] : []));
}

export function renderText(nodes: TextNode[], value: (expr: string) => unknown, format: (v: unknown, kind: string) => string, truthy: (v: unknown) => boolean): string {
  return nodes
    .map((n) => {
      if (n.kind === 'text') return n.text;
      if (n.kind === 'if') return renderText(truthy(value(n.expr)) ? n.body : n.otherwise, value, format, truthy);
      return format(value(n.expr), n.format);
    })
    .join('');
}
