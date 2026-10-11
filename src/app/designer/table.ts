/**
 * The table designer (Task.md 9.1): the table's own properties, its fields in
 * a list with the selected field's properties beside it, the parts of a
 * document, its posting rules, its checks. Every edit is applied at once —
 * the open lists and cards pick it up — and is one step of undo.
 */
import { t } from '../../core/i18n';
import { allFields, newKey, table as tableOf, IDENT, CONSTANTS } from '../../core/config/model';
import type { Config, FieldDef, FieldType, PartDef, PostingRule, TableDef, TableKind } from '../../core/config/types';
import { button, clear, h, icon } from '../dom';
import { confirm, prompt, toast } from '../ui';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { checkProp, exprProp, iconProp, numberProp, section, selectProp, textProp, TYPE_OPTIONS, typeTitle } from './props';
import { identFrom, openDesigner, createView, createForm } from './index';

type Tab = 'fields' | 'parts' | 'posting' | 'checks';

/** The constants are designed as the fields of a table of their own, which exists once it has a field. */
export const CONSTANTS_KEY = 'sys_constants';

function constantsDraft(c: Config): TableDef {
  return { key: CONSTANTS_KEY, name: CONSTANTS, kind: 'table', title: t('model', 'Constants'), icon: 'settings', fields: c.constants ?? [] };
}

export class TableDesigner implements Page {
  id: string;
  title: string;
  icon = 'wrench';
  readonly el: HTMLElement;
  private key: string;
  private tab: Tab = 'fields';
  private selected: string | null = null;
  private part: string | null = null;
  private partField: string | null = null;
  private main: HTMLElement;
  private props: HTMLElement;
  private tabsEl: HTMLElement;

  constructor(
    private readonly shell: Shell,
    name: string,
    field?: string,
  ) {
    const tb = name === CONSTANTS ? constantsDraft(shell.session.config) : tableOf(shell.session.config, name)!;
    this.key = tb.key;
    this.id = `design:table:${tb.key}`;
    this.title = `${t('tableDesigner', 'Table')}: ${tb.title}`;
    this.tabsEl = h('div', { class: 'subtabs' });
    this.main = h('div', { style: { flex: '1', overflow: 'auto', padding: '10px 12px' } });
    this.props = h('div', { class: 'props' });
    this.el = h('div', { class: 'page' }, h('div', { class: 'toolbar' }), this.tabsEl, h('div', { class: 'designer' }, h('div', { class: 'designer-main' }, this.main), this.props));
    if (field) this.focusField(field);
    else this.render();
  }

  private get constants(): boolean {
    return this.key === CONSTANTS_KEY;
  }

  private tb(): TableDef | undefined {
    if (this.constants) return constantsDraft(this.shell.session.config);
    return this.shell.session.config.tables.find((x) => x.key === this.key);
  }

  configChanged(): void {
    if (!this.tb()) {
      this.shell.closePage(this.id);
      return;
    }
    this.render();
  }

  focusField(name: string): void {
    this.tab = 'fields';
    if (name === '+') {
      void this.addField();
      return;
    }
    const f = this.tb()?.fields.find((x) => x.name === name);
    this.selected = f?.key ?? null;
    this.render();
    setTimeout(() => this.el.querySelector<HTMLElement>('.prop input[data-prop]')?.focus(), 50);
  }

  /** Applies a change to this table; `fn` gets the table inside the draft configuration. */
  private change(fn: (tb: TableDef, c: Config) => void): Promise<void> {
    return this.shell.session
      .change((c) => {
        if (this.constants) {
          const tb = constantsDraft(c);
          fn(tb, c);
          if (tb.fields.length) c.constants = tb.fields;
          else delete c.constants;
          return;
        }
        const tb = c.tables.find((x) => x.key === this.key);
        if (tb) fn(tb, c);
      })
      .then(() => undefined)
      .catch((e: unknown) => this.shell.fail(e));
  }

