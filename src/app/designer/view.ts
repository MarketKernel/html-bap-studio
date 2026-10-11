/**
 * The view designer (Task.md 9.2): what a list shows of its table — columns
 * (with paths through references), the stored filter and sort, the default
 * grouping, conditional formatting, the toolbar's actions and the detail tabs —
 * with a live list of the real data under it.
 *
 * Every edit is one Session.change(); the preview is a real ListPage rebuilt
 * after each change, so what is seen here is what the application shows.
 */
import { t } from '../../core/i18n';
import { allFields, defaultDetails, enumValues, fieldAtPath, fieldTitle, isNumeric, newKey, table as tableOf, IDENT } from '../../core/config/model';
import type { ColumnDef, Config, DetailDef, FieldDef, FormatRule, MenuNode, Step, TableDef, ViewDef } from '../../core/config/types';
import type { AggregateFn, Condition, Filter, FilterOp } from '../../core/query/types';
import { button, clear, h, icon } from '../dom';
import { confirm, toast } from '../ui';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { ListPage } from '../pages/list';
import { checkProp, exprProp, iconProp, numberProp, section, selectProp, textProp } from './props';

type Tab = 'columns' | 'filter' | 'rules' | 'actions' | 'details';

const OPS: FilterOp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'notIn', 'between', 'isNull', 'isNotNull'];

function opTitle(op: FilterOp): string {
  switch (op) {
    case 'eq':
      return t('viewDesigner', 'equals');
    case 'ne':
      return t('viewDesigner', 'does not equal');
    case 'lt':
      return t('viewDesigner', 'less than');
    case 'le':
      return t('viewDesigner', 'at most');
    case 'gt':
      return t('viewDesigner', 'greater than');
    case 'ge':
      return t('viewDesigner', 'at least');
    case 'contains':
      return t('viewDesigner', 'contains');
    case 'notContains':
      return t('viewDesigner', 'does not contain');
    case 'startsWith':
      return t('viewDesigner', 'starts with');
    case 'endsWith':
      return t('viewDesigner', 'ends with');
    case 'in':
      return t('viewDesigner', 'is one of');
    case 'notIn':
      return t('viewDesigner', 'is none of');
    case 'between':
      return t('viewDesigner', 'between');
    case 'isNull':
      return t('viewDesigner', 'is empty');
    case 'isNotNull':
      return t('viewDesigner', 'is not empty');
  }
}

function totalOptions(): [AggregateFn | '', string][] {
  return [
    ['', t('viewDesigner', 'none')],
    ['sum', t('viewDesigner', 'Sum')],
    ['count', t('viewDesigner', 'Count')],
    ['avg', t('viewDesigner', 'Average')],
    ['min', t('viewDesigner', 'Minimum')],
    ['max', t('viewDesigner', 'Maximum')],
  ];
}

/** The stored filter as an AND list of conditions; null when it is shaped otherwise (OR, NOT, nesting). */
function conditionsOf(filter: Filter | undefined): Condition[] | null {
  if (!filter) return [];
  if ('field' in filter) return [filter];
  if ('and' in filter && filter.and.every((f) => 'field' in f)) return filter.and as Condition[];
  return null;
}

function filterOf(list: Condition[]): Filter | undefined {
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  return { and: list };
}

/** The view's fields and one level of paths through references: 'customer.name'. */
function fieldOptions(config: Config, tb: TableDef): [string, string][] {
  const own = allFields(tb);
  const out: [string, string][] = own.map((f) => [f.name, fieldTitle(f)]);
  for (const f of own) {
    if (f.type !== 'ref') continue;
    const target = tableOf(config, f.ref);
    if (!target) continue;
    for (const sub of allFields(target)) out.push([`${f.name}.${sub.name}`, `${fieldTitle(f)} → ${fieldTitle(sub)}`]);
  }
  return out;
}

function pathTitle(config: Config, tb: TableDef, path: string): string | null {
  const parts = path.split('.');
  const titles: string[] = [];
  let current: TableDef | undefined = tb;
  for (const part of parts) {
    if (!current) return null;
    const found = fieldAtPath(config, current, part);
    if (!found) return null;
    titles.push(fieldTitle(found.field));
    current = found.field.type === 'ref' ? tableOf(config, found.field.ref) : undefined;
  }
  return titles.join(' → ');
}

/** A colour, or none: the native picker plus a "none" box. */
function colorProp(label: string, value: string | undefined, set: (v: string | undefined) => void): HTMLElement {
  const picker = h('input', { type: 'color', class: 'vd-color-input', value: value ?? '#ffffff' });
  picker.dataset.prop = label;
  const none = h('input', { type: 'checkbox' });
  none.checked = !value;
  picker.classList.toggle('unset', !value);
  picker.addEventListener('change', () => set(picker.value));
  none.addEventListener('change', () => (none.checked ? set(undefined) : set(picker.value)));
  return h('div', { class: 'prop' }, h('label', null, label), h('div', { class: 'row' }, picker, h('label', { class: 'row vd-none' }, none, t('viewDesigner', 'none'))));
}

function swatch(rule: Pick<FormatRule, 'background' | 'color' | 'bold'>, text = t('viewDesigner', 'Sample 123')): HTMLElement {
  return h('span', { class: 'vd-swatch', style: { background: rule.background ?? '', color: rule.color ?? '', fontWeight: rule.bold ? '700' : '' } }, text);
}

export class ViewDesigner implements Page {
  readonly id: string;
  title: string;
  icon = 'columns';
  readonly el: HTMLElement;
  private tab: Tab = 'columns';
  private selColumn: number | null = null;
  private selRule: string | null = null;
  private selDetail: string | null = null;
  private toolbar: HTMLElement;
  private tabsEl: HTMLElement;
  private main: HTMLElement;
  private props: HTMLElement;
  private previewHost: HTMLElement;
  private preview: ListPage | null = null;

