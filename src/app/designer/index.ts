/**
 * The designer (Task.md 9): the configuration tree in the navigation, and the
 * page for each kind of object. Every change goes through Session.change(),
 * which checks it, applies the schema change to the sources and saves a
 * revision — so undo and redo cover everything done here.
 *
 * Objects without a dedicated designer yet open in the JSON editor, which
 * checks what is typed before applying it.
 */
import { t } from '../../core/i18n';
import { CONSTANTS, menuOf, newKey, table as tableOf, defaultView, defaultForm, IDENT } from '../../core/config/model';
import type { Config, TableDef, TableKind } from '../../core/config/types';
import { migrate, validateConfig, type ConfigProblem } from '../../core/config/validate';
import { schemaDiff, destructive } from '../../core/config/diff';
import { button, clear, download, h, icon, pickFile } from '../dom';
import { alertDialog, confirm, dialog, popupMenu, prompt, toast, type MenuItem } from '../ui';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { CONSTANTS_KEY, TableDesigner } from './table';
import { FormDesigner } from './form';
import { ViewDesigner } from './view';
import { ActionDesigner } from './action';
import { MenuDesigner } from './menu';
import { ReportDesigner } from './report';
import { DiagramPage } from './diagram';
import { ConnectionsPage } from './connections';

export type DesignerTarget =
  | { kind: 'overview' }
  | { kind: 'table'; name: string; field?: string }
  | { kind: 'constants' }
  | { kind: 'newTable'; tableKind?: TableKind }
  | { kind: 'view'; name: string }
  | { kind: 'form'; name: string }
  | { kind: 'action'; name: string }
  | { kind: 'trigger'; key: string }
  | { kind: 'report'; name: string }
  | { kind: 'dashboard'; name: string }
  | { kind: 'print'; name: string }
  | { kind: 'enum'; name: string }
  | { kind: 'menu' }
  | { kind: 'connections' }
  | { kind: 'diagram' }
  | { kind: 'export' }
  | { kind: 'json'; section: JsonSection; key: string };

type JsonSection = 'views' | 'forms' | 'actions' | 'triggers' | 'reports' | 'dashboards' | 'printTemplates' | 'enums' | 'tables';

export function openDesigner(shell: Shell, target: DesignerTarget): void {
  const config = shell.session.config;
  const open = (id: string, make: () => Page) => {
    const existing = (shell as unknown as { pages: Page[] }).pages.find((p) => p.id === id);
    if (existing) shell.openPage(existing);
    else shell.openPage(make());
  };
  switch (target.kind) {
    case 'overview':
      return open('design:overview', () => new Overview(shell));
    case 'table': {
      if (!tableOf(config, target.name)) return;
      const id = `design:table:${tableOf(config, target.name)!.key}`;
      const existing = (shell as unknown as { pages: Page[] }).pages.find((p) => p.id === id) as TableDesigner | undefined;
      if (existing) {
        shell.openPage(existing);
        if (target.field) existing.focusField(target.field);
      } else shell.openPage(new TableDesigner(shell, target.name, target.field));
      return;
    }
    case 'constants':
      return open(`design:table:${CONSTANTS_KEY}`, () => new TableDesigner(shell, CONSTANTS));
    case 'newTable':
      return void newTable(shell, target.tableKind);
    case 'view': {
      const v = config.views.find((x) => x.name === target.name);
      if (v) return open(`design:view:${v.key}`, () => new ViewDesigner(shell, v.key));
      const tb = tableOf(config, target.name);
      if (tb) return void createView(shell, tb);
      return;
    }
    case 'form': {
      const f = config.forms.find((x) => x.name === target.name);
      if (f) return open(`design:form:${f.key}`, () => new FormDesigner(shell, f.key));
      const tb = tableOf(config, target.name);
      if (tb) return void createForm(shell, tb);
      return;
    }
    case 'action': {
      const a = config.actions.find((x) => x.name === target.name);
      if (a) return open(`design:action:${a.key}`, () => new ActionDesigner(shell, 'action', a.key));
      return;
    }
    case 'trigger': {
      const tr = config.triggers.find((x) => x.key === target.key);
      if (tr) return open(`design:trigger:${tr.key}`, () => new ActionDesigner(shell, 'trigger', tr.key));
      return;
    }
    case 'report': {
      const r = config.reports.find((x) => x.name === target.name);
      if (r) return open(`design:report:${r.key}`, () => new ReportDesigner(shell, r.key));
      return;
    }
    case 'menu':
      return open('design:menu', () => new MenuDesigner(shell));
    case 'connections':
      return open('design:connections', () => new ConnectionsPage(shell));
    case 'diagram':
      return open('design:diagram', () => new DiagramPage(shell));
    case 'export':
      return void exportImport(shell);
    case 'dashboard': {
      const d = config.dashboards.find((x) => x.name === target.name);
      if (d) return open(`design:json:dashboards:${d.key}`, () => new JsonEditor(shell, 'dashboards', d.key));
      return;
    }
    case 'print': {
      const p = config.printTemplates.find((x) => x.name === target.name);
      if (p) return open(`design:json:printTemplates:${p.key}`, () => new JsonEditor(shell, 'printTemplates', p.key));
      return;
    }
    case 'enum': {
      const e = config.enums.find((x) => x.name === target.name);
      if (e) return open(`design:json:enums:${e.key}`, () => new JsonEditor(shell, 'enums', e.key));
      return;
    }
    case 'json':
      return open(`design:json:${target.section}:${target.key}`, () => new JsonEditor(shell, target.section, target.key));
  }
}