  private render(): void {
    const tb = this.tb();
    if (!tb) return;
    this.title = `${t('tableDesigner', 'Table')}: ${tb.title}`;
    this.shell.updateTab(this);
    const toolbar = this.el.querySelector('.toolbar')!;
    if (this.constants) {
      this.tab = 'fields';
      clear(
        toolbar,
        icon('settings'),
        h('span', { class: 'page-title' }, tb.title),
        h('span', { class: 'muted' }, t('tableDesigner', 'Settings the whole application shares: $const.name in expressions')),
        h('span', { class: 'spacer' }),
        button(t('tableDesigner', 'Open the values'), { icon: 'edit', disabled: !tb.fields.length, onClick: () => void this.shell.openConstants() }),
      );
      clear(this.tabsEl);
      this.renderFields(tb, tb.fields, (x) => x.fields, this.selected, (k) => ((this.selected = k), this.render()));
      return;
    }
    clear(
      toolbar,
      icon(tb.icon ?? 'table'),
      h('span', { class: 'page-title' }, tb.title),
      h('span', { class: 'muted mono' }, tb.name),
      h('span', { class: 'spacer' }),
      button(t('tableDesigner', 'Open the data'), { icon: 'table', onClick: () => this.shell.openTarget({ kind: 'table', name: tb.name }) }),
      button(t('tableDesigner', 'Form'), { icon: 'form', onClick: () => (this.shell.session.config.forms.some((f) => f.table === tb.name) ? openDesigner(this.shell, { kind: 'form', name: this.shell.session.config.forms.find((f) => f.table === tb.name)!.name }) : void createForm(this.shell, tb)) }),
      button(t('tableDesigner', 'New view'), { icon: 'columns', onClick: () => void createView(this.shell, tb) }),
    );
    const tabs: [Tab, string, boolean][] = [
      ['fields', t('tableDesigner', 'Fields'), true],
      ['parts', t('tableDesigner', 'Parts'), tb.kind !== 'register'],
      ['posting', t('tableDesigner', 'Posting'), tb.kind !== 'register'],
      ['checks', t('tableDesigner', 'Checks'), true],
    ];
    clear(
      this.tabsEl,
      ...tabs
        .filter(([, , shown]) => shown)
        .map(([key, title]) => {
          const count = key === 'fields' ? tb.fields.length : key === 'parts' ? (tb.parts ?? []).length : key === 'posting' ? (tb.posting ?? []).length : (tb.validations ?? []).length;
          return h('button', { type: 'button', class: `subtab${this.tab === key ? ' active' : ''}`, 'data-tab': key, onclick: () => ((this.tab = key), this.render()) }, title, h('span', { class: 'count' }, String(count)));
        }),
    );
    if (this.tab === 'fields') this.renderFields(tb, tb.fields, (x) => x.fields, this.selected, (k) => ((this.selected = k), this.render()));
    else if (this.tab === 'parts') this.renderParts(tb);
    else if (this.tab === 'posting') this.renderPosting(tb);
    else this.renderChecks(tb);
    if (this.tab !== 'fields' && this.tab !== 'parts') this.renderTableProps(tb);
  }

  /* ------------------------------ fields ------------------------------ */