  constructor(
    private readonly shell: Shell,
    private readonly key: string,
  ) {
    this.id = `design:view:${key}`;
    this.title = `${t('viewDesigner', 'View')}: ${this.view()?.title ?? key}`;
    this.toolbar = h('div', { class: 'toolbar' });
    this.tabsEl = h('div', { class: 'subtabs' });
    this.main = h('div', { class: 'vd-main' });
    this.props = h('div', { class: 'props' });
    this.previewHost = h('div', { class: 'vd-preview' });
    this.el = h(
      'div',
      { class: 'page' },
      this.toolbar,
      this.tabsEl,
      h(
        'div',
        { class: 'designer' },
        h('div', { class: 'designer-main' }, this.main, h('div', { class: 'vd-preview-head' }, icon('eye', 14), t('viewDesigner', 'Preview on the real data')), this.previewHost),
        this.props,
      ),
    );
    this.render();
    this.refreshPreview();
  }

  private view(): ViewDef | undefined {
    return this.shell.session.config.views.find((v) => v.key === this.key);
  }

  configChanged(): void {
    if (!this.view()) {
      this.shell.closePage(this.id);
      return;
    }
    this.render();
    this.refreshPreview();
  }

  dispose(): void {
    this.preview?.dispose();
    this.preview = null;
  }

  /** Applies a change to this view; `fn` gets the view inside the draft configuration. */
  private change(fn: (v: ViewDef, c: Config) => void): Promise<void> {
    return this.shell.session
      .change((c) => {
        const v = c.views.find((x) => x.key === this.key);
        if (v) fn(v, c);
      })
      .then(() => undefined)
      .catch((e: unknown) => this.shell.fail(e));
  }

  private refreshPreview(): void {
    this.preview?.dispose();
    this.preview = null;
    const v = this.view();
    if (!v || !tableOf(this.shell.session.config, v.table)) {
      clear(this.previewHost, h('div', { class: 'grid-empty' }, t('viewDesigner', 'The table of this view does not exist')));
      return;
    }
    try {
      this.preview = new ListPage(this.shell, structuredClone(v), { embedded: true });
      clear(this.previewHost, this.preview.el);
    } catch (error) {
      clear(this.previewHost, h('div', { class: 'grid-empty' }, error instanceof Error ? error.message : String(error)));
    }
  }

  private render(): void {
    const v = this.view();
    if (!v) return;
    const config = this.shell.session.config;
    const tb = tableOf(config, v.table);
    this.title = `${t('viewDesigner', 'View')}: ${v.title}`;
    this.shell.updateTab(this);
    clear(
      this.toolbar,
      icon(v.icon ?? tb?.icon ?? 'columns'),
      h('span', { class: 'page-title' }, v.title),
      h('span', { class: 'muted mono' }, v.name),
      h('span', { class: 'muted' }, t('viewDesigner', 'of {table}', { table: tb?.title ?? v.table })),
      h('span', { class: 'spacer' }),
      button(t('viewDesigner', 'Open'), { icon: 'table', onClick: () => this.shell.openTarget({ kind: 'view', name: v.name }) }),
      button(t('viewDesigner', 'Delete view'), { icon: 'trash', class: 'danger', onClick: () => void this.deleteView(v) }),
    );
    const details = v.details ?? (tb ? defaultDetails(config, tb) : []);
    const tabs: [Tab, string, number | null][] = [
      ['columns', t('viewDesigner', 'Columns'), v.columns.length],
      ['filter', t('viewDesigner', 'Filter and sort'), (conditionsOf(v.filter)?.length ?? 1) + (v.where ? 1 : 0)],
      ['rules', t('viewDesigner', 'Formatting'), (v.rules ?? []).length],
      ['actions', t('viewDesigner', 'Toolbar actions'), (v.actions ?? []).length],
      ['details', t('viewDesigner', 'Details'), details.length],
    ];
    clear(
      this.tabsEl,
      tabs.map(([key, title, count]) => h('button', { type: 'button', class: `subtab${this.tab === key ? ' active' : ''}`, 'data-tab': key, onclick: () => ((this.tab = key), this.render()) }, title, count !== null ? h('span', { class: 'count' }, String(count)) : null)),
    );
    const selection: (HTMLElement | null)[] = [];
    if (!tb) {
      clear(this.main, h('div', { class: 'grid-empty' }, t('viewDesigner', 'The table “{table}” does not exist', { table: v.table })));
    } else if (this.tab === 'columns') selection.push(this.renderColumns(v, tb, config));
    else if (this.tab === 'filter') this.renderFilter(v, tb, config);
    else if (this.tab === 'rules') selection.push(this.renderRules(v, tb));
    else if (this.tab === 'actions') this.renderActions(v, config);
    else selection.push(this.renderDetails(v, tb, config, details));
    clear(this.props, ...selection, this.generalProps(v, config));
  }

  /* ------------------------------ columns ------------------------------ */

