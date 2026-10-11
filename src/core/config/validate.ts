/**
 * Problems of a configuration — broken references, bad names, expressions that
 * do not parse or name unknown fields — collected for the designer's
 * "Problems" panel (Task.md 9), each with where it is. And migrate(): any
 * stored configuration, possibly of an older format, brought to this one.
 */
import { t } from '../i18n';
import { checkExpr, FUNCTIONS, parseExpr, visit } from '../expr/index';
import { aggregateCalls, HOST_FUNCTIONS as HOST } from '../scope';
import { parseText, textExpressions } from '../template';
import { allFields, AUDIT_FIELDS, constantsTable, fieldAtPath, IDENT, normalizeHotkey, table } from './model';
import { emptyConfig, FORMAT_VERSION, type Config, type FieldDef, type Step, type TableDef } from './types';

export interface ConfigProblem {
  /** What it is about: 'table:Products', 'table:Products/field:price', 'view:…'. */
  at: string;
  message: string;
}

const HOST_FUNCTIONS = Object.keys(HOST);

/** The configuration being checked, for the conditions of aggregates: they name another table's fields. */
let current: Config | null = null;

export function validateConfig(config: Config): ConfigProblem[] {
  current = config;
  try {
    return problemsOf(config);
  } finally {
    current = null;
  }
}

