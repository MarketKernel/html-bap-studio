/**
 * Reading a configuration: lookups, the fields every record has, and what the
 * studio builds by itself when the configuration says nothing — the default
 * list view of a table, its automatic form (Task.md 8.4), the menu.
 */
import { t } from '../i18n';
import type { ColumnDef, Config, DetailDef, FieldDef, FormDef, FormNode, MenuNode, TableDef, ViewDef } from './types';

let counter = 0;
/** A short unique key for configuration objects: time + counter + random. */
export function newKey(prefix = 'k'): string {
  counter = (counter + 1) % 1296;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The constants live as the one record of a service table: lists, cards,
 * references and the sources treat it like any other, and nobody can name a
 * table of their own like it (names starting with '_' are the studio's).
 */
export const CONSTANTS = '_constants';
export const CONSTANTS_ID = 'constants';
const constantTables = new WeakMap<FieldDef[], TableDef>();

export function constantsTable(config: Config): TableDef | undefined {
  const fields = config.constants;
  if (!fields?.length) return undefined;
  let tb = constantTables.get(fields);
  if (!tb) {
    tb = { key: 'sys_constants', name: CONSTANTS, kind: 'table', title: t('model', 'Constants'), itemTitle: t('model', 'Constants'), icon: 'settings', fields };
    constantTables.set(fields, tb);
  }
  return tb;
}

/** No table: what expressions that belong to no record (a dashboard's, an action's of no table) are evaluated over. */
export const NOWHERE: TableDef = { key: '__nowhere', name: '__nowhere', kind: 'table', title: '', fields: [] };

export function table(config: Config, name: string | undefined): TableDef | undefined {
  if (name === CONSTANTS) return constantsTable(config);
  return name ? config.tables.find((tb) => tb.name === name) : undefined;
}

export function view(config: Config, name: string | undefined): ViewDef | undefined {
  return name ? config.views.find((v) => v.name === name) : undefined;
}

/** The fields every record of the kind has, besides those the configuration declares. */
export function systemFields(tb: TableDef): FieldDef[] {
  const out: FieldDef[] = [];
  if (tb.kind === 'document') {
    out.push(
      { key: 'sys_number', name: 'number', title: t('model', 'Number'), type: 'string', width: 110, list: true },
      { key: 'sys_date', name: 'date', title: t('model', 'Date'), type: 'datetime', width: 140, list: true, default: 'now()', required: true },
      { key: 'sys_posted', name: 'posted', title: t('model', 'Posted'), type: 'boolean', width: 70, list: true, readonly: true },
    );
  }
  if (tb.kind === 'register') {
    out.push(
      { key: 'sys_recorder', name: 'recorder', title: t('model', 'Recorder'), type: 'string', width: 160, list: true, readonly: true },
      { key: 'sys_rdate', name: 'date', title: t('model', 'Date'), type: 'datetime', width: 140, list: true },
      { key: 'sys_direction', name: 'direction', title: t('model', 'Direction'), type: 'enum', width: 90, list: true, options: [{ value: 'in', title: t('model', 'In') }, { value: 'out', title: t('model', 'Out') }] },
    );
  }
  if (tb.versioned) {
    out.push(
      { key: 'sys_series', name: 'seriesId', title: t('model', 'Series'), type: 'string', list: false, readonly: true },
      { key: 'sys_from', name: 'validFrom', title: t('model', 'In force from'), type: 'datetime', width: 140, list: false, readonly: true },
      { key: 'sys_to', name: 'validTo', title: t('model', 'In force until'), type: 'datetime', width: 140, list: false, readonly: true },
    );
  }
  if (tb.orderable) out.push({ key: 'sys_order', name: '_order', title: t('model', 'Order'), type: 'integer', width: 70, list: false, readonly: true });
  if (tb.hierarchical) {
    out.push(
      { key: 'sys_parent', name: 'parent', title: t('model', 'Group'), type: 'ref', ref: tb.name },
      { key: 'sys_folder', name: 'isFolder', title: t('model', 'Is a group'), type: 'boolean' },
    );
  }
  return out;
}

export const AUDIT_FIELDS: FieldDef[] = [
  { key: 'sys_created', name: '_createdAt', title: 'Created', type: 'datetime', readonly: true },
  { key: 'sys_createdBy', name: '_createdBy', title: 'Created by', type: 'string', readonly: true },
  { key: 'sys_updated', name: '_updatedAt', title: 'Changed', type: 'datetime', readonly: true },
  { key: 'sys_updatedBy', name: '_updatedBy', title: 'Changed by', type: 'string', readonly: true },
];

/** System fields first, then the declared ones. */
export function allFields(tb: TableDef): FieldDef[] {
  return [...systemFields(tb), ...tb.fields];
}

export function field(tb: TableDef, name: string): FieldDef | undefined {
  if (name === 'id') return { key: 'sys_id', name: 'id', title: 'ID', type: 'string', readonly: true };
  return allFields(tb).find((f) => f.name === name) ?? AUDIT_FIELDS.find((f) => f.name === name);
}

/** A field at the end of a path through references: 'product.category.name'. */
export function fieldAtPath(config: Config, tb: TableDef, path: string): { field: FieldDef; table: TableDef } | undefined {
  const parts = path.split('.');
  let current: TableDef | undefined = tb;
  for (let i = 0; i < parts.length; i++) {
    if (!current) return undefined;
    const f = field(current, parts[i]!);
    if (!f) return undefined;
    if (i === parts.length - 1) return { field: f, table: current };
    if (f.type !== 'ref') return undefined;
    current = table(config, f.ref);
  }
  return undefined;
}

export function fieldTitle(f: FieldDef): string {
  return f.title || f.name;
}

/** The field shown when a record of `tb` is referenced. */
export function displayField(tb: TableDef): string {
  if (tb.display && field(tb, tb.display)) return tb.display;
  if (tb.kind === 'document') return 'number';
  return tb.fields.find((f) => f.name === 'name')?.name ?? tb.fields.find((f) => f.type === 'string')?.name ?? 'id';
}

export function isNumeric(f: FieldDef): boolean {
  return f.type === 'integer' || f.type === 'decimal';
}

/** Tables whose fields reference `tb`, with the field: the default detail tabs. */
export function backReferences(config: Config, tb: TableDef): { table: TableDef; field: FieldDef }[] {
  const out: { table: TableDef; field: FieldDef }[] = [];
  for (const other of config.tables) {
    for (const f of other.fields) if (f.type === 'ref' && f.ref === tb.name && !(other.name === tb.name && f.name === 'parent')) out.push({ table: other, field: f });
  }
  return out;
}

export function defaultColumns(tb: TableDef): ColumnDef[] {
  const fields = allFields(tb).filter((f) => f.name !== 'isFolder' && f.name !== 'parent');
  const listed = fields.filter((f) => f.list !== false && f.type !== 'text' && f.type !== 'json' && f.type !== 'image' && f.type !== 'file');
  return listed.slice(0, 12).map((f) => ({ field: f.name, ...(f.width ? { width: f.width } : {}) }));
}

/** A version in force at `now` (validTo not yet reached); every record of a table that is not versioned. */
export function inForce(tb: TableDef, row: Record<string, unknown>, now: string): boolean {
  return !tb.versioned || row.validTo === null || row.validTo === undefined || row.validTo === '' || String(row.validTo) > now;
}

export function defaultDetails(config: Config, tb: TableDef): DetailDef[] {
  const out: DetailDef[] = [];
  if (tb.versioned) out.push({ key: 'd_versions', kind: 'versions', title: t('model', 'Versions') });
  for (const part of tb.parts ?? []) out.push({ key: `d_part_${part.key}`, kind: 'part', part: part.name, title: part.title ?? part.name });
  // A document's movements; a catalog's are among the register's back-references already.
  if (tb.kind === 'document' && tb.posting?.length) {
    for (const register of new Set(tb.posting.map((p) => p.register))) {
      const reg = table(config, register);
      if (reg) out.push({ key: `d_mov_${reg.key}`, kind: 'movements', table: reg.name, title: reg.title });
    }
  }
  // A table that refers here by two fields (an account, and the account a transfer goes to) gets a tab for each, named by the field.
  const refs = backReferences(config, tb);
  const twice = (name: string) => refs.filter((r) => r.table.name === name).length > 1;
  for (const { table: other, field: f } of refs) {
    if (other.kind === 'register') continue;
    out.push({ key: `d_ref_${other.key}_${f.key}`, kind: 'backref', table: other.name, field: f.name, title: twice(other.name) ? `${other.title}: ${f.title ?? f.name}` : other.title });
  }
  for (const { table: other, field: f } of backReferences(config, tb)) {
    if (other.kind !== 'register') continue;
    out.push({ key: `d_ref_${other.key}_${f.key}`, kind: 'backref', table: other.name, field: f.name, title: other.title });
  }
  return out;
}

/** The list view a table gets when the configuration has none for it. */
export function defaultView(config: Config, tb: TableDef): ViewDef {
  const sort = tb.orderable ? [{ field: '_order' }] : tb.kind === 'document' || tb.kind === 'register' ? [{ field: 'date', desc: true }] : [{ field: displayField(tb) }];
  return {
    key: `auto_view_${tb.key}`,
    name: tb.name,
    table: tb.name,
    title: tb.title,
    ...(tb.icon ? { icon: tb.icon } : {}),
    ...(tb.description ? { description: tb.description } : {}),
    columns: defaultColumns(tb),
    sort,
    details: defaultDetails(config, tb),
  };
}

/** The view a menu item or a table opens: the configured one, or the default. */
export function viewFor(config: Config, name: string): ViewDef | undefined {
  const v = view(config, name);
  if (v) return v;
  const tb = table(config, name);
  return tb ? defaultView(config, tb) : undefined;
}

/**
 * The automatic form: number and date of a document on top, then the fields
 * in two columns, then the parts and back-references as tabs (Task.md 8.4).
 */
export function defaultForm(config: Config, tb: TableDef): FormDef {
  const k = (s: string) => `auto_${tb.key}_${s}`;
  const top: FormNode[] = [];
  if (tb.kind === 'document') {
    top.push({ type: 'columns', key: k('head'), children: [{ type: 'field', key: k('f_number'), field: 'number' }, { type: 'field', key: k('f_date'), field: 'date' }] });
  }
  const own = tb.fields.filter((f) => f.type !== 'text');
  const texts = tb.fields.filter((f) => f.type === 'text');
  const fieldNode = (f: FieldDef): FormNode => ({ type: 'field', key: k(`f_${f.key}`), field: f.name });
  const half = Math.ceil(own.length / 2);
  const body: FormNode[] = [];
  if (tb.hierarchical) body.push({ type: 'field', key: k('f_parent'), field: 'parent' });
  if (own.length > 5) {
    body.push({
      type: 'columns',
      key: k('cols'),
      children: [
        { type: 'group', key: k('c1'), children: own.slice(0, half).map(fieldNode) },
        { type: 'group', key: k('c2'), children: own.slice(half).map(fieldNode) },
      ],
    });
  } else body.push(...own.map(fieldNode));
  body.push(...texts.map((f): FormNode => ({ type: 'field', key: k(`f_${f.key}`), field: f.name, label: 'top' })));
  const tabs: FormNode[] = [];
  for (const part of tb.parts ?? []) tabs.push({ type: 'tab', key: k(`t_${part.key}`), title: part.title ?? part.name, children: [{ type: 'part', key: k(`p_${part.key}`), part: part.name }] });
  for (const { table: other, field: f } of backReferences(config, tb)) {
    if (other.kind === 'register') continue;
    tabs.push({ type: 'tab', key: k(`r_${other.key}_${f.key}`), title: other.title, children: [{ type: 'related', key: k(`rel_${other.key}_${f.key}`), table: other.name, field: f.name }] });
  }
  const children: FormNode[] = [...top, ...body];
  if (tabs.length === 1 && (tb.parts ?? []).length === 1) children.push(...((tabs[0] as { children: FormNode[] }).children));
  else if (tabs.length) children.push({ type: 'tabs', key: k('tabs'), children: tabs });
  return { key: `auto_form_${tb.key}`, name: tb.name, table: tb.name, title: tb.itemTitle ?? tb.title, layout: { type: 'group', key: k('root'), children } };
}

export function formFor(config: Config, tb: TableDef, name?: string): FormDef {
  return (name ? config.forms.find((f) => f.name === name) : undefined) ?? config.forms.find((f) => f.table === tb.name) ?? defaultForm(config, tb);
}

/** Every field node in a form layout, in order. */
export function formFields(node: FormNode): string[] {
  if (node.type === 'field') return [node.field];
  if ('children' in node) return node.children.flatMap(formFields);
  return [];
}

/** A menu made of the tables, grouped by kind — for a configuration without one. */
export function defaultMenu(config: Config): MenuNode[] {
  const groups: [string, string, TableDef['kind']][] = [
    ['documents', t('model', 'Documents'), 'document'],
    ['catalogs', t('model', 'Catalogs'), 'catalog'],
    ['registers', t('model', 'Registers'), 'register'],
    ['tables', t('model', 'Tables'), 'table'],
  ];
  const out: MenuNode[] = [];
  for (const [key, title, kind] of groups) {
    const items = config.tables.filter((tb) => tb.kind === kind);
    if (!items.length) continue;
    out.push({ key: `auto_${key}`, title, children: items.map((tb) => ({ key: `auto_m_${tb.key}`, title: tb.title, ...(tb.icon ? { icon: tb.icon } : {}), target: { kind: 'table', name: tb.name } })) });
  }
  if (config.reports.length) {
    out.push({ key: 'auto_reports', title: t('model', 'Reports'), children: config.reports.map((r) => ({ key: `auto_r_${r.key}`, title: r.title, icon: r.icon ?? 'chart', target: { kind: 'report', name: r.name } })) });
  }
  return out;
}

export function menuOf(config: Config): MenuNode[] {
  return config.menu.length ? config.menu : defaultMenu(config);
}

/** The enum values a field offers: its own options or the named enum's. */
export function enumValues(config: Config, f: FieldDef) {
  if (f.options?.length) return f.options;
  return config.enums.find((e) => e.name === f.enum)?.values ?? [];
}

export function connectionOf(config: Config, tb: TableDef): string {
  return tb.connection && config.connections.some((c) => c.id === tb.connection) ? tb.connection : (config.connections[0]?.id ?? 'main');
}

/**
 * A shortcut as written in the configuration ('r', 'shift+n', 'Cmd+Alt+R'),
 * in one spelling: 'Ctrl+Alt+Shift+R'. Ctrl stands for ⌘ on a Mac as well.
 * Null when it is not one: a key is a letter, a digit or F1–F12.
 */
export function normalizeHotkey(text: string | undefined): string | null {
  if (!text) return null;
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set<string>();
  for (const p of parts) {
    const m = p.toLowerCase();
    if (m === 'ctrl' || m === 'control' || m === 'cmd' || m === 'meta' || m === '⌘') mods.add('Ctrl');
    else if (m === 'alt' || m === 'option' || m === '⌥') mods.add('Alt');
    else if (m === 'shift' || m === '⇧') mods.add('Shift');
    else return null;
  }
  const k = /^[a-z0-9]$/i.test(key) ? key.toUpperCase() : /^f([1-9]|1[0-2])$/i.test(key) ? key.toUpperCase() : null;
  if (!k) return null;
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), k].join('+');
}

export function cloneConfig(config: Config): Config {
  return structuredClone(config);
}