  private renderFields(tb: TableDef, fields: FieldDef[], access: (tb: TableDef) => FieldDef[], selected: string | null, select: (key: string | null) => void, scopeExtra: string[] = []): void {
    const sys = this.part ? [] : allFields(tb).filter((f) => f.key.startsWith('sys_'));
    const rows = fields.map((f, i) => {
      const tr = h(
        'tr',
        { class: f.key === selected ? 'selected' : '', 'data-field': f.name, tabindex: 0 },
        h('td', { class: 'muted' }, String(i + 1)),
        h('td', { class: 'mono' }, f.name),
        h('td', null, f.title ?? ''),
        h('td', null, typeTitle(f.type), f.type === 'ref' ? ` → ${f.ref ?? '?'}` : f.type === 'enum' ? ` (${f.enum ?? t('tableDesigner', 'own list')})` : f.type === 'decimal' ? ` (${f.scale ?? 2})` : ''),
        h('td', { class: 'center' }, f.required ? '✓' : ''),
        h('td', { class: 'mono muted' }, f.computed ? `= ${f.computed}` : f.default ? `:= ${f.default}` : ''),
      );
      tr.addEventListener('click', () => select(f.key));
      return tr;
    });
    const sysRows = sys.map((f) => h('tr', { class: 'muted' }, h('td', null, ''), h('td', { class: 'mono' }, f.name), h('td', null, f.title ?? ''), h('td', null, typeTitle(f.type)), h('td', null, ''), h('td', null, t('tableDesigner', 'system'))));
    const moveBy = (by: number) => {
      if (!selected) return;
      void this.change((x) => {
        const list = this.part ? (x.parts ?? []).find((p) => p.key === this.part)?.fields : access(x);
        if (!list) return;
        const at = list.findIndex((f) => f.key === selected);
        const to = at + by;
        if (at < 0 || to < 0 || to >= list.length) return;
        const [f] = list.splice(at, 1);
        list.splice(to, 0, f!);
      });
    };
    clear(
      this.main,
      h(
        'div',
        { class: 'f-buttons' },
        button(t('tableDesigner', 'Add a field'), { icon: 'plus', class: 'primary', onClick: () => void this.addField() }),
        button(null, { icon: 'arrowUp', title: t('tableDesigner', 'Move up'), disabled: !selected, onClick: () => moveBy(-1) }),
        button(null, { icon: 'arrowDown', title: t('tableDesigner', 'Move down'), disabled: !selected, onClick: () => moveBy(1) }),
        button(t('tableDesigner', 'Delete'), { icon: 'trash', class: 'danger', disabled: !selected, onClick: () => void this.deleteField(selected!) }),
      ),
      h(
        'table',
        { class: 'design-table' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('tableDesigner', 'Name')), h('th', null, t('tableDesigner', 'Title')), h('th', null, t('tableDesigner', 'Type')), h('th', null, t('tableDesigner', 'Required')), h('th', null, t('tableDesigner', 'Value')))),
        h('tbody', null, rows, sysRows),
      ),
    );
    const f = fields.find((x) => x.key === selected);
    if (f) this.renderFieldProps(tb, f, scopeExtra);
    else this.renderTableProps(tb);
  }

  private async addField(): Promise<void> {
    const tb = this.tb();
    if (!tb) return;
    const inPart = this.tab === 'parts' && this.part;
    const title = await prompt(t('tableDesigner', 'New field'), t('tableDesigner', 'Title'), '');
    if (!title) return;
    const existing = inPart ? ((tb.parts ?? []).find((p) => p.key === this.part)?.fields ?? []) : allFields(tb);
    let name = identFrom(title, false);
    let n = 2;
    while (existing.some((f) => f.name === name)) name = `${identFrom(title, false)}${n++}`;
    const f: FieldDef = { key: newKey('f'), name, title, type: 'string' };
    await this.change((x) => {
      if (inPart) (x.parts ?? []).find((p) => p.key === this.part)?.fields.push(f);
      else x.fields.push(f);
    });
    if (inPart) this.partField = f.key;
    else {
      this.tab = 'fields';
      this.selected = f.key;
    }
    this.render();
    setTimeout(() => this.el.querySelector<HTMLSelectElement>('.props select[data-prop]')?.focus(), 50);
  }

  private async deleteField(key: string): Promise<void> {
    const tb = this.tb();
    if (!tb) return;
    const list = this.tab === 'parts' ? (tb.parts ?? []).find((p) => p.key === this.part)?.fields : tb.fields;
    const f = list?.find((x) => x.key === key);
    if (!f) return;
    if (!(await confirm(t('tableDesigner', 'Delete the field'), t('tableDesigner', 'Delete “{field}” and its values in every record?', { field: f.title ?? f.name }), t('tableDesigner', 'Delete'), true))) return;
    await this.change((x) => {
      if (this.tab === 'parts') {
        const p = (x.parts ?? []).find((pp) => pp.key === this.part);
        if (p) p.fields = p.fields.filter((ff) => ff.key !== key);
      } else x.fields = x.fields.filter((ff) => ff.key !== key);
    });
    if (this.tab === 'parts') this.partField = null;
    else this.selected = null;
    this.render();
  }

  private renderFieldProps(tb: TableDef, f: FieldDef, scopeExtra: string[]): void {
    const config = this.shell.session.config;
    const inPart = this.tab === 'parts';
    const set = (fn: (field: FieldDef) => void) =>
      void this.change((x) => {
        const list = inPart ? (x.parts ?? []).find((p) => p.key === this.part)?.fields : x.fields;
        const target = list?.find((ff) => ff.key === f.key);
        if (target) fn(target);
      });
    const names = () => {
      const current = this.tb();
      if (!current) return [];
      return inPart ? [...((current.parts ?? []).find((p) => p.key === this.part)?.fields.map((x) => x.name) ?? []), ...scopeExtra] : allFields(current).map((x) => x.name).concat(['id']);
    };
    const typeSel = selectProp<FieldType>(t('tableDesigner', 'Type'), f.type, TYPE_OPTIONS.map(([v]) => [v, typeTitle(v)]), (v) => set((x) => {
      x.type = v;
      if (v === 'decimal' && x.scale === undefined) x.scale = 2;
      if (v === 'ref' && !x.ref) x.ref = config.tables.find((tt) => tt.key !== tb.key)?.name ?? tb.name;
      if (v === 'enum' && !x.enum && !x.options) x.options = [{ value: 'a', title: 'A' }];
    }));
    clear(
      this.props,
      section(
        t('tableDesigner', 'Field'),
        textProp(t('tableDesigner', 'Title'), f.title, (v) => set((x) => (x.title = v))),
        textProp(t('tableDesigner', 'Name'), f.name, (v) => {
          if (!IDENT.test(v)) return toast(t('tableDesigner', 'The name must be a Latin identifier'), 'error');
          set((x) => (x.name = v));
        }, { mono: true, hint: t('tableDesigner', 'Used in expressions; renaming keeps the data') }),
        typeSel,
        f.type === 'decimal' ? numberProp(t('tableDesigner', 'Decimals'), f.scale, (v) => set((x) => (x.scale = v ?? 2))) : null,
        f.type === 'decimal'
          ? selectProp(
              t('tableDesigner', 'Decimals from'),
              f.scaleFrom ?? '',
              [['', t('tableDesigner', 'Always the same')], ...(inPart ? ((tb.parts ?? []).find((p) => p.key === this.part)?.fields ?? []) : tb.fields).filter((x) => x.key !== f.key && (x.type === 'integer' || x.type === 'decimal')).map((x) => [x.name, x.title ?? x.name] as [string, string])],
              (v) => set((x) => (v ? (x.scaleFrom = v) : delete x.scaleFrom)),
            )
          : null,
        f.type === 'decimal' ? checkProp(t('tableDesigner', 'Money'), f.money, (v) => set((x) => (x.money = v || undefined))) : null,
        f.type === 'ref' ? selectProp(t('tableDesigner', 'Refers to'), f.ref, config.tables.map((x) => [x.name, x.title] as [string, string]), (v) => set((x) => (x.ref = v))) : null,
        f.type === 'enum'
          ? selectProp(t('tableDesigner', 'Values from'), f.enum ?? '', [['', t('tableDesigner', 'Its own list')], ...config.enums.map((e) => [e.name, e.title ?? e.name] as [string, string])], (v) => set((x) => {
              if (v) {
                x.enum = v;
                delete x.options;
              } else {
                delete x.enum;
                x.options = x.options ?? [{ value: 'a', title: 'A' }];
              }
            }))
          : null,
        f.type === 'enum' && !f.enum
          ? textProp(t('tableDesigner', 'Values'), (f.options ?? []).map((o) => `${o.value}=${o.title}`).join('\n'), (v) => set((x) => (x.options = v.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
              const [value, ...rest] = line.split('=');
              return { value: value!.trim(), title: (rest.join('=') || value!).trim() };
            }))), { multiline: true, hint: t('tableDesigner', 'One per line: value=Title') })
          : null,
        tb.kind === 'register' && !inPart ? selectProp(t('tableDesigner', 'Role'), f.role ?? 'attribute', [['dimension', t('tableDesigner', 'Dimension')], ['resource', t('tableDesigner', 'Resource (summed)')], ['attribute', t('tableDesigner', 'Attribute')]], (v) => set((x) => (x.role = v))) : null,
        checkProp(t('tableDesigner', 'Required'), f.required, (v) => set((x) => (x.required = v || undefined))),
        !inPart ? checkProp(t('tableDesigner', 'Unique'), f.unique, (v) => set((x) => (x.unique = v || undefined))) : null,
        checkProp(t('tableDesigner', 'In lists'), f.list !== false, (v) => set((x) => (v ? delete x.list : (x.list = false)))),
        textProp(t('tableDesigner', 'Hint'), f.description, (v) => set((x) => (x.description = v || undefined))),
      ),
      section(
        t('tableDesigner', 'Values'),
        exprProp(t('tableDesigner', 'Default value'), f.default, names, (v) => set((x) => (x.default = v || undefined)), { placeholder: "today(), 'pcs', product.price", hint: t('tableDesigner', 'An expression evaluated for a new record') }),
        exprProp(t('tableDesigner', 'Computed as'), f.computed, names, (v) => set((x) => (x.computed = v || undefined)), { placeholder: 'round(qty * price, 2)', hint: t('tableDesigner', 'The field is calculated and read-only') }),
        f.computed ? checkProp(t('tableDesigner', 'Store it'), f.stored, (v) => set((x) => (x.stored = v || undefined)), t('tableDesigner', 'Keep the computed value in the data source, so it can be searched there')) : null,
        exprProp(t('tableDesigner', 'Visible when'), f.visible, names, (v) => set((x) => (x.visible = v || undefined)), { placeholder: "kind = 'customer'" }),
        exprProp(t('tableDesigner', 'Read-only when'), typeof f.readonly === 'string' ? f.readonly : f.readonly ? 'true' : '', names, (v) => set((x) => (x.readonly = v === 'true' ? true : v || undefined))),
      ),
      section(
        t('tableDesigner', 'Limits'),
        f.type === 'integer' || f.type === 'decimal' ? numberProp(t('tableDesigner', 'Minimum'), f.min, (v) => set((x) => (x.min = v))) : null,
        f.type === 'integer' || f.type === 'decimal' ? numberProp(t('tableDesigner', 'Maximum'), f.max, (v) => set((x) => (x.max = v))) : null,
        f.type === 'string' || f.type === 'text' ? numberProp(t('tableDesigner', 'Max length'), f.maxLength, (v) => set((x) => (x.maxLength = v))) : null,
        f.type === 'string' ? textProp(t('tableDesigner', 'Pattern'), f.pattern, (v) => set((x) => (x.pattern = v || undefined)), { mono: true, placeholder: '^[0-9]{8}$' }) : null,
        numberProp(t('tableDesigner', 'Column width'), f.width, (v) => set((x) => (x.width = v))),
      ),
    );
  }

  private renderTableProps(tb: TableDef): void {
    if (this.constants) {
      clear(this.props, h('div', { class: 'muted', style: { padding: '12px', fontSize: '12px' } }, t('tableDesigner', 'The constants are one record: each field is a setting, read as $const.name. Their values are edited in the application.')));
      return;
    }
    const config = this.shell.session.config;
    const set = (fn: (x: TableDef) => void) => void this.change((x) => fn(x));
    clear(
      this.props,
      section(
        t('tableDesigner', 'Table'),
        textProp(t('tableDesigner', 'Title'), tb.title, (v) => set((x) => (x.title = v || x.title))),
        textProp(t('tableDesigner', 'One record is'), tb.itemTitle, (v) => set((x) => (x.itemTitle = v || undefined)), { placeholder: t('tableDesigner', 'Product, Invoice…') }),
        textProp(t('tableDesigner', 'Name'), tb.name, (v) => {
          if (!IDENT.test(v)) return toast(t('tableDesigner', 'The name must be a Latin identifier'), 'error');
          void this.rename(tb, v);
        }, { mono: true }),
        selectProp<TableKind>(t('tableDesigner', 'Kind'), tb.kind, [['catalog', t('tableDesigner', 'Catalog')], ['document', t('tableDesigner', 'Document')], ['register', t('tableDesigner', 'Register')], ['table', t('tableDesigner', 'Plain table')]], (v) => set((x) => (x.kind = v))),
        iconProp(t('tableDesigner', 'Icon'), tb.icon, (v) => set((x) => (x.icon = v))),
        selectProp(t('tableDesigner', 'Shown as'), tb.display ?? '', allFields(tb).filter((f) => f.type === 'string' || f.type === 'integer').map((f) => [f.name, f.title ?? f.name] as [string, string]), (v) => set((x) => (x.display = v || undefined)), true),
        tb.kind === 'catalog' ? checkProp(t('tableDesigner', 'Groups (tree)'), tb.hierarchical, (v) => set((x) => (x.hierarchical = v || undefined))) : null,
        tb.kind !== 'register' ? checkProp(t('tableDesigner', 'Versioned'), tb.versioned, (v) => set((x) => (v ? (x.versioned = true) : delete x.versioned)), t('tableDesigner', 'An edit opens a new version from now and a delete closes it: what was planned before stays as it was')) : null,
        tb.kind !== 'register' ? checkProp(t('tableDesigner', 'Ordered by hand'), tb.orderable, (v) => set((x) => (v ? (x.orderable = true) : delete x.orderable)), t('tableDesigner', 'Records keep the order the person sets with Alt+↑/↓')) : null,
        tb.kind === 'document' ? textProp(t('tableDesigner', 'Number format'), tb.numbering?.format ?? '{000000}', (v) => set((x) => (x.numbering = { sequence: x.numbering?.sequence ?? x.name, format: v || '{000000}' })), { mono: true, hint: t('tableDesigner', '{000000} is the counter: INV-{0000}') }) : null,
        selectProp(t('tableDesigner', 'Connection'), tb.connection ?? '', config.connections.map((c) => [c.id, c.title ?? c.id] as [string, string]), (v) => set((x) => (x.connection = v || undefined)), true),
        checkProp(t('tableDesigner', 'Read only'), tb.readOnly, (v) => set((x) => (x.readOnly = v || undefined))),
        textProp(t('tableDesigner', 'Description'), tb.description, (v) => set((x) => (x.description = v || undefined)), { multiline: true, hint: t('tableDesigner', 'Shown above the list') }),
      ),
    );
  }

  /** Renames the table and every reference to it in the configuration. */
  private async rename(tb: TableDef, to: string): Promise<void> {
    if (tableOf(this.shell.session.config, to)) return toast(t('tableDesigner', 'There is already a table named “{name}”', { name: to }), 'error');
    const from = tb.name;
    await this.shell.session
      .change((c) => {
        for (const x of c.tables) {
          if (x.name === from) x.name = to;
          for (const f of [...x.fields, ...(x.parts ?? []).flatMap((p) => p.fields)]) if (f.ref === from) f.ref = to;
          for (const p of x.posting ?? []) if (p.register === from) p.register = to;
        }
        for (const v of c.views) if (v.table === from) v.table = to;
        for (const f of c.forms) if (f.table === from) f.table = to;
        for (const a of c.actions) if (a.table === from) a.table = to;
        for (const tr of c.triggers) if (tr.table === from) tr.table = to;
        for (const p of c.printTemplates) if (p.table === from) p.table = to;
        for (const r of c.reports) if (r.source === from || r.source.startsWith(`${from}.`)) r.source = to + r.source.slice(from.length);
        const walk = (nodes: Config['menu']) => {
          for (const n of nodes) {
            if (n.target?.kind === 'table' && n.target.name === from) n.target.name = to;
            if (n.children) walk(n.children);
          }
        };
        walk(c.menu);
      })
      .catch((e: unknown) => this.shell.fail(e));
  }

  /* ------------------------------ parts ------------------------------ */

  private renderParts(tb: TableDef): void {
    const parts = tb.parts ?? [];
    if (this.part && !parts.some((p) => p.key === this.part)) this.part = null;
    this.part ??= parts[0]?.key ?? null;
    const part = parts.find((p) => p.key === this.part);
    const chooser = h(
      'div',
      { class: 'f-buttons' },
      ...parts.map((p) => button(p.title ?? p.name, { class: p.key === this.part ? 'active' : 'outline', onClick: () => ((this.part = p.key), (this.partField = null), this.render()) })),
      button(t('tableDesigner', 'New part'), {
        icon: 'plus',
        onClick: async () => {
          const title = await prompt(t('tableDesigner', 'New part'), t('tableDesigner', 'Title'), t('tableDesigner', 'Lines'));
          if (!title) return;
          const p: PartDef = { key: newKey('p'), name: identFrom(title, false), title, fields: [{ key: newKey('f'), name: 'item', title: t('tableDesigner', 'Item'), type: 'string' }] };
          await this.change((x) => (x.parts = [...(x.parts ?? []), p]));
          this.part = p.key;
          this.render();
        },
      }),
    );
    if (!part) {
      clear(this.main, chooser, h('p', { class: 'muted' }, t('tableDesigner', 'A part is a list of lines inside each record: the goods of an invoice. It is edited right in the card.')));
      this.renderTableProps(tb);
      return;
    }
    this.renderFields(tb, part.fields, (x) => (x.parts ?? []).find((p) => p.key === this.part)?.fields ?? [], this.partField, (k) => ((this.partField = k), this.render()), ['doc', '$this']);
    this.main.prepend(
      chooser,
      h(
        'div',
        { class: 'row', style: { marginBottom: '8px' } },
        textProp(t('tableDesigner', 'Part title'), part.title, (v) => void this.change((x) => {
          const p = (x.parts ?? []).find((pp) => pp.key === part.key);
          if (p) p.title = v;
        })),
        button(t('tableDesigner', 'Delete the part'), {
          icon: 'trash',
          class: 'danger',
          onClick: async () => {
            if (!(await confirm(t('tableDesigner', 'Delete the part'), t('tableDesigner', 'Delete “{part}” with its lines in every record?', { part: part.title ?? part.name }), t('tableDesigner', 'Delete'), true))) return;
            await this.change((x) => (x.parts = (x.parts ?? []).filter((p) => p.key !== part.key)));
          },
        }),
      ),
    );
    this.main.append(this.renderFill(tb, part));
    if (!this.partField) this.renderTableProps(tb);
  }

  /** Where a new record's lines come from: one per row of a table. */
  private renderFill(tb: TableDef, part: PartDef): HTMLElement {
    const config = this.shell.session.config;
    const setFill = (fn: (fill: NonNullable<PartDef['fill']>) => void) =>
      void this.change((x) => {
        const p = (x.parts ?? []).find((pp) => pp.key === part.key);
        if (p?.fill) fn(p.fill);
      });
    const fill = part.fill;
    const src = fill ? tableOf(config, fill.from) : undefined;
    const names = () => (src ? [...allFields(src).map((f) => f.name), 'id', 'doc'] : ['doc']);
    return h(
      'fieldset',
      { class: 'f-group', style: { marginTop: '12px' } },
      h('legend', null, t('tableDesigner', 'Filled from')),
      selectProp(
        t('tableDesigner', 'Lines of a new record'),
        fill?.from ?? '',
        [['', t('tableDesigner', 'Empty: added by hand')], ...config.tables.filter((x) => x.kind !== 'register' && x.key !== tb.key).map((x) => [x.name, t('tableDesigner', 'One per record of “{table}”', { table: x.title })] as [string, string])],
        (v) =>
          void this.change((x) => {
            const p = (x.parts ?? []).find((pp) => pp.key === part.key);
            if (!p) return;
            if (!v) return void delete p.fill;
            const target = tableOf(config, v);
            const refField = p.fields.find((f) => f.type === 'ref' && f.ref === v);
            p.fill = { from: v, set: refField ? { [refField.name]: 'id' } : {}, ...(target?.fields.some((f) => f.name === 'archived') ? { where: 'not archived' } : {}) };
          }),
      ),
      fill ? exprProp(t('tableDesigner', 'Only the records where'), fill.where, names, (v) => setFill((f) => (v ? (f.where = v) : delete f.where)), { placeholder: 'not archived' }) : null,
      ...(fill ? part.fields.map((pf) => exprProp(`${pf.title ?? pf.name} (${pf.name})`, fill.set[pf.name], names, (v) => setFill((f) => (v ? (f.set[pf.name] = v) : delete f.set[pf.name])), { placeholder: pf.type === 'ref' && pf.ref === fill.from ? 'id' : '' })) : []),
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '4px 0 0' } }, t('tableDesigner', 'A new record starts with a line for each record of the table — each account for a reconciliation, each product for a stocktaking. The values are expressions over that record; doc.x is the new record’s field. The “Fill the lines again” step refills them.')),
    );
  }

  /* ------------------------------ posting ------------------------------ */

  private renderPosting(tb: TableDef): void {
    const config = this.shell.session.config;
    const registers = config.tables.filter((x) => x.kind === 'register');
    const rules = tb.posting ?? [];
    const schedules = tb.fields.filter((f) => f.type === 'schedule');
    const setRule = (key: string, fn: (r: PostingRule) => void) => void this.change((x) => {
      const r = (x.posting ?? []).find((rr) => rr.key === key);
      if (r) fn(r);
    });
    const blocks = rules.map((rule) => {
      const register = tableOf(config, rule.register);
      const sourceNames = rule.from === 'header' ? allFields(tb).map((f) => f.name) : [...((tb.parts ?? []).find((p) => p.name === rule.from)?.fields.map((f) => f.name) ?? []), 'doc'];
      return h(
        'fieldset',
        { class: 'f-group' },
        h('legend', null, `${rule.direction === 'in' ? '＋' : '−'} ${register?.title ?? rule.register}`),
        h(
          'div',
          { class: 'f-columns' },
          selectProp(t('tableDesigner', 'Register'), rule.register, registers.map((r) => [r.name, r.title] as [string, string]), (v) => setRule(rule.key, (r) => (r.register = v))),
          selectProp(
            t('tableDesigner', 'One movement per'),
            rule.from,
            [
              ['header', tb.kind === 'document' ? t('tableDesigner', 'document') : t('tableDesigner', 'record')],
              ...(tb.parts ?? []).map((p) => [p.name, t('tableDesigner', 'line of “{part}”', { part: p.title ?? p.name })] as [string, string]),
              ...(schedules.length ? [['schedule', t('tableDesigner', 'time the schedule comes round (planned)')] as [string, string]] : []),
            ],
            (v) =>
              setRule(rule.key, (r) => {
                r.from = v;
                if (v === 'schedule') r.schedule ??= schedules[0]?.name;
                else delete r.schedule;
              }),
          ),
          rule.from === 'schedule' && schedules.length > 1 ? selectProp(t('tableDesigner', 'Schedule'), rule.schedule, schedules.map((f) => [f.name, f.title ?? f.name] as [string, string]), (v) => setRule(rule.key, (r) => (r.schedule = v))) : null,
          selectProp(t('tableDesigner', 'Direction'), rule.direction, [['in', t('tableDesigner', 'In (adds)')], ['out', t('tableDesigner', 'Out (takes)')]], (v) => setRule(rule.key, (r) => (r.direction = v))),
        ),
        exprProp(t('tableDesigner', 'Only when'), rule.when, () => sourceNames, (v) => setRule(rule.key, (r) => (v ? (r.when = v) : delete r.when)), { placeholder: "type = 'income'" }),
        exprProp(t('tableDesigner', 'Date of the movement'), rule.date, () => sourceNames, (v) => setRule(rule.key, (r) => (v ? (r.date = v) : delete r.date)), { placeholder: tb.kind === 'document' ? 'date' : '_createdAt' }),
        ...(register?.fields ?? []).map((rf) => exprProp(`${rf.title ?? rf.name}${rf.role === 'dimension' ? ` (${t('tableDesigner', 'dimension')})` : rf.role === 'resource' ? ` (${t('tableDesigner', 'resource')})` : ''}`, rule.set[rf.name], () => sourceNames, (v) => setRule(rule.key, (r) => (v ? (r.set[rf.name] = v) : delete r.set[rf.name])), { placeholder: rf.role === 'dimension' ? rf.name : 'qty' })),
        button(t('tableDesigner', 'Delete the rule'), { icon: 'trash', class: 'danger', onClick: () => void this.change((x) => (x.posting = (x.posting ?? []).filter((r) => r.key !== rule.key))) }),
      );
    });
    clear(
      this.main,
      h('p', { class: 'muted' }, tb.kind === 'document' ? t('tableDesigner', 'When a document is posted, each rule writes movements into a register: the register’s fields are expressions over the line (or the document); doc.x is the document’s field. Movements are rewritten on every save.') : t('tableDesigner', 'Every record writes movements into a register by these rules — an opening balance, say: the register’s fields are expressions over the record. Movements are rewritten on every save.')),
      ...blocks,
      tb.kind === 'document' || rules.length
        ? h(
            'fieldset',
            { class: 'f-group' },
            h('legend', null, t('tableDesigner', 'Closed period')),
            exprProp(t('tableDesigner', 'Closed when'), tb.lockedWhen, () => allFields(this.tb() ?? tb).map((f) => f.name), (v) => void this.change((x) => (v ? (x.lockedWhen = v) : delete x.lockedWhen)), { placeholder: "date <= maxOf('Closings', 'date')" }),
            textProp(t('tableDesigner', 'Message'), tb.lockedMessage, (v) => void this.change((x) => (v ? (x.lockedMessage = v) : delete x.lockedMessage)), { placeholder: t('tableDesigner', 'The record is in a closed period') }),
            h('p', { class: 'muted', style: { fontSize: '12px', margin: '4px 0 0' } }, t('tableDesigner', 'While it is true, the record cannot be posted, and one posted there cannot be changed, unposted or deleted. Unposted, it can be kept as a note.')),
          )
        : null,
      h(
        'div',
        { class: 'f-buttons' },
        button(t('tableDesigner', 'Add a rule'), {
          icon: 'plus',
          class: 'primary',
          disabled: !registers.length,
          onClick: () =>
            void this.change((x) => {
              const reg = registers[0]!;
              x.posting = [...(x.posting ?? []), { key: newKey('po'), register: reg.name, from: x.parts?.[0]?.name ?? 'header', direction: 'in', set: Object.fromEntries(reg.fields.filter((f) => x.parts?.[0]?.fields.some((pf) => pf.name === f.name)).map((f) => [f.name, f.name])) }];
            }),
        }),
        !registers.length ? h('span', { class: 'muted' }, t('tableDesigner', 'Create a register first')) : null,
        rules.length ? button(t('tableDesigner', 'Repost all documents'), { icon: 'refresh', onClick: () => void this.repost(tb) }) : null,
      ),
    );
  }

  private async repost(tb: TableDef): Promise<void> {
    const { repost } = await import('../../core/registers');
    try {
      const n = await repost(this.shell.data, tb, (done, total) => this.shell.status(`${done} / ${total}`));
      toast(t('tableDesigner', '{n} documents reposted', { n }), 'ok');
    } catch (error) {
      this.shell.fail(error);
    }
  }

  /* ------------------------------ checks ------------------------------ */

  private renderChecks(tb: TableDef): void {
    const names = () => allFields(this.tb() ?? tb).map((f) => f.name);
    const list = tb.validations ?? [];
    clear(
      this.main,
      h('p', { class: 'muted' }, t('tableDesigner', 'A check is an expression that is true when the record is wrong: the message is shown and the record is not saved — or, for a warning, saved all the same.')),
      ...list.map((v, i) =>
        h(
          'fieldset',
          { class: 'f-group' },
          exprProp(t('tableDesigner', 'Wrong when'), v.when, names, (val) => void this.change((x) => (x.validations![i]!.when = val))),
          textProp(t('tableDesigner', 'Message'), v.message, (val) => void this.change((x) => (x.validations![i]!.message = val))),
          selectProp(t('tableDesigner', 'Then'), v.level ?? 'error', [['error', t('tableDesigner', 'The record is not saved')], ['warning', t('tableDesigner', 'A warning; the record is saved')]], (val) => void this.change((x) => (val === 'warning' ? (x.validations![i]!.level = 'warning') : delete x.validations![i]!.level))),
          button(t('tableDesigner', 'Delete'), { icon: 'trash', class: 'danger', onClick: () => void this.change((x) => x.validations!.splice(i, 1)) }),
        ),
      ),
      button(t('tableDesigner', 'Add a check'), { icon: 'plus', class: 'primary', onClick: () => void this.change((x) => (x.validations = [...(x.validations ?? []), { when: 'false', message: t('tableDesigner', 'Describe the problem') }])) }),
    );
  }
}