function problemsOf(config: Config): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const names = new Set<string>();
  const constants = constantsTable(config);
  if (constants) checkFields(config, constants, constants.fields, 'constants', recordNames(constants), out);
  for (const tb of config.tables) {
    const at = `table:${tb.name}`;
    if (!IDENT.test(tb.name)) out.push({ at, message: t('validate', 'Table name “{name}” must be a Latin identifier', { name: tb.name }) });
    else if (tb.name.startsWith('_')) out.push({ at, message: t('validate', 'Table name “{name}” must not start with “_”: such names are the studio’s own', { name: tb.name }) });
    if (names.has(tb.name)) out.push({ at, message: t('validate', 'Two tables are named “{name}”', { name: tb.name }) });
    names.add(tb.name);
    if (tb.connection && !config.connections.some((c) => c.id === tb.connection)) out.push({ at, message: t('validate', 'Unknown connection “{id}”', { id: tb.connection }) });
    checkFields(config, tb, tb.fields, at, recordNames(tb), out);
    for (const part of tb.parts ?? []) {
      const pat = `${at}/part:${part.name}`;
      if (!IDENT.test(part.name)) out.push({ at: pat, message: t('validate', 'Part name “{name}” must be a Latin identifier', { name: part.name }) });
      checkFields(config, tb, part.fields, pat, [...part.fields.map((f) => f.name), '$this', 'doc'], out);
      if (part.fill) {
        const src = table(config, part.fill.from);
        if (!src) out.push({ at: pat, message: t('validate', 'The lines are filled from “{table}”, which does not exist', { table: part.fill.from }) });
        else {
          const names = [...recordNames(src), 'doc'];
          if (part.fill.where) expression(part.fill.where, names, pat, out);
          for (const [target, source] of Object.entries(part.fill.set)) {
            if (!part.fields.some((f) => f.name === target)) out.push({ at: pat, message: t('validate', 'Part “{part}” has no field “{field}”', { part: part.name, field: target }) });
            expression(source, names, pat, out);
          }
        }
      }
    }
    for (const rule of tb.posting ?? []) {
      const register = table(config, rule.register);
      const pat = `${at}/posting:${rule.key}`;
      if (!register || register.kind !== 'register') {
        out.push({ at: pat, message: t('validate', 'Posting goes to “{name}”, which is not a register', { name: rule.register }) });
        continue;
      }
      // A document and its movements are written in one batch, by one data source.
      if ((register.connection ?? config.connections[0]?.id) !== (tb.connection ?? config.connections[0]?.id)) {
        out.push({ at: pat, message: t('validate', 'Register “{register}” must be in the same connection as the document', { register: register.name }) });
      }
      const source = rule.from === 'header' || rule.from === 'schedule' ? recordNames(tb) : (tb.parts ?? []).find((p) => p.name === rule.from)?.fields.map((f) => f.name);
      if (!source) out.push({ at: pat, message: t('validate', 'Posting reads part “{name}”, which does not exist', { name: rule.from }) });
      if (rule.from === 'schedule' && !tb.fields.some((f) => f.name === rule.schedule && f.type === 'schedule')) out.push({ at: pat, message: t('validate', 'A rule by a schedule needs a schedule field of the record: “{field}” is not one', { field: rule.schedule ?? '' }) });
      for (const [target, expr] of Object.entries(rule.set)) {
        if (!register.fields.some((f) => f.name === target)) out.push({ at: pat, message: t('validate', 'Register “{register}” has no field “{field}”', { register: register.name, field: target }) });
        expression(expr, [...(source ?? []), 'doc'], pat, out);
      }
      if (rule.when) expression(rule.when, [...(source ?? []), 'doc'], pat, out);
      if (rule.date) expression(rule.date, [...(source ?? []), 'doc'], pat, out);
    }
    if (tb.kind === 'register' && tb.versioned) out.push({ at, message: t('validate', 'A register keeps movements, not versions: it cannot be versioned') });
    if (tb.kind === 'register' && tb.posting?.length) out.push({ at, message: t('validate', 'A register is what records post into: it has no posting rules of its own') });
    if (tb.lockedWhen) expression(tb.lockedWhen, recordNames(tb), `${at}/locked`, out);
    for (const v of tb.validations ?? []) expression(v.when, recordNames(tb), `${at}/validation`, out);
  }
  for (const v of config.views) {
    const at = `view:${v.name}`;
    const tb = table(config, v.table);
    if (!tb) {
      out.push({ at, message: t('validate', 'View “{name}” shows table “{table}”, which does not exist', { name: v.name, table: v.table }) });
      continue;
    }
    for (const r of v.rules ?? []) expression(r.when, recordNames(tb), at, out);
    if (v.where) expression(v.where, recordNames(tb), at, out);
    for (const d of v.details ?? []) {
      if (d.kind !== 'view') continue;
      const target = table(config, d.table);
      if (!target) out.push({ at, message: t('validate', 'A detail tab shows “{table}”, which does not exist', { table: d.table ?? '' }) });
      else if (d.where) expression(d.where, recordNames(target), at, out);
    }
  }
  for (const a of config.actions) checkSteps(config, a.steps, `action:${a.name}`, a.table ? table(config, a.table) : undefined, out);
  checkHotkeys(config, out);
  for (const d of config.dashboards) {
    for (const w of d.widgets) {
      const at = `dashboard:${d.name}/${w.key}`;
      // Expressions of a dashboard belong to no record: only what they name of other tables is checked.
      if (w.value) expression(w.value, [], at, out);
      if (w.text) {
        try {
          for (const e of textExpressions(parseText(w.text))) expression(e, [], at, out);
        } catch {
          // An unbalanced {{#if}} shows as text; nothing to report.
        }
      }
      if (w.report && !config.reports.some((r) => r.name === w.report)) out.push({ at, message: t('validate', 'A widget shows report “{name}”, which does not exist', { name: w.report }) });
      for (const a of w.actions ?? []) if (!config.actions.some((x) => x.name === a)) out.push({ at, message: t('validate', 'A widget offers action “{name}”, which does not exist', { name: a }) });
    }
  }
  for (const f of config.forms) {
    const tb = table(config, f.table);
    if (tb && f.focus && !allFields(tb).some((x) => x.name === f.focus)) out.push({ at: `form:${f.name}`, message: t('validate', 'The form puts the cursor in “{field}”, which is not a field of “{table}”', { field: f.focus, table: tb.name }) });
  }
  for (const tr of config.triggers) {
    const tb = table(config, tr.table);
    if (!tb) out.push({ at: `trigger:${tr.key}`, message: t('validate', 'Trigger of table “{table}”, which does not exist', { table: tr.table }) });
    checkSteps(config, tr.steps, `trigger:${tr.key}`, tb, out);
  }
  for (const r of config.reports) {
    // A plugin's report reads the data itself.
    if (r.plugin) continue;
    const [sourceTable, sourcePart] = r.source.split('.');
    const src = table(config, sourceTable);
    if (!src || (sourcePart && !(src.parts ?? []).some((p) => p.name === sourcePart))) out.push({ at: `report:${r.name}`, message: t('validate', 'Report “{name}” reads “{table}”, which does not exist', { name: r.name, table: r.source }) });
  }
  return out;
}