/* ------------------------------------------------------------------ *
 * The configuration tree
 * ------------------------------------------------------------------ */

export function designerTree(shell: Shell, filter: string): Node[] {
  const config = shell.session.config;
  const out: Node[] = [];
  const section = (title: string, iconName: string, add: (() => void) | null, items: { label: string; icon: string; open: () => void; menu?: () => MenuItem[]; badge?: string }[], key: string) => {
    const shown = items.filter((i) => !filter || i.label.toLocaleLowerCase().includes(filter));
    if (filter && !shown.length) return;
    const head = h('div', { class: 'tree-item section', 'data-section': key }, h('span', { class: 'twisty' }), icon(iconName, 14), h('span', { class: 'label' }, title), h('span', { class: 'badge' }, String(items.length)));
    if (add) {
      const plus = h('button', { type: 'button', class: 'btn icon-only', style: { width: '20px', height: '20px' }, title: t('designer', 'Create'), 'data-add': key, onclick: (e: MouseEvent) => (e.stopPropagation(), add()) }, icon('plus', 12));
      head.appendChild(plus);
    }
    out.push(head);
    for (const item of shown) {
      const row = h('div', { class: 'tree-item', style: { ['--depth' as string]: '1' } as Partial<CSSStyleDeclaration>, tabindex: 0, 'data-design': `${key}:${item.label}` }, h('span', { class: 'twisty' }), icon(item.icon), h('span', { class: 'label' }, item.label), item.badge ? h('span', { class: 'badge' }, item.badge) : null);
      row.addEventListener('click', item.open);
      row.addEventListener('keydown', (e) => e.key === 'Enter' && item.open());
      if (item.menu) {
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          popupMenu({ x: e.clientX, y: e.clientY }, item.menu!());
        });
      }
      out.push(row);
    }
  };
  out.push(
    (() => {
      const row = h('div', { class: 'tree-item', 'data-design': 'overview' }, h('span', { class: 'twisty' }), icon('home'), h('span', { class: 'label' }, t('designer', 'Overview and problems')));
      row.addEventListener('click', () => openDesigner(shell, { kind: 'overview' }));
      return row;
    })(),
    (() => {
      const row = h('div', { class: 'tree-item' }, h('span', { class: 'twisty' }), icon('diagram'), h('span', { class: 'label' }, t('designer', 'Schema diagram')));
      row.addEventListener('click', () => openDesigner(shell, { kind: 'diagram' }));
      return row;
    })(),
  );
  const tableMenu = (tb: TableDef): MenuItem[] => [
    { label: t('designer', 'Open the designer'), icon: 'wrench', run: () => openDesigner(shell, { kind: 'table', name: tb.name }) },
    { label: t('designer', 'Open the data'), icon: 'table', run: () => shell.openTarget({ kind: 'table', name: tb.name }) },
    { label: t('designer', 'Design its form'), icon: 'form', run: () => openDesigner(shell, { kind: 'form', name: config.forms.find((f) => f.table === tb.name)?.name ?? tb.name }) },
    { label: t('designer', 'New view of it'), icon: 'list', run: () => void createView(shell, tb) },
    { separator: true },
    { label: t('designer', 'Delete the table'), icon: 'trash', run: () => void deleteTable(shell, tb) },
  ];
  const kinds: [TableKind, string, string][] = [
    ['catalog', t('designer', 'Catalogs'), 'list'],
    ['document', t('designer', 'Documents'), 'doc'],
    ['register', t('designer', 'Registers'), 'boxes'],
    ['table', t('designer', 'Tables'), 'table'],
  ];
  for (const [kind, title, ic] of kinds) {
    section(title, ic, () => void newTable(shell, kind), config.tables.filter((tb) => tb.kind === kind).map((tb) => ({ label: tb.title, icon: tb.icon ?? ic, open: () => openDesigner(shell, { kind: 'table', name: tb.name }), menu: () => tableMenu(tb), badge: tb.name })), `tables-${kind}`);
  }
  section(t('designer', 'Constants'), 'settings', null, [{ label: t('designer', 'Constants of the application'), icon: 'settings', open: () => openDesigner(shell, { kind: 'constants' }), badge: String((config.constants ?? []).length) }], 'constants');
  section(t('designer', 'Enumerations'), 'list', () => void createEnum(shell), config.enums.map((e) => ({ label: e.title ?? e.name, icon: 'list', open: () => openDesigner(shell, { kind: 'enum', name: e.name }) })), 'enums');
  section(t('designer', 'Views'), 'columns', null, config.views.map((v) => ({ label: v.title, icon: v.icon ?? 'columns', open: () => openDesigner(shell, { kind: 'view', name: v.name }), badge: v.table })), 'views');
  section(t('designer', 'Forms'), 'form', null, config.forms.map((f) => ({ label: f.title ?? f.name, icon: 'form', open: () => openDesigner(shell, { kind: 'form', name: f.name }), badge: f.table })), 'forms');
  section(t('designer', 'Actions'), 'bolt', () => void createAction(shell), config.actions.map((a) => ({ label: a.title, icon: a.icon ?? 'bolt', open: () => openDesigner(shell, { kind: 'action', name: a.name }), badge: a.table ?? '' })), 'actions');
  section(t('designer', 'Triggers'), 'history', () => void createTrigger(shell), config.triggers.map((tr) => ({ label: tr.description ?? `${tr.table}: ${tr.event}`, icon: 'history', open: () => openDesigner(shell, { kind: 'trigger', key: tr.key }), badge: tr.table })), 'triggers');
  section(t('designer', 'Reports'), 'chart', () => void createReport(shell), config.reports.map((r) => ({ label: r.title, icon: r.icon ?? 'chart', open: () => openDesigner(shell, { kind: 'report', name: r.name }) })), 'reports');
  section(t('designer', 'Dashboards'), 'dashboard', null, config.dashboards.map((d) => ({ label: d.title, icon: 'dashboard', open: () => openDesigner(shell, { kind: 'dashboard', name: d.name }) })), 'dashboards');
  section(t('designer', 'Print templates'), 'print', null, config.printTemplates.map((p) => ({ label: p.title, icon: 'print', open: () => openDesigner(shell, { kind: 'print', name: p.name }), badge: p.table })), 'print');
  section(t('designer', 'Menu'), 'menu', null, [{ label: t('designer', 'Navigation menu'), icon: 'menu', open: () => openDesigner(shell, { kind: 'menu' }) }], 'menu');
  section(t('designer', 'Connections'), 'plug', null, config.connections.map((c) => ({ label: c.title ?? c.id, icon: 'database', open: () => openDesigner(shell, { kind: 'connections' }), badge: c.plugin })), 'connections');
  return out;
}