  private renderColumns(v: ViewDef, tb: TableDef, config: Config): HTMLElement | null {
    if (this.selColumn !== null && this.selColumn >= v.columns.length) this.selColumn = null;
    const sel = this.selColumn;
    const options = fieldOptions(config, tb).filter(([path]) => !v.columns.some((c) => c.field === path));
    const adder = h('select', { class: 'input vd-adder', 'data-add': 'column' }, h('option', { value: '' }, t('viewDesigner', 'Add a column…')), options.map(([path, title]) => h('option', { value: path }, `${title}  (${path})`)));
    adder.addEventListener('change', () => {
      const path = adder.value;
      if (!path) return;
      const at = sel === null ? v.columns.length : sel + 1;
      this.selColumn = at;
      void this.change((x) => x.columns.splice(at, 0, { field: path }));
    });
    const move = (by: number) => {
      if (sel === null) return;
      const to = sel + by;
      if (to < 0 || to >= v.columns.length) return;
      this.selColumn = to;
      void this.change((x) => {
        const [c] = x.columns.splice(sel, 1);
        x.columns.splice(to, 0, c!);
      });
    };
    const rows = v.columns.map((c, i) => {
      const title = pathTitle(config, tb, c.field);
      const tr = h(
        'tr',
        { class: i === sel ? 'selected' : '', 'data-column': c.field, tabindex: 0 },
        h('td', { class: 'muted' }, String(i + 1)),
        h('td', { class: 'mono' }, c.field, title === null ? h('span', { class: 'vd-bad', title: t('viewDesigner', 'No such field') }, ' ', icon('warning', 13)) : null),
        h('td', { class: c.title ? '' : 'muted' }, c.title ?? title ?? ''),
        h('td', null, c.width ? String(c.width) : ''),
        h('td', null, totalOptions().find(([fn]) => fn === c.total)?.[1] ?? ''),
        h('td', { class: 'center' }, c.hidden ? '✓' : ''),
      );
      tr.addEventListener('click', () => {
        this.selColumn = i;
        this.render();
      });
      return tr;
    });
    clear(
      this.main,
      h(
        'div',
        { class: 'f-buttons' },
        adder,
        button(null, { icon: 'arrowUp', title: t('viewDesigner', 'Move up'), disabled: sel === null || sel === 0, onClick: () => move(-1) }),
        button(null, { icon: 'arrowDown', title: t('viewDesigner', 'Move down'), disabled: sel === null || sel >= v.columns.length - 1, onClick: () => move(1) }),
        button(t('viewDesigner', 'Remove'), {
          icon: 'trash',
          class: 'danger',
          disabled: sel === null,
          onClick: () => {
            if (sel === null) return;
            this.selColumn = null;
            void this.change((x) => x.columns.splice(sel, 1));
          },
        }),
      ),
      h(
        'table',
        { class: 'design-table' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('viewDesigner', 'Field')), h('th', null, t('viewDesigner', 'Title')), h('th', null, t('viewDesigner', 'Width')), h('th', null, t('viewDesigner', 'Total')), h('th', null, t('viewDesigner', 'Hidden')))),
        h('tbody', null, rows),
      ),
      v.columns.length ? null : h('p', { class: 'muted' }, t('viewDesigner', 'No columns: the list shows nothing. Add a column above.')),
    );
    const c = sel === null ? undefined : v.columns[sel];
    if (!c || sel === null) return null;
    const set = (fn: (col: ColumnDef) => void) =>
      void this.change((x) => {
        const col = x.columns[sel];
        if (col && col.field === c.field) fn(col);
      });
    const found = fieldAtPath(config, tb, c.field);
    return section(
      t('viewDesigner', 'Column'),
      h('div', { class: 'prop' }, h('label', null, t('viewDesigner', 'Field')), h('span', { class: 'mono' }, c.field)),
      textProp(t('viewDesigner', 'Title'), c.title, (val) => set((col) => (val ? (col.title = val) : delete col.title)), { placeholder: pathTitle(config, tb, c.field) ?? '' }),
      numberProp(t('viewDesigner', 'Width'), c.width, (val) => set((col) => (val ? (col.width = val) : delete col.width))),
      selectProp<AggregateFn | ''>(t('viewDesigner', 'Total'), c.total ?? '', totalOptions().filter(([fn]) => !fn || fn === 'count' || !found || isNumeric(found.field) || fn === 'min' || fn === 'max'), (val) => set((col) => (val ? (col.total = val) : delete col.total))),
      checkProp(t('viewDesigner', 'Hidden'), c.hidden, (val) => set((col) => (val ? (col.hidden = true) : delete col.hidden)), t('viewDesigner', 'Kept in the view, but not shown until the user picks it')),
    );
  }

  /* ------------------------------ filter, sort, grouping ------------------------------ */

  private renderFilter(v: ViewDef, tb: TableDef, config: Config): void {
    const options = fieldOptions(config, tb);
    const conds = conditionsOf(v.filter);
    const setConds = (fn: (list: Condition[]) => void) =>
      void this.change((x) => {
        const list = structuredClone(conditionsOf(x.filter) ?? []);
        fn(list);
        const next = filterOf(list);
        if (next) x.filter = next;
        else delete x.filter;
      });
    const condBlock = conds === null
      ? h(
          'div',
          { class: 'vd-note' },
          h('p', null, t('viewDesigner', 'This filter combines conditions with OR or NOT, which this list cannot show. It still applies.')),
          h('pre', { class: 'mono vd-json' }, JSON.stringify(v.filter, null, 2)),
          button(t('viewDesigner', 'Clear the filter'), { icon: 'trash', class: 'danger', onClick: () => void this.change((x) => delete x.filter) }),
        )
      : h(
          'div',
          { class: 'vd-list' },
          conds.map((cond, i) => this.conditionRow(cond, i, options, tb, config, setConds)),
          conds.length ? null : h('div', { class: 'muted vd-empty' }, t('viewDesigner', 'No conditions: every record is shown.')),
          h('div', null, button(t('viewDesigner', 'Add a condition'), { icon: 'plus', onClick: () => setConds((list) => list.push({ field: options[0]?.[0] ?? 'id', op: 'eq', value: '' })) })),
        );
    const names = () => {
      const current = tableOf(this.shell.session.config, v.table);
      return current ? [...allFields(current).map((f) => f.name), 'id'] : [];
    };
    const sort = v.sort ?? [];
    const group = v.group ?? [];
    const fieldSelect = (value: string, set: (path: string) => void) => {
      const s = h('select', { class: 'input' }, options.map(([path, title]) => h('option', { value: path }, title)));
      if (!options.some(([path]) => path === value)) s.prepend(h('option', { value }, `${value} ?`));
      s.value = value;
      s.addEventListener('change', () => set(s.value));
      return s;
    };
    const reorder = <T>(list: T[], at: number, by: number) => {
      const to = at + by;
      if (to < 0 || to >= list.length) return;
      const [item] = list.splice(at, 1);
      list.splice(to, 0, item!);
    };
    const tools = (count: number, i: number, apply: (fn: (list: unknown[]) => void) => void) =>
      h(
        'span',
        { class: 'vd-tools' },
        button(null, { icon: 'arrowUp', title: t('viewDesigner', 'Move up'), disabled: i === 0, onClick: () => apply((list) => reorder(list, i, -1)) }),
        button(null, { icon: 'arrowDown', title: t('viewDesigner', 'Move down'), disabled: i >= count - 1, onClick: () => apply((list) => reorder(list, i, 1)) }),
        button(null, { icon: 'x', title: t('viewDesigner', 'Remove'), onClick: () => apply((list) => list.splice(i, 1)) }),
      );
    const applySort = (fn: (list: unknown[]) => void) =>
      void this.change((x) => {
        const list = x.sort ?? [];
        fn(list);
        if (list.length) x.sort = list;
        else delete x.sort;
      });
    const applyGroup = (fn: (list: unknown[]) => void) =>
      void this.change((x) => {
        const list = x.group ?? [];
        fn(list);
        if (list.length) x.group = list;
        else delete x.group;
      });
    clear(
      this.main,
      h(
        'fieldset',
        { class: 'f-group', 'data-block': 'filter' },
        h('legend', null, t('viewDesigner', 'Show only records where all of these hold')),
        condBlock,
      ),
      h(
        'fieldset',
        { class: 'f-group', 'data-block': 'where' },
        h('legend', null, t('viewDesigner', 'And this expression is true')),
        exprProp(t('viewDesigner', 'Expression'), v.where, names, (val) => void this.change((x) => (val ? (x.where = val) : delete x.where)), { placeholder: "total > 1000 and status <> 'paid'", hint: t('viewDesigner', 'Checked on every record after the conditions; may use $params') }),
      ),
      h(
        'fieldset',
        { class: 'f-group', 'data-block': 'sort' },
        h('legend', null, t('viewDesigner', 'Sort by')),
        h(
          'div',
          { class: 'vd-list' },
          sort.map((s, i) => {
            const desc = h('input', { type: 'checkbox' });
            desc.checked = s.desc === true;
            desc.addEventListener('change', () => applySort((list) => ((list as typeof sort)[i]!.desc = desc.checked || undefined)));
            return h(
              'div',
              { class: 'vd-line' },
              h('span', { class: 'muted vd-n' }, String(i + 1)),
              fieldSelect(s.field, (path) => applySort((list) => ((list as typeof sort)[i]!.field = path))),
              h('label', { class: 'row vd-check' }, desc, t('viewDesigner', 'Descending')),
              tools(sort.length, i, applySort),
            );
          }),
          sort.length ? null : h('div', { class: 'muted vd-empty' }, t('viewDesigner', 'In the order the source keeps them.')),
          h('div', null, button(t('viewDesigner', 'Add a sort field'), { icon: 'plus', onClick: () => applySort((list) => list.push({ field: options.find(([p]) => !sort.some((s) => s.field === p))?.[0] ?? options[0]?.[0] ?? 'id' })) })),
        ),
      ),
      h(
        'fieldset',
        { class: 'f-group', 'data-block': 'group' },
        h('legend', null, t('viewDesigner', 'Group by default')),
        h(
          'div',
          { class: 'vd-list' },
          group.map((g, i) => h('div', { class: 'vd-line' }, h('span', { class: 'muted vd-n' }, String(i + 1)), fieldSelect(g, (path) => applyGroup((list) => ((list as string[])[i] = path))), tools(group.length, i, applyGroup))),
          group.length ? null : h('div', { class: 'muted vd-empty' }, t('viewDesigner', 'Not grouped. Users can still drag a column to the group bar.')),
          h('div', null, button(t('viewDesigner', 'Add a grouping level'), { icon: 'plus', onClick: () => applyGroup((list) => list.push(options.find(([p]) => !group.includes(p))?.[0] ?? 'id')) })),
        ),
      ),
    );
  }

  private conditionRow(cond: Condition, i: number, options: [string, string][], tb: TableDef, config: Config, setConds: (fn: (list: Condition[]) => void) => void): HTMLElement {
    const f: FieldDef | undefined = fieldAtPath(config, tb, cond.field)?.field;
    const parse = (s: string): unknown => {
      if (f && isNumeric(f)) {
        const n = Number(s.trim().replace(',', '.'));
        return s.trim() === '' || Number.isNaN(n) ? s : n;
      }
      if (f?.type === 'boolean') return s === 'true';
      return s;
    };
    const fieldSel = h('select', { class: 'input', 'data-cond': 'field' }, options.map(([path, title]) => h('option', { value: path }, title)));
    if (!options.some(([p]) => p === cond.field)) fieldSel.prepend(h('option', { value: cond.field }, `${cond.field} ?`));
    fieldSel.value = cond.field;
    fieldSel.addEventListener('change', () => setConds((list) => (list[i] = { field: fieldSel.value, op: list[i]!.op === 'between' || list[i]!.op.endsWith('In') || list[i]!.op === 'in' ? 'eq' : list[i]!.op, value: '' })));
    const opSel = h('select', { class: 'input vd-op', 'data-cond': 'op' }, OPS.map((op) => h('option', { value: op }, opTitle(op))));
    opSel.value = cond.op;
    opSel.addEventListener('change', () =>
      setConds((list) => {
        const c = list[i]!;
        const op = opSel.value as FilterOp;
        const first = Array.isArray(c.value) ? c.value[0] : c.value;
        c.op = op;
        if (op === 'isNull' || op === 'isNotNull') delete c.value;
        else if (op === 'between') c.value = [first ?? '', Array.isArray(c.value) ? (c.value[1] ?? '') : ''];
        else if (op === 'in' || op === 'notIn') c.value = first === undefined || first === '' ? [] : [first];
        else c.value = first ?? '';
      }),
    );
    const valueInput = (value: unknown, set: (v: unknown) => void, placeholder = '') => {
      if (f?.type === 'boolean') {
        const s = h('select', { class: 'input', 'data-cond': 'value' }, h('option', { value: 'true' }, t('viewDesigner', 'yes')), h('option', { value: 'false' }, t('viewDesigner', 'no')));
        s.value = value === true ? 'true' : 'false';
        s.addEventListener('change', () => set(s.value === 'true'));
        return s;
      }
      if (f?.type === 'enum' && cond.op !== 'in' && cond.op !== 'notIn') {
        const values = enumValues(config, f);
        const s = h('select', { class: 'input', 'data-cond': 'value' }, h('option', { value: '' }, '—'), values.map((ev) => h('option', { value: ev.value }, ev.title)));
        s.value = String(value ?? '');
        s.addEventListener('change', () => set(s.value));
        return s;
      }
      const type = f?.type === 'date' ? 'date' : f?.type === 'datetime' ? 'datetime-local' : 'text';
      const input = h('input', { class: 'input', type, placeholder, 'data-cond': 'value' });
      input.value = value === undefined || value === null ? '' : String(value);
      input.addEventListener('change', () => set(type === 'datetime-local' && input.value.length === 16 ? `${input.value}:00` : input.value));
      return input;
    };
    let value: HTMLElement | null;
    if (cond.op === 'isNull' || cond.op === 'isNotNull') value = null;
    else if (cond.op === 'between') {
      const pair = Array.isArray(cond.value) ? cond.value : [cond.value, ''];
      const setAt = (at: number) => (val: unknown) =>
        setConds((list) => {
          const c = list[i]!;
          const arr = Array.isArray(c.value) ? [...(c.value as unknown[])] : ['', ''];
          arr[at] = typeof val === 'string' ? parse(val) : val;
          c.value = arr;
        });
      value = h('span', { class: 'row vd-between' }, valueInput(pair[0], setAt(0), t('viewDesigner', 'from')), t('viewDesigner', 'and'), valueInput(pair[1], setAt(1), t('viewDesigner', 'to')));
    } else if (cond.op === 'in' || cond.op === 'notIn') {
      const list = Array.isArray(cond.value) ? cond.value : cond.value === undefined ? [] : [cond.value];
      const input = h('input', { class: 'input', placeholder: t('viewDesigner', 'a, b, c'), 'data-cond': 'value' });
      input.value = list.map(String).join(', ');
      input.addEventListener('change', () =>
        setConds((l) => {
          l[i]!.value = input.value.split(',').map((s) => s.trim()).filter(Boolean).map(parse);
        }),
      );
      value = input;
    } else value = valueInput(cond.value, (val) => setConds((list) => (list[i]!.value = typeof val === 'string' ? parse(val) : val)));
    return h(
      'div',
      { class: 'vd-line vd-cond', 'data-cond-row': String(i) },
      h('span', { class: 'muted vd-n' }, i === 0 ? '' : t('viewDesigner', 'and')),
      fieldSel,
      opSel,
      value ?? h('span', { class: 'grow' }),
      button(null, { icon: 'x', title: t('viewDesigner', 'Remove'), onClick: () => setConds((list) => list.splice(i, 1)) }),
    );
  }

  /* ------------------------------ formatting rules ------------------------------ */

  private renderRules(v: ViewDef, tb: TableDef): HTMLElement | null {
    const rules = v.rules ?? [];
    if (this.selRule && !rules.some((r) => r.key === this.selRule)) this.selRule = null;
    const selAt = rules.findIndex((r) => r.key === this.selRule);
    const columnTitle = (field: string | undefined) => (field ? (v.columns.find((c) => c.field === field)?.title ?? pathTitle(this.shell.session.config, tb, field) ?? field) : t('viewDesigner', 'whole row'));
    const move = (by: number) => {
      if (selAt < 0) return;
      void this.change((x) => {
        const list = x.rules ?? [];
        const to = selAt + by;
        if (to < 0 || to >= list.length) return;
        const [r] = list.splice(selAt, 1);
        list.splice(to, 0, r!);
      });
    };
    const rows = rules.map((r, i) => {
      const active = h('input', { type: 'checkbox', title: t('viewDesigner', 'Active') });
      active.checked = r.active !== false;
      active.addEventListener('click', (e) => e.stopPropagation());
      active.addEventListener('change', () => void this.change((x) => {
        const rule = x.rules?.find((rr) => rr.key === r.key);
        if (rule) active.checked ? delete rule.active : (rule.active = false);
      }));
      const tr = h(
        'tr',
        { class: `${r.key === this.selRule ? 'selected' : ''}${r.active === false ? ' vd-off' : ''}`, 'data-rule': r.key, tabindex: 0 },
        h('td', { class: 'muted' }, String(i + 1)),
        h('td', null, swatch(r)),
        h('td', null, r.description ?? ''),
        h('td', { class: 'mono' }, r.when),
        h('td', null, columnTitle(r.field)),
        h('td', { class: 'center' }, active),
      );
      tr.addEventListener('click', () => {
        this.selRule = r.key;
        this.render();
      });
      return tr;
    });
    clear(
      this.main,
      h('p', { class: 'muted' }, t('viewDesigner', 'Rules are checked in order for every row; each one that holds adds its colours, so a later rule wins.')),
      h(
        'div',
        { class: 'f-buttons' },
        button(t('viewDesigner', 'Add a rule'), {
          icon: 'plus',
          class: 'primary',
          onClick: () => {
            const rule: FormatRule = { key: newKey('r'), when: 'true', background: '#fff4dc', description: t('viewDesigner', 'New rule') };
            this.selRule = rule.key;
            void this.change((x) => (x.rules = [...(x.rules ?? []), rule]));
          },
        }),
        button(null, { icon: 'arrowUp', title: t('viewDesigner', 'Move up'), disabled: selAt <= 0, onClick: () => move(-1) }),
        button(null, { icon: 'arrowDown', title: t('viewDesigner', 'Move down'), disabled: selAt < 0 || selAt >= rules.length - 1, onClick: () => move(1) }),
        button(t('viewDesigner', 'Delete'), {
          icon: 'trash',
          class: 'danger',
          disabled: selAt < 0,
          onClick: () => {
            const key = this.selRule;
            this.selRule = null;
            void this.change((x) => {
              x.rules = (x.rules ?? []).filter((r) => r.key !== key);
              if (!x.rules.length) delete x.rules;
            });
          },
        }),
      ),
      h(
        'table',
        { class: 'design-table' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('viewDesigner', 'Looks like')), h('th', null, t('viewDesigner', 'Description')), h('th', null, t('viewDesigner', 'When')), h('th', null, t('viewDesigner', 'Column')), h('th', null, t('viewDesigner', 'Active')))),
        h('tbody', null, rows),
      ),
      rules.length ? null : h('p', { class: 'muted' }, t('viewDesigner', 'No rules yet. A rule colours the rows (or one column) for which its expression is true: total > 1000, not posted.')),
    );
    const r = rules[selAt];
    if (!r) return null;
    const set = (fn: (rule: FormatRule) => void) =>
      void this.change((x) => {
        const rule = x.rules?.find((rr) => rr.key === r.key);
        if (rule) fn(rule);
      });
    const names = () => {
      const current = tableOf(this.shell.session.config, v.table);
      return current ? [...allFields(current).map((f) => f.name), 'id'] : [];
    };
    return section(
      t('viewDesigner', 'Rule'),
      h('div', { class: 'vd-sample' }, swatch(r, r.description || t('viewDesigner', 'Sample 123'))),
      exprProp(t('viewDesigner', 'Applies when'), r.when, names, (val) => set((rule) => (rule.when = val || 'true')), { placeholder: "status = 'paid'" }),
      selectProp(t('viewDesigner', 'Column'), r.field ?? '', v.columns.map((c) => [c.field, columnTitle(c.field)] as [string, string]), (val) => set((rule) => (val ? (rule.field = val) : delete rule.field)), true),
      colorProp(t('viewDesigner', 'Background'), r.background, (val) => set((rule) => (val ? (rule.background = val) : delete rule.background))),
      colorProp(t('viewDesigner', 'Text colour'), r.color, (val) => set((rule) => (val ? (rule.color = val) : delete rule.color))),
      checkProp(t('viewDesigner', 'Bold'), r.bold, (val) => set((rule) => (val ? (rule.bold = true) : delete rule.bold))),
      checkProp(t('viewDesigner', 'Active'), r.active !== false, (val) => set((rule) => (val ? delete rule.active : (rule.active = false)))),
      textProp(t('viewDesigner', 'Description'), r.description, (val) => set((rule) => (val ? (rule.description = val) : delete rule.description))),
    );
  }

  /* ------------------------------ toolbar actions ------------------------------ */

  private renderActions(v: ViewDef, config: Config): void {
    const usable = config.actions.filter((a) => !a.table || a.table === v.table);
    const chosen = v.actions ?? [];
    clear(
      this.main,
      h('p', { class: 'muted' }, t('viewDesigner', 'Ticked actions get a button on the list’s toolbar, in this order. Actions made for this table and available in lists are added after them anyway.')),
      h(
        'div',
        { class: 'vd-checklist' },
        usable.map((a) => {
          const box = h('input', { type: 'checkbox', 'data-action': a.name });
          box.checked = chosen.includes(a.name);
          box.addEventListener('change', () =>
            void this.change((x) => {
              const list = (x.actions ?? []).filter((n) => n !== a.name);
              if (box.checked) list.push(a.name);
              if (list.length) x.actions = list;
              else delete x.actions;
            }),
          );
          return h('label', { class: 'vd-check-row' }, box, icon(a.icon ?? 'bolt'), h('span', null, a.title), h('span', { class: 'muted mono' }, a.name), h('span', { class: 'muted' }, a.table ? '' : t('viewDesigner', 'any table')));
        }),
        usable.length ? null : h('p', { class: 'muted' }, t('viewDesigner', 'There are no actions for this table yet. Create one under Actions in the designer tree.')),
      ),
      chosen.filter((n) => !config.actions.some((a) => a.name === n)).map((n) => h('p', { class: 'field-error' }, t('viewDesigner', 'Action “{name}” does not exist', { name: n }))),
    );
  }

  /* ------------------------------ detail tabs ------------------------------ */

  private renderDetails(v: ViewDef, tb: TableDef, config: Config, details: DetailDef[]): HTMLElement | null {
    const auto = !v.details;
    if (this.selDetail && !details.some((d) => d.key === this.selDetail)) this.selDetail = null;
    const selAt = details.findIndex((d) => d.key === this.selDetail);
    // The first edit of automatic tabs stores them: from then on the list is the view's own.
    const mutate = (fn: (list: DetailDef[]) => void) =>
      void this.change((x, c) => {
        const target = tableOf(c, x.table);
        const list = x.details ?? (target ? defaultDetails(c, target) : []);
        fn(list);
        x.details = list;
      });
    const same = (a: DetailDef, b: DetailDef) => a.kind === b.kind && a.table === b.table && a.field === b.field && a.part === b.part;
    const candidates = defaultDetails(config, tb).filter((d) => !details.some((x) => same(x, d)));
    const adder = h('select', { class: 'input vd-adder', 'data-add': 'detail' }, h('option', { value: '' }, t('viewDesigner', 'Add a tab…')), candidates.map((d, i) => h('option', { value: String(i) }, `${d.title ?? d.table ?? d.part ?? ''} — ${this.detailSource(d)}`)));
    adder.addEventListener('change', () => {
      const d = candidates[Number(adder.value)];
      if (!adder.value || !d) return;
      const copy = { ...d, key: newKey('d') };
      this.selDetail = copy.key;
      mutate((list) => list.push(copy));
    });
    const move = (by: number) =>
      mutate((list) => {
        const to = selAt + by;
        if (selAt < 0 || to < 0 || to >= list.length) return;
        const [d] = list.splice(selAt, 1);
        list.splice(to, 0, d!);
      });
    const rows = details.map((d, i) => {
      const tr = h('tr', { class: d.key === this.selDetail ? 'selected' : '', 'data-detail': d.key, tabindex: 0 }, h('td', { class: 'muted' }, String(i + 1)), h('td', null, d.title ?? ''), h('td', null, this.kindTitle(d.kind)), h('td', { class: 'mono' }, this.detailSource(d)), h('td', { class: 'mono muted' }, d.view ?? ''));
      tr.addEventListener('click', () => {
        this.selDetail = d.key;
        this.render();
      });
      return tr;
    });
    clear(
      this.main,
      h('p', { class: 'muted' }, auto ? t('viewDesigner', 'Automatic: a tab for each part, register and table that refers to this one, following the schema. Any change here fixes the list.') : t('viewDesigner', 'The tabs below the list, for the selected record.')),
      h(
        'div',
        { class: 'f-buttons' },
        candidates.length ? adder : null,
        button(null, { icon: 'arrowUp', title: t('viewDesigner', 'Move up'), disabled: selAt <= 0, onClick: () => move(-1) }),
        button(null, { icon: 'arrowDown', title: t('viewDesigner', 'Move down'), disabled: selAt < 0 || selAt >= details.length - 1, onClick: () => move(1) }),
        button(t('viewDesigner', 'Remove'), {
          icon: 'trash',
          class: 'danger',
          disabled: selAt < 0,
          onClick: () => {
            const key = this.selDetail;
            this.selDetail = null;
            mutate((list) => list.splice(list.findIndex((d) => d.key === key), 1));
          },
        }),
        h('span', { class: 'spacer' }),
        button(t('viewDesigner', 'Reset to automatic'), { icon: 'undo', disabled: auto, onClick: () => void this.change((x) => delete x.details) }),
      ),
      h(
        'table',
        { class: `design-table${auto ? ' vd-auto' : ''}` },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('viewDesigner', 'Title')), h('th', null, t('viewDesigner', 'Kind')), h('th', null, t('viewDesigner', 'Source')), h('th', null, t('viewDesigner', 'View')))),
        h('tbody', null, rows),
      ),
      details.length ? null : h('p', { class: 'muted' }, t('viewDesigner', 'No detail tabs: the list takes the whole page.')),
    );
    const d = details[selAt];
    if (!d) return null;
    const set = (fn: (det: DetailDef) => void) =>
      mutate((list) => {
        const det = list.find((x) => x.key === d.key);
        if (det) fn(det);
      });
    const refTables = config.tables.filter((x) => x.fields.some((f) => f.type === 'ref' && f.ref === tb.name));
    const registers = config.tables.filter((x) => x.kind === 'register');
    const detailTable = tableOf(config, d.table);
    return section(
      t('viewDesigner', 'Detail tab'),
      textProp(t('viewDesigner', 'Title'), d.title, (val) => set((det) => (val ? (det.title = val) : delete det.title))),
      selectProp<DetailDef['kind']>(t('viewDesigner', 'Kind'), d.kind, [['backref', this.kindTitle('backref')], ['part', this.kindTitle('part')], ['movements', this.kindTitle('movements')], ['view', this.kindTitle('view')]], (val) =>
        set((det) => {
          det.kind = val;
          delete det.table;
          delete det.field;
          delete det.part;
          delete det.view;
          if (val === 'part') det.part = tb.parts?.[0]?.name ?? '';
          if (val === 'movements') det.table = registers[0]?.name ?? '';
          delete det.where;
          if (val === 'view') det.table = config.tables.find((x) => x.name !== tb.name)?.name ?? tb.name;
          if (val === 'backref') {
            const other = refTables[0];
            det.table = other?.name ?? '';
            det.field = other?.fields.find((f) => f.type === 'ref' && f.ref === tb.name)?.name ?? '';
          }
        }),
      ),
      d.kind === 'part' ? selectProp(t('viewDesigner', 'Part'), d.part, (tb.parts ?? []).map((p) => [p.name, p.title ?? p.name] as [string, string]), (val) => set((det) => (det.part = val))) : null,
      d.kind === 'movements' ? selectProp(t('viewDesigner', 'Register'), d.table, registers.map((x) => [x.name, x.title] as [string, string]), (val) => set((det) => (det.table = val))) : null,
      d.kind === 'backref'
        ? selectProp(t('viewDesigner', 'Table'), d.table, refTables.map((x) => [x.name, x.title] as [string, string]), (val) =>
            set((det) => {
              det.table = val;
              det.field = tableOf(config, val)?.fields.find((f) => f.type === 'ref' && f.ref === tb.name)?.name ?? '';
            }),
          )
        : null,
      d.kind === 'view' ? selectProp(t('viewDesigner', 'Table'), d.table, config.tables.map((x) => [x.name, x.title] as [string, string]), (val) => set((det) => (det.table = val))) : null,
      d.kind === 'view' && detailTable
        ? exprProp(t('viewDesigner', 'Rows where'), d.where, () => allFields(detailTable).map((f) => f.name), (val) => set((det) => (val ? (det.where = val) : delete det.where)), { placeholder: 'date <= $master.date', hint: t('viewDesigner', 'An expression over the rows of the table; $master.x is the selected record') })
        : null,
      d.kind === 'backref' && detailTable ? selectProp(t('viewDesigner', 'By field'), d.field, detailTable.fields.filter((f) => f.type === 'ref' && f.ref === tb.name).map((f) => [f.name, fieldTitle(f)] as [string, string]), (val) => set((det) => (det.field = val))) : null,
      d.kind !== 'part' && detailTable ? selectProp(t('viewDesigner', 'Shown as view'), d.view ?? '', config.views.filter((x) => x.table === detailTable.name).map((x) => [x.name, x.title] as [string, string]), (val) => set((det) => (val ? (det.view = val) : delete det.view)), true) : null,
    );
  }

  private kindTitle(kind: DetailDef['kind']): string {
    return kind === 'backref' ? t('viewDesigner', 'Records referring to it') : kind === 'part' ? t('viewDesigner', 'Part (lines)') : kind === 'view' ? t('viewDesigner', 'Rows by a condition') : kind === 'versions' ? t('viewDesigner', 'Versions') : t('viewDesigner', 'Register movements');
  }

  private detailSource(d: DetailDef): string {
    if (d.kind === 'part') return d.part ?? '';
    if (d.kind === 'movements') return d.table ?? '';
    if (d.kind === 'view') return `${d.table ?? ''}: ${d.where ?? ''}`;
    return `${d.table ?? ''}.${d.field ?? ''}`;
  }

  /* ------------------------------ the view itself ------------------------------ */

  private generalProps(v: ViewDef, config: Config): HTMLElement {
    const set = (fn: (x: ViewDef) => void) => void this.change((x) => fn(x));
    return section(
      t('viewDesigner', 'View'),
      textProp(t('viewDesigner', 'Title'), v.title, (val) => set((x) => (x.title = val || x.title))),
      textProp(t('viewDesigner', 'Name'), v.name, (val) => void this.rename(v, val), { mono: true, hint: t('viewDesigner', 'Menu items and actions open the view by it') }),
      h('div', { class: 'prop' }, h('label', null, t('viewDesigner', 'Table')), h('span', { class: 'mono' }, v.table)),
      iconProp(t('viewDesigner', 'Icon'), v.icon, (val) => set((x) => (x.icon = val))),
      textProp(t('viewDesigner', 'Description'), v.description, (val) => set((x) => (val.trim() ? (x.description = val) : delete x.description)), { multiline: true, hint: t('viewDesigner', 'Shown in the info bar above the list') }),
      checkProp(t('viewDesigner', 'Edit in cells'), v.editable, (val) => set((x) => (val ? (x.editable = true) : delete x.editable))),
      selectProp(t('viewDesigner', 'Opens in form'), v.form ?? '', config.forms.filter((f) => f.table === v.table).map((f) => [f.name, f.title ?? f.name] as [string, string]), (val) => set((x) => (val ? (x.form = val) : delete x.form)), true),
    );
  }

  /** Renames the view and what opens it by name: menu items, dashboards, detail tabs, `open` steps. */
  private async rename(v: ViewDef, to: string): Promise<void> {
    to = to.trim();
    if (to === v.name) return;
    if (!IDENT.test(to)) return toast(t('viewDesigner', 'The name must be a Latin identifier'), 'error');
    if (this.shell.session.config.views.some((x) => x.name === to)) return toast(t('viewDesigner', 'There is already a view named “{name}”', { name: to }), 'error');
    const from = v.name;
    const walkSteps = (steps: Step[]) => {
      for (const s of steps) {
        if (s.type === 'open' && s.target.kind === 'view' && s.target.name === from) s.target.name = to;
        if (s.type === 'if') {
          walkSteps(s.steps);
          if (s.else) walkSteps(s.else);
        }
      }
    };
    const walkMenu = (nodes: MenuNode[]) => {
      for (const n of nodes) {
        if (n.target?.kind === 'view' && n.target.name === from) n.target.name = to;
        if (n.children) walkMenu(n.children);
      }
    };
    await this.change((x, c) => {
      x.name = to;
      walkMenu(c.menu);
      for (const d of c.dashboards) for (const w of d.widgets) if (w.view === from) w.view = to;
      for (const other of c.views) for (const det of other.details ?? []) if (det.view === from) det.view = to;
      for (const a of c.actions) walkSteps(a.steps);
      for (const tr of c.triggers) walkSteps(tr.steps);
    });
  }

  private async deleteView(v: ViewDef): Promise<void> {
    if (!(await confirm(t('viewDesigner', 'Delete the view'), t('viewDesigner', 'Delete the view “{title}”? The records stay; menu items that open it are removed.', { title: v.title }), t('viewDesigner', 'Delete'), true))) return;
    const strip = (nodes: MenuNode[]): MenuNode[] => nodes.filter((n) => !(n.target?.kind === 'view' && n.target.name === v.name)).map((n) => (n.children ? { ...n, children: strip(n.children) } : n));
    await this.shell.session
      .change((c) => {
        c.views = c.views.filter((x) => x.key !== v.key);
        c.menu = strip(c.menu);
      })
      .catch((e: unknown) => this.shell.fail(e));
  }
}