/** Every shortcut is one, and no two of them are the same where both would answer. */
function checkHotkeys(config: Config, out: ConfigProblem[]) {
  const seen = new Map<string, string>();
  const add = (text: string | undefined, scope: string, at: string) => {
    if (!text) return;
    const key = normalizeHotkey(text);
    if (!key) {
      out.push({ at, message: t('validate', '“{key}” is not a shortcut: a letter, a digit or F1–F12, with Ctrl, Alt, Shift', { key: text }) });
      return;
    }
    // Menu items and actions of no table answer everywhere; an action of a table, in its lists and cards.
    for (const where of scope === '*' ? [...seen.keys()].filter((k) => k.endsWith(`|${key}`)) : [`*|${key}`, `${scope}|${key}`]) {
      const other = seen.get(where);
      if (other) out.push({ at, message: t('validate', 'The shortcut {key} is taken by {other}', { key, other }) });
    }
    seen.set(`${scope}|${key}`, at);
  };
  const walk = (nodes: Config['menu']) => {
    for (const n of nodes) {
      add(n.hotkey, '*', `menu:${n.title}`);
      if (n.children) walk(n.children);
    }
  };
  walk(config.menu);
  for (const a of config.actions) add(a.hotkey, a.table ?? '*', `action:${a.name}`);
}

function checkFields(config: Config, tb: TableDef, fields: FieldDef[], at: string, names: string[], out: ConfigProblem[]) {
  const seen = new Set<string>();
  for (const f of fields) {
    const fat = `${at}/field:${f.name}`;
    if (!IDENT.test(f.name)) out.push({ at: fat, message: t('validate', 'Field name “{name}” must be a Latin identifier', { name: f.name }) });
    if (seen.has(f.name)) out.push({ at: fat, message: t('validate', 'Two fields are named “{name}”', { name: f.name }) });
    seen.add(f.name);
    if (f.type === 'ref' && !table(config, f.ref)) out.push({ at: fat, message: t('validate', 'Field “{field}” refers to table “{table}”, which does not exist', { field: f.name, table: f.ref ?? '' }) });
    if (f.scaleFrom && !fields.some((x) => x.name === f.scaleFrom && (x.type === 'integer' || x.type === 'decimal'))) out.push({ at: fat, message: t('validate', 'Field “{field}” takes its decimals from “{from}”, which is not a number field beside it', { field: f.name, from: f.scaleFrom }) });
    if (f.type === 'enum' && !f.options?.length && !config.enums.some((e) => e.name === f.enum)) out.push({ at: fat, message: t('validate', 'Field “{field}” has no list of values', { field: f.name }) });
    const scope = [...names, ...AUDIT_FIELDS.map((x) => x.name), 'id'];
    if (f.default) expression(f.default, scope, fat, out);
    if (f.computed) expression(f.computed, scope, fat, out);
    if (typeof f.readonly === 'string') expression(f.readonly, scope, fat, out);
    if (f.visible) expression(f.visible, scope, fat, out);
  }
  void tb;
}

function checkSteps(config: Config, steps: Step[], at: string, tb: TableDef | undefined, out: ConfigProblem[]) {
  const scope = tb ? recordNames(tb) : [];
  for (const step of steps) {
    if (step.type === 'create') {
      const target = table(config, step.table);
      if (!target) out.push({ at, message: t('validate', 'Step creates a record in “{table}”, which does not exist', { table: step.table }) });
      for (const e of Object.values(step.values)) expression(e, scope, at, out);
    } else if (step.type === 'update') for (const e of Object.values(step.values)) expression(e, scope, at, out);
    else if (step.type === 'fill' && tb && !(tb.parts ?? []).some((p) => p.name === step.part && p.fill)) out.push({ at, message: t('validate', 'Step fills part “{part}”, which does not say where its lines come from', { part: step.part }) });
    else if (step.type === 'if') {
      expression(step.when, scope, at, out);
      checkSteps(config, step.steps, at, tb, out);
      checkSteps(config, step.else ?? [], at, tb, out);
    }
  }
}