/* ------------------------------------------------------------------ *
 * Creating and deleting objects
 * ------------------------------------------------------------------ */

function uniqueName(existing: string[], base: string): string {
  let name = base;
  let n = 2;
  while (existing.includes(name)) name = `${base}${n++}`;
  return name;
}

/** Latin identifier from any title: 'Товары на складе' → 'TovaryNaSklade'. */
export function identFrom(title: string, upper = true): string {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'ye', ё: 'yo', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'yi', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const latin = [...title.toLocaleLowerCase()].map((c) => map[c] ?? c).join('');
  const words = latin.split(/[^a-z0-9]+/).filter(Boolean);
  let ident = words.map((w, i) => (i === 0 && !upper ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  if (!ident || /^\d/.test(ident)) ident = `${upper ? 'T' : 'f'}${ident}`;
  return ident;
}

async function newTable(shell: Shell, kind: TableKind = 'catalog'): Promise<void> {
  const title = h('input', { class: 'input', placeholder: t('designer', 'Products, Invoices, Employees…'), 'data-new': 'title' });
  const name = h('input', { class: 'input mono', 'data-new': 'name' });
  const kindSel = h(
    'select',
    { class: 'input', 'data-new': 'kind' },
    h('option', { value: 'catalog' }, t('designer', 'Catalog — a list of things: products, customers')),
    h('option', { value: 'document' }, t('designer', 'Document — an event with a number and date: an invoice')),
    h('option', { value: 'register' }, t('designer', 'Register — movements that sum up to balances')),
    h('option', { value: 'table' }, t('designer', 'Plain table')),
  );
  kindSel.value = kind;
  let touched = false;
  title.addEventListener('input', () => {
    if (!touched) name.value = identFrom(title.value);
  });
  name.addEventListener('input', () => (touched = true));
  const menuBox = h('input', { type: 'checkbox', checked: true });
  const error = h('div', { class: 'field-error' });
  const ok = await dialog({
    title: t('designer', 'New table'),
    body: h(
      'div',
      { style: { minWidth: '480px' } },
      h('div', { class: 'f-field' }, h('label', null, t('designer', 'Title')), title),
      h('div', { class: 'f-field' }, h('label', null, t('designer', 'Name')), name),
      h('div', { class: 'f-field' }, h('label', null, t('designer', 'Kind')), kindSel),
      h('label', { class: 'row', style: { marginTop: '6px' } }, menuBox, t('designer', 'Add it to the menu')),
      error,
    ),
    buttons: [
      { label: t('dialog', 'Cancel'), value: false },
      {
        label: t('designer', 'Create'),
        value: true,
        primary: true,
        check: () => {
          const n = name.value.trim();
          if (!title.value.trim()) error.textContent = t('designer', 'Give it a title');
          else if (!IDENT.test(n)) error.textContent = t('designer', 'The name must be a Latin identifier: letters, digits, _');
          else if (tableOf(shell.session.config, n)) error.textContent = t('designer', 'There is already a table named “{name}”', { name: n });
          else return true;
          return false;
        },
      },
    ],
    cancel: false,
  });
  if (!ok) return;
  const k = kindSel.value as TableKind;
  const tb: TableDef = {
    key: newKey('t'),
    name: name.value.trim(),
    kind: k,
    title: title.value.trim(),
    icon: k === 'document' ? 'doc' : k === 'register' ? 'boxes' : 'list',
    fields:
      k === 'register'
        ? [
            { key: newKey('f'), name: 'item', title: t('designer', 'Item'), type: 'string', role: 'dimension' },
            { key: newKey('f'), name: 'qty', title: t('designer', 'Quantity'), type: 'decimal', scale: 3, role: 'resource' },
          ]
        : k === 'document'
          ? [{ key: newKey('f'), name: 'comment', title: t('designer', 'Comment'), type: 'string' }]
          : [{ key: newKey('f'), name: 'name', title: t('designer', 'Name'), type: 'string', required: true }],
    ...(k === 'document' ? { numbering: { sequence: name.value.trim(), format: '{000000}' } } : {}),
  };
  try {
    await shell.session.change((c) => {
      c.tables.push(tb);
      if (menuBox.checked && c.menu.length) {
        const item = { key: newKey('m'), title: tb.title, icon: tb.icon ?? 'table', target: { kind: 'table' as const, name: tb.name } };
        const group = c.menu.find((m) => m.children) ?? null;
        if (group) group.children!.push(item);
        else c.menu.push(item);
      }
    });
    toast(t('designer', 'Table “{title}” created', { title: tb.title }), 'ok');
    openDesigner(shell, { kind: 'table', name: tb.name });
  } catch (error) {
    shell.fail(error);
  }
}

async function deleteTable(shell: Shell, tb: TableDef): Promise<void> {
  const config = shell.session.config;
  const users = config.tables.filter((x) => x.fields.some((f) => f.ref === tb.name) || x.parts?.some((p) => p.fields.some((f) => f.ref === tb.name)) || x.posting?.some((p) => p.register === tb.name));
  if (users.length) return alertDialog(t('designer', 'Cannot delete'), t('designer', '“{title}” is used by: {users}', { title: tb.title, users: users.map((u) => u.title).join(', ') }));
  if (!(await confirm(t('designer', 'Delete the table'), t('designer', 'Delete “{title}” with all its records? This cannot be undone.', { title: tb.title }), t('designer', 'Delete'), true))) return;
  await shell.session
    .change((c) => {
      c.tables = c.tables.filter((x) => x.key !== tb.key);
      c.views = c.views.filter((v) => v.table !== tb.name);
      c.forms = c.forms.filter((f) => f.table !== tb.name);
      c.actions = c.actions.filter((a) => a.table !== tb.name);
      c.triggers = c.triggers.filter((x) => x.table !== tb.name);
      c.printTemplates = c.printTemplates.filter((p) => p.table !== tb.name);
      const strip = (nodes: Config['menu']): Config['menu'] => nodes.filter((n) => !(n.target && 'name' in n.target && n.target.name === tb.name)).map((n) => (n.children ? { ...n, children: strip(n.children) } : n));
      c.menu = strip(c.menu);
    })
    .catch((e: unknown) => shell.fail(e));
}

export async function createView(shell: Shell, tb: TableDef): Promise<void> {
  const title = await prompt(t('designer', 'New view of “{table}”', { table: tb.title }), t('designer', 'Title'), tb.title);
  if (!title) return;
  const config = shell.session.config;
  const view = { ...defaultView(config, tb), key: newKey('v'), name: uniqueName([...config.views.map((v) => v.name), ...config.tables.map((x) => x.name)], `${tb.name}${identFrom(title)}`), title };
  await shell.session.change((c) => c.views.push(view)).catch((e: unknown) => shell.fail(e));
  openDesigner(shell, { kind: 'view', name: view.name });
}

export async function createForm(shell: Shell, tb: TableDef): Promise<void> {
  const config = shell.session.config;
  const form = { ...defaultForm(config, tb), key: newKey('fm'), name: uniqueName(config.forms.map((f) => f.name), `${tb.name}Form`) };
  // The automatic form's element keys are derived from the table; a stored copy gets its own.
  const rekey = (n: import('../../core/config/types').FormNode): import('../../core/config/types').FormNode => ({ ...n, key: newKey('e'), ...('children' in n ? { children: n.children.map(rekey) } : {}) }) as import('../../core/config/types').FormNode;
  form.layout = rekey(form.layout);
  await shell.session.change((c) => c.forms.push(form)).catch((e: unknown) => shell.fail(e));
  openDesigner(shell, { kind: 'form', name: form.name });
}

async function createEnum(shell: Shell): Promise<void> {
  const title = await prompt(t('designer', 'New enumeration'), t('designer', 'Title'), '');
  if (!title) return;
  const e = { key: newKey('e'), name: uniqueName(shell.session.config.enums.map((x) => x.name), identFrom(title)), title, values: [{ value: 'a', title: 'A' }] };
  await shell.session.change((c) => c.enums.push(e)).catch((err: unknown) => shell.fail(err));
  openDesigner(shell, { kind: 'enum', name: e.name });
}

async function createAction(shell: Shell): Promise<void> {
  const title = await prompt(t('designer', 'New action'), t('designer', 'Title'), '');
  if (!title) return;
  const a = { key: newKey('a'), name: uniqueName(shell.session.config.actions.map((x) => x.name), identFrom(title)), title, steps: [{ type: 'message' as const, text: t('designer', 'Hello!') }], where: ['list' as const, 'card' as const] };
  await shell.session.change((c) => c.actions.push(a)).catch((err: unknown) => shell.fail(err));
  openDesigner(shell, { kind: 'action', name: a.name });
}

async function createTrigger(shell: Shell): Promise<void> {
  const tb = shell.session.config.tables[0];
  if (!tb) return alertDialog(t('designer', 'New trigger'), t('designer', 'Create a table first'));
  const tr = { key: newKey('tr'), table: tb.name, event: 'beforeSave' as const, steps: [], description: t('designer', 'New trigger') };
  await shell.session.change((c) => c.triggers.push(tr)).catch((err: unknown) => shell.fail(err));
  openDesigner(shell, { kind: 'trigger', key: tr.key });
}

async function createReport(shell: Shell): Promise<void> {
  const tb = shell.session.config.tables[0];
  if (!tb) return alertDialog(t('designer', 'New report'), t('designer', 'Create a table first'));
  const title = await prompt(t('designer', 'New report'), t('designer', 'Title'), '');
  if (!title) return;
  const r = { key: newKey('r'), name: uniqueName(shell.session.config.reports.map((x) => x.name), identFrom(title)), title, source: tb.name, groupBy: [], measures: [{ name: 'count', fn: 'count' as const, title: t('designer', 'Count') }] };
  await shell.session.change((c) => c.reports.push(r)).catch((err: unknown) => shell.fail(err));
  openDesigner(shell, { kind: 'report', name: r.name });
}

/* ------------------------------------------------------------------ *
 * Overview, export and import, the JSON editor
 * ------------------------------------------------------------------ */

class Overview implements Page {
  readonly id = 'design:overview';
  title = t('designer', 'Designer');
  icon = 'wrench';
  readonly el: HTMLElement;
  private body: HTMLElement;
  constructor(private readonly shell: Shell) {
    this.body = h('div', { class: 'card-body' });
    this.el = h('div', { class: 'page' }, h('div', { class: 'toolbar' }, h('span', { class: 'page-title' }, t('designer', 'Designer')), h('span', { class: 'spacer' })), this.body);
    this.render();
  }
  configChanged(): void {
    this.render();
  }
  private render(): void {
    const config = this.shell.session.config;
    const problems: ConfigProblem[] = validateConfig(config);
    const count = (n: number, label: string) => h('div', { class: 'widget', style: { minHeight: '84px' } }, h('h4', null, label), h('div', { class: 'kpi' }, String(n)));
    const nameInput = h('input', { class: 'input', value: config.app.name, style: { maxWidth: '360px' } });
    nameInput.addEventListener('change', () => void this.shell.session.change((c) => (c.app.name = nameInput.value.trim() || c.app.name)).catch((e: unknown) => this.shell.fail(e)));
    clear(
      this.body,
      h('div', { class: 'f-field', style: { maxWidth: '560px' } }, h('label', null, t('designer', 'Application name')), nameInput),
      h(
        'div',
        { class: 'dash-grid', style: { gridAutoRows: 'auto', marginBottom: '16px' } },
        h('div', { style: { gridColumn: 'span 3' } }, count(config.tables.length, t('designer', 'Tables'))),
        h('div', { style: { gridColumn: 'span 3' } }, count(config.views.length + config.forms.length, t('designer', 'Views and forms'))),
        h('div', { style: { gridColumn: 'span 3' } }, count(config.actions.length + config.triggers.length, t('designer', 'Actions and triggers'))),
        h('div', { style: { gridColumn: 'span 3' } }, count(config.reports.length + config.dashboards.length, t('designer', 'Reports and dashboards'))),
      ),
      h(
        'div',
        { class: 'f-buttons' },
        button(t('designer', 'New table'), { icon: 'plus', class: 'primary', onClick: () => void newTable(this.shell) }),
        button(t('designer', 'Schema diagram'), { icon: 'diagram', class: 'outline', onClick: () => openDesigner(this.shell, { kind: 'diagram' }) }),
        button(t('designer', 'Menu'), { icon: 'menu', class: 'outline', onClick: () => openDesigner(this.shell, { kind: 'menu' }) }),
        button(t('designer', 'Connections'), { icon: 'plug', class: 'outline', onClick: () => openDesigner(this.shell, { kind: 'connections' }) }),
        button(t('designer', 'Export / import'), { icon: 'download', class: 'outline', onClick: () => void exportImport(this.shell) }),
      ),
      h('h3', { style: { fontSize: '13px', margin: '18px 0 6px' } }, problems.length ? t('designer', 'Problems ({n})', { n: problems.length }) : t('designer', 'No problems found')),
      h(
        'div',
        { class: 'problems', style: { maxHeight: 'none', border: '1px solid var(--border)', borderRadius: '8px' } },
        problems.map((p) => {
          const row = h('div', { class: 'problem' }, icon('warning'), h('span', { class: 'muted mono' }, p.at), h('span', null, p.message));
          row.addEventListener('click', () => {
            const m = /^table:([^/]+)(?:\/field:(.+))?/.exec(p.at);
            if (m) openDesigner(this.shell, { kind: 'table', name: m[1]!, ...(m[2] ? { field: m[2] } : {}) });
            const v = /^view:(.+)/.exec(p.at);
            if (v) openDesigner(this.shell, { kind: 'view', name: v[1]! });
            const a = /^action:(.+)/.exec(p.at);
            if (a) openDesigner(this.shell, { kind: 'action', name: a[1]! });
          });
          return row;
        }),
      ),
      h('p', { class: 'muted', style: { marginTop: '18px', fontSize: '12px' } }, t('designer', 'Changes apply at once and are saved as a new revision. Ctrl+Z undoes them. F12 switches between the Designer and the Application. In the Application, right-click a column header to change its field.')),
    );
    void menuOf;
  }
}

async function exportImport(shell: Shell): Promise<void> {
  const choice = await dialog<'export' | 'import' | 'backup' | null>({
    title: t('designer', 'Export and import'),
    body: h('div', { style: { maxWidth: '520px' } }, h('p', null, t('designer', 'The configuration is the application’s description, without data. Secrets of connections are never exported. A backup holds the configuration and every record.'))),
    buttons: [
      { label: t('designer', 'Import a configuration…'), value: 'import', left: true },
      { label: t('designer', 'Backup with data'), value: 'backup' },
      { label: t('designer', 'Export the configuration'), value: 'export', primary: true },
    ],
    cancel: null,
  });
  const config = shell.session.config;
  if (choice === 'export') {
    download(new Blob([JSON.stringify({ ...config, connections: config.connections.map((c) => ({ ...c, settings: {} })) }, null, 2)], { type: 'application/json' }), `${identFrom(config.app.name)}.config.json`);
  } else if (choice === 'backup') {
    const data: Record<string, unknown[]> = {};
    for (const tb of config.tables) data[tb.name] = await shell.data.all(tb.name).catch(() => []);
    download(new Blob([JSON.stringify({ bap: 'backup', version: 1, config, data }, null, 1)], { type: 'application/json' }), `${identFrom(config.app.name)}.bap.json`);
  } else if (choice === 'import') {
    const [file] = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as { bap?: string; config?: unknown; data?: Record<string, unknown[]> };
      const next = migrate(raw.bap === 'backup' ? raw.config : raw);
      const changes = schemaDiff(config, next);
      const lost = destructive(changes);
      const text = [t('designer', 'Replace the configuration with “{name}”?', { name: next.app.name }), changes.length ? t('designer', '{n} schema changes.', { n: changes.length }) : '', lost.length ? t('designer', 'Data will be lost: {what}', { what: lost.map((c) => ('table' in c ? c.table : '') + ('field' in c ? `.${c.field}` : '')).join(', ') }) : '', raw.bap === 'backup' ? t('designer', 'The records from the backup will be added.') : ''].filter(Boolean).join('\n');
      if (!(await confirm(t('designer', 'Import'), text, t('designer', 'Import'), lost.length > 0))) return;
      next.connections = config.connections;
      await shell.session.change((c) => Object.assign(c, next));
      if (raw.bap === 'backup' && raw.data) {
        for (const [name, rows] of Object.entries(raw.data)) {
          if (!tableOf(next, name)) continue;
          const ops = (rows as { id: string }[]).map((row) => ({ op: 'insert' as const, table: name, row: { ...row, _rev: undefined } as import('../../core/query/types').Row }));
          for (let i = 0; i < ops.length; i += 500) await shell.data.writeBatch(ops.slice(i, i + 500)).catch((e: unknown) => shell.fail(e, name));
        }
      }
      toast(t('designer', 'Imported'), 'ok');
    } catch (error) {
      shell.fail(error, file.name);
    }
  }
}

/** Any configuration object as JSON: checked on applying, with the problems it would make shown first. */
class JsonEditor implements Page {
  readonly id: string;
  title: string;
  icon = 'doc';
  readonly el: HTMLElement;
  private area: HTMLTextAreaElement;
  private error: HTMLElement;
  constructor(
    private readonly shell: Shell,
    private readonly section: JsonSection,
    private readonly key: string,
  ) {
    this.id = `design:json:${section}:${key}`;
    const obj = this.object();
    this.title = (obj as { title?: string; name?: string } | undefined)?.title ?? (obj as { name?: string } | undefined)?.name ?? key;
    this.area = h('textarea', { class: 'input code', spellcheck: 'false', style: { flex: '1', resize: 'none', border: '0', borderRadius: '0', padding: '12px' } });
    this.area.value = JSON.stringify(obj, null, 2);
    this.error = h('div', { class: 'field-error', style: { padding: '0 10px' } });
    this.el = h(
      'div',
      { class: 'page' },
      h('div', { class: 'toolbar' }, button(t('designer', 'Apply'), { icon: 'check', class: 'primary', onClick: () => void this.apply() }), button(t('designer', 'Revert'), { icon: 'undo', onClick: () => (this.area.value = JSON.stringify(this.object(), null, 2)) }), h('span', { class: 'spacer' }), h('span', { class: 'muted', style: { fontSize: '12px' } }, t('designer', 'JSON of {what}', { what: section }))),
      this.error,
      this.area,
    );
  }
  private object(): unknown {
    return (this.shell.session.config[this.section] as { key: string }[]).find((o) => o.key === this.key);
  }
  dirty(): boolean {
    return this.area.value !== JSON.stringify(this.object(), null, 2);
  }
  onKey(e: KeyboardEvent): boolean {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      void this.apply();
      return true;
    }
    return false;
  }
  private async apply(): Promise<void> {
    let value: { key?: string };
    try {
      value = JSON.parse(this.area.value) as { key?: string };
    } catch (error) {
      this.error.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    value.key = this.key;
    const draft = structuredClone(this.shell.session.config);
    const list = draft[this.section] as { key: string }[];
    const at = list.findIndex((o) => o.key === this.key);
    if (at < 0) return;
    list[at] = value as { key: string };
    const before = validateConfig(this.shell.session.config).length;
    const after = validateConfig(draft);
    if (after.length > before && !(await confirm(t('designer', 'Problems'), after.slice(0, 8).map((p) => `${p.at}: ${p.message}`).join('\n'), t('designer', 'Apply anyway')))) return;
    this.error.textContent = '';
    await this.shell.session
      .change((c) => {
        (c[this.section] as { key: string }[])[at] = value as { key: string };
      })
      .then(() => toast(t('designer', 'Applied'), 'ok'))
      .catch((e: unknown) => this.shell.fail(e));
  }
}

export { uniqueName };