/** What an expression over a record of `tb` may name: its fields, its parts, id and the audit fields. */
function recordNames(tb: TableDef): string[] {
  return [...allFields(tb).map((f) => f.name), ...(tb.parts ?? []).map((p) => p.name), 'id', ...AUDIT_FIELDS.map((f) => f.name)];
}

/** With no table in context (an action for any table) only the syntax can be checked. */
function expression(source: string, names: string[], at: string, out: ConfigProblem[]) {
  if (!names.length) {
    try {
      const expr = parseExpr(source);
      if (current) for (const call of aggregateCalls(expr)) checkAggregate(current, call, source, at, out);
    } catch (error) {
      out.push({ at, message: `${source}: ${error instanceof Error ? error.message : String(error)}` });
    }
    return;
  }
  const r = checkExpr(source, names, HOST_FUNCTIONS);
  if (r.error) {
    out.push({ at, message: `${source}: ${r.error.message}` });
    return;
  }
  const expr = parseExpr(source);
  visit(expr, (node) => {
    if (node.type !== 'call') return;
    const name = HOST_FUNCTIONS.find((f) => f.toLowerCase() === node.name.toLowerCase());
    const arity = name ? HOST[name] : undefined;
    if (arity && (node.args.length < arity[0] || node.args.length > arity[1])) {
      out.push({ at, message: `${source}: ${arity[1] === Infinity ? t('validate', 'Function “{name}” takes at least {min} arguments', { name: name!, min: arity[0] }) : t('validate', 'Function “{name}” takes from {min} to {max} arguments', { name: name!, min: arity[0], max: arity[1] })}` });
    }
  });
  if (current) for (const call of aggregateCalls(expr)) checkAggregate(current, call, source, at, out);
}

/** The table an aggregate names exists, so do its fields, and its condition is about that table. */
function checkAggregate(config: Config, call: ReturnType<typeof aggregateCalls>[number], source: string, at: string, out: ConfigProblem[]) {
  const [head, part] = call.table.split('.') as [string, string?];
  const owner = table(config, head);
  const partDef = part ? (owner?.parts ?? []).find((p) => p.name === part) : undefined;
  if (!owner || (part && !partDef)) {
    out.push({ at, message: `${source}: ${t('validate', 'Table “{table}” does not exist', { table: call.table })}` });
    return;
  }
  const target: TableDef = partDef ? { key: `${owner.key}.${partDef.key}`, name: call.table, kind: 'table', title: call.table, fields: partDef.fields } : owner;
  for (const path of [call.field, call.sort]) {
    if (!path || (part && path.startsWith('doc.'))) continue;
    if (!fieldAtPath(config, target, path)) out.push({ at, message: `${source}: ${t('validate', 'Table “{table}” has no field “{field}”', { table: call.table, field: path })}` });
  }
  if (call.cond) expression(call.cond, [...recordNames(target), ...(part ? ['doc'] : [])], at, out);
}

export const EXPRESSION_FUNCTIONS = [...FUNCTIONS, ...HOST_FUNCTIONS];

/** Brings a stored configuration of any known format to the current one; unknown parts get defaults. */
export function migrate(raw: unknown): Config {
  const base = emptyConfig();
  if (!raw || typeof raw !== 'object') return base;
  const c = raw as Partial<Config>;
  const version = typeof c.formatVersion === 'number' ? c.formatVersion : 1;
  if (version > FORMAT_VERSION) throw new Error(t('validate', 'This application was made by a newer version of the studio (format {version})', { version }));
  // Format 1 is the first; later formats add their steps here, one by one.
  return {
    ...base,
    ...c,
    formatVersion: FORMAT_VERSION,
    app: { ...base.app, ...(c.app ?? {}) },
    connections: Array.isArray(c.connections) && c.connections.length ? c.connections : base.connections,
    enums: c.enums ?? [],
    tables: c.tables ?? [],
    views: c.views ?? [],
    forms: c.forms ?? [],
    menu: c.menu ?? [],
    actions: c.actions ?? [],
    triggers: c.triggers ?? [],
    reports: c.reports ?? [],
    dashboards: c.dashboards ?? [],
    printTemplates: c.printTemplates ?? [],
  };
}
