/**
 * A record's card (Task.md 8.4): the form's layout rendered with an editor
 * per field, parts edited in their grids, related records in tabs, computed
 * fields recomputed as you type, checks shown by the fields, the conflict of
 * a record someone else changed, posting.
 *
 * The form designer renders the canvas with the same renderLayout(), so what
 * is designed is what is used.
 */
import { t } from '../../core/i18n';
import { CONSTANTS, field as fieldOf, fieldTitle, formFor, isNumeric, table as tableOf } from '../../core/config/model';
import type { ActionDef, FieldDef, FormDef, FormNode, PartDef, TableDef } from '../../core/config/types';
import { parseCached, partTableOf, truthy, ValidationError, type Problem } from '../../core/data';
import { evaluate } from '../../core/expr/index';
import { fieldChanged } from '../../core/actions';
import { PluginError } from '../../core/plugin-protocol';
import type { Row } from '../../core/query/types';
import { button, clear, h, icon, modKey } from '../dom';
import { uuid } from '../../core/ids';
import { columnMaps, editorFor, gridColumns, type Editor } from '../fields';
import { scaled } from '../../core/format';
import { Grid, type GridColumn } from '../grid';
import { confirm, dialog, popupMenu, toast, type MenuItem } from '../ui';
import type { App, Page } from '../app';
import { ListPage } from './list';
import { printRecords } from './print';

export class CardPage implements Page {
  id: string;
  title: string;
  icon?: string;
  readonly el: HTMLElement;
  private tb: TableDef;
  private form: FormDef;
  private row: Row = { id: '' };
  private original: Row | null = null;
  private editors = new Map<string, { editor: Editor; field: FieldDef }>();
  private parts = new Map<string, { grid: Grid<Row>; part: PartDef }>();
  private related: ListPage[] = [];
  private changed = false;
  private body: HTMLElement;
  private head: HTMLElement;
  private toolbar: HTMLElement;
  private errors: HTMLElement;
  private saving = false;
  private conditional: { el: HTMLElement; field: FieldDef; editor: Editor }[] = [];
  private unsubscribe: () => void;

  constructor(
    private readonly app: App,
    table: string,
    private recordId: string | null,
    private readonly init: Record<string, unknown> = {},
    private readonly onSaved?: (row: Row) => void,
  ) {
    this.tb = app.data.table(table);
    this.form = formFor(app.data.config, this.tb);
    this.id = recordId ? `record:${table}:${recordId}` : `new:${table}:${Math.random().toString(36).slice(2)}`;
    this.title = this.tb.itemTitle ?? this.tb.title;
    this.icon = this.tb.icon ?? 'form';
    this.toolbar = h('div', { class: 'toolbar' });
    this.head = h('div', { class: 'card-head' });
    this.errors = h('div', { class: 'form-errors hidden', role: 'alert' });
    this.body = h('div', { class: 'card-body' }, this.errors);
    this.body.addEventListener('keydown', (e) => this.enterKey(e));
    this.el = h('div', { class: 'page' }, this.toolbar, this.head, this.body);
    this.unsubscribe = app.data.onChange((tables) => {
      if (tables.includes(this.tb.name) && this.recordId && !this.changed && !this.saving) void this.reload();
    });
    void this.load();
  }

  dirty(): boolean {
    return this.changed;
  }

  async canClose(): Promise<boolean> {
    if (!this.changed) return true;
    const answer = await dialog<'save' | 'discard' | 'cancel'>({
      title: t('card', 'Unsaved changes'),
      body: t('card', '“{title}” has changes that are not saved.', { title: this.title }),
      buttons: [
        { label: t('card', 'Discard'), value: 'discard', danger: true, left: true },
        { label: t('card', 'Cancel'), value: 'cancel' },
        { label: t('card', 'Save'), value: 'save', primary: true },
      ],
      cancel: 'cancel',
    });
    if (answer === 'cancel') return false;
    if (answer === 'save') return this.save();
    return true;
  }

  dispose(): void {
    this.unsubscribe();
    for (const r of this.related) r.dispose();
  }

  onKey(e: KeyboardEvent): boolean {
    if (modKey(e) && e.key.toLowerCase() === 's') {
      void this.save();
      return true;
    }
    if (modKey(e) && e.key === 'Enter') {
      void this.save().then((ok) => ok && this.app.closePage(this.id));
      return true;
    }
    return false;
  }

  /* ------------------------------ loading ------------------------------ */

  private async load(): Promise<void> {
    try {
      if (this.recordId) {
        const row = await this.app.data.get(this.tb.name, this.recordId);
        if (!row) throw new PluginError('not_found', t('card', 'The record was deleted'));
        await this.app.data.compute(this.tb, [row]);
        this.original = structuredClone(row);
        this.row = row;
      } else {
        this.row = await this.app.data.newRecord(this.tb, this.init);
        await this.app.data.compute(this.tb, [this.row]);
        this.original = null;
        this.changed = Object.keys(this.init).length > 0 && !this.init.parent && !('isFolder' in this.init && Object.keys(this.init).length <= 2);
      }
      this.render();
    } catch (error) {
      this.app.fail(error, this.title);
      clear(this.body, h('div', { class: 'grid-empty' }, error instanceof Error ? error.message : String(error)));
    }
  }

  private async reload(): Promise<void> {
    if (!this.recordId) return;
    const row = await this.app.data.get(this.tb.name, this.recordId);
    if (!row) return;
    await this.app.data.compute(this.tb, [row]);
    this.original = structuredClone(row);
    this.row = row;
    this.render();
  }

  private render(): void {
    this.editors.clear();
    this.parts.clear();
    for (const r of this.related) r.dispose();
    this.related = [];
    this.conditional = [];
    this.form = formFor(this.app.data.config, this.tb);
    this.renderHead();
    this.renderToolbar();
    clear(this.body, this.errors, renderLayout(this.form.layout, this.renderers()));
    void this.applyConditions();
    // Only while the person has not clicked anywhere yet: taking the focus back would lose their typing.
    if (!this.recordId) {
      setTimeout(() => {
        if (this.el.contains(document.activeElement)) return;
        const chosen = this.form.focus ? this.editors.get(this.form.focus)?.editor : undefined;
        if (chosen) chosen.focus();
        else this.body.querySelector<HTMLElement>(EDITABLE)?.focus();
      }, 30);
    }
  }

  /**
   * A form for quick entry: Enter goes to the next field, and in the last one
   * saves and closes. A lookup or a line being edited keeps Enter for itself.
   */
  private enterKey(e: KeyboardEvent): void {
    if (!this.form.enterSaves || e.key !== 'Enter' || e.shiftKey || e.altKey || modKey(e) || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || target.closest('.f-part') || document.querySelector('.popup')) return;
    const fields = [...this.body.querySelectorAll<HTMLElement>(EDITABLE)].filter((x) => !x.closest('.f-part') && !x.closest('.hidden') && x.tagName !== 'TEXTAREA');
    const at = fields.indexOf(target);
    if (at < 0) return;
    e.preventDefault();
    const next = fields[at + 1];
    if (next) next.focus();
    else void this.save().then((ok) => ok && this.app.closePage(this.id));
  }

  hotkeyAction(a: ActionDef): boolean {
    if (a.table !== this.tb.name) return false;
    void this.runAction(a);
    return true;
  }

  private label(): string {
    if (!this.recordId) return t('card', '{what} (new)', { what: this.tb.itemTitle ?? this.tb.title });
    if (this.tb.name === CONSTANTS) return this.tb.title;
    return this.tb.kind === 'document' ? this.app.data.rowLabel(this.tb, this.row) : `${this.tb.itemTitle ?? this.tb.title}: ${this.app.data.rowLabel(this.tb, this.row)}`;
  }

  private renderHead(): void {
    this.title = this.label();
    const badges: Node[] = [];
    if (this.tb.kind === 'document') badges.push(h('span', { class: `badge-state${this.row.posted ? ' posted' : ''}` }, this.row.posted ? t('card', 'Posted') : t('card', 'Not posted')));
    if (this.row.isFolder) badges.push(h('span', { class: 'badge-state' }, t('card', 'Group')));
    if (this.changed) badges.push(h('span', { class: 'badge-state dirty' }, t('card', 'Not saved')));
    if (!this.app.data.writable(this.tb)) badges.push(h('span', { class: 'badge-state' }, icon('lock', 12), ' ', t('card', 'Read only')));
    clear(this.head, h('h2', null, this.title), ...badges);
    this.app.updateTab(this);
  }

  private actions(): ActionDef[] {
    return this.app.data.config.actions.filter((a) => a.table === this.tb.name && (a.where ?? ['list', 'card']).includes('card'));
  }

  private renderToolbar(): void {
    const writable = this.app.data.writable(this.tb);
    const items: (Node | null)[] = [
      button(t('card', 'Save and close'), { icon: 'check', class: 'primary', disabled: !writable, title: t('card', 'Save and close (Ctrl+Enter)'), onClick: () => void this.save().then((ok) => ok && this.app.closePage(this.id)) }),
      button(t('card', 'Save'), { icon: 'save', disabled: !writable, title: t('card', 'Save (Ctrl+S)'), onClick: () => void this.save() }),
    ];
    if (this.tb.kind === 'document' && this.tb.posting?.length) {
      items.push(h('span', { class: 'sep' }));
      items.push(
        this.row.posted
          ? button(t('card', 'Cancel posting'), { icon: 'unpost', disabled: !writable, onClick: () => void this.post(false) })
          : button(t('card', 'Post and close'), { icon: 'post', disabled: !writable, onClick: () => void this.post(true).then((ok) => ok && this.app.closePage(this.id)) }),
      );
    }
    const templates = this.app.data.config.printTemplates.filter((p) => p.table === this.tb.name);
    if (templates.length) {
      const print = button(t('card', 'Print'), { icon: 'print' });
      print.addEventListener('click', () => popupMenu(print, templates.map((p): MenuItem => ({ label: p.title, icon: 'doc', run: () => void this.print(p.name) }))));
      items.push(h('span', { class: 'sep' }), print);
    }
    const actions = this.actions();
    if (actions.length) {
      items.push(h('span', { class: 'sep' }));
      for (const a of actions.slice(0, 3)) items.push(button(a.title, { icon: a.icon ?? 'bolt', disabled: !this.recordId && !!a.table, onClick: () => void this.runAction(a) }));
      if (actions.length > 3) {
        const more = button(null, { icon: 'more', title: t('card', 'More actions') });
        more.addEventListener('click', () => popupMenu(more, actions.slice(3).map((a) => ({ label: a.title, icon: a.icon ?? 'bolt', run: () => void this.runAction(a) }))));
        items.push(more);
      }
    }
    items.push(h('span', { class: 'spacer' }));
    if (this.recordId) items.push(button(null, { icon: 'refresh', title: t('card', 'Reload'), onClick: () => void this.confirmReload() }));
    if (this.app.isDesign()) items.push(button(t('card', 'Design'), { icon: 'wrench', onClick: () => this.app.designTable(this.tb.name) }));
    clear(this.toolbar, ...items);
  }

  private async confirmReload(): Promise<void> {
    if (this.changed && !(await confirm(t('card', 'Reload'), t('card', 'Your changes will be lost.'), t('card', 'Reload'), true))) return;
    this.changed = false;
    await this.reload();
  }

  /* ------------------------------ layout ------------------------------ */

  private renderers(): LayoutRenderers {
    return {
      field: (node) => this.renderField(node),
      part: (node) => this.renderPart(node.part, node.title),
      related: (node) => this.renderRelated(node.table, node.field, node.title),
      action: (node) => {
        const a = this.app.data.config.actions.find((x) => x.name === node.action);
        if (!a) return h('span', { class: 'muted' }, `?${node.action}`);
        if (node.type === 'link') return h('button', { type: 'button', class: 'f-link', onclick: () => void this.runAction(a) }, node.title ?? a.title);
        return button(node.title ?? a.title, { icon: a.icon ?? 'bolt', class: 'outline', onClick: () => void this.runAction(a) });
      },
    };
  }

  private renderField(node: Extract<FormNode, { type: 'field' }>): HTMLElement {
    const f = fieldOf(this.tb, node.field);
    if (!f) return h('div', { class: 'f-text muted' }, `?${node.field}`);
    const readonly = !this.app.data.writable(this.tb) || f.readonly === true || !!f.computed || (f.name === 'number' && this.tb.kind === 'document' && !this.recordId);
    const editor = editorFor(this.app, scaled(f, this.row), this.row[f.name], (v) => void this.set(f, v));
    if (readonly) editor.setReadonly(true);
    if (f.name === 'number' && !this.recordId && this.tb.kind === 'document') (editor.el.querySelector('input') as HTMLInputElement | null)?.setAttribute('placeholder', t('card', 'assigned on saving'));
    this.editors.set(f.name, { editor, field: f });
    const title = node.title ?? fieldTitle(f);
    const labelEl = node.label === 'none' ? null : h('label', { title: f.description ?? title }, title, f.required ? h('span', { class: 'req' }, '*') : null);
    const el = h('div', { class: `f-field${node.label === 'top' ? ' top' : ''}`, 'data-field-row': f.name, style: node.span ? { gridColumn: `span ${node.span}` } : {} }, labelEl, h('div', null, editor.el, f.description && !readonly ? h('div', { class: 'help' }, f.description) : null));
    if (f.visible || typeof f.readonly === 'string') this.conditional.push({ el, field: f, editor });
    return el;
  }

  private async applyConditions(): Promise<void> {
    if (!this.conditional.length) return;
    const sources = this.conditional.flatMap((c) => [c.field.visible, typeof c.field.readonly === 'string' ? c.field.readonly : undefined]).filter((s): s is string => !!s);
    const envOf = await this.app.data.scope(this.tb, sources);
    const env = envOf(this.row);
    for (const c of this.conditional) {
      try {
        if (c.field.visible) c.el.classList.toggle('hidden', !truthy(evaluate(parseCached(c.field.visible), env)));
        if (typeof c.field.readonly === 'string') c.editor.setReadonly(truthy(evaluate(parseCached(c.field.readonly), env)));
      } catch {
        // A broken expression shows in the designer's problems; the form stays usable.
      }
    }
  }

  private async set(f: FieldDef, value: unknown): Promise<void> {
    this.row[f.name] = value;
    this.markChanged();
    this.editors.get(f.name)?.editor.setError(null);
    await fieldChanged(this.app.data, this.tb, this.row, f.name).catch((e: unknown) => this.app.fail(e));
    await this.recompute();
  }

  private markChanged(): void {
    if (!this.changed) {
      this.changed = true;
      this.renderHead();
    }
  }

  /** Computed fields and conditions after a change; the editors of changed values updated. */
  private async recompute(): Promise<void> {
    const before = new Map([...this.editors.keys()].map((k) => [k, this.row[k]]));
    await this.app.data.compute(this.tb, [this.row]);
    for (const [name, { editor, field }] of this.editors) {
      if (field.computed || before.get(name) !== this.row[name]) editor.set(this.row[name]);
    }
    for (const { grid, part } of this.parts.values()) {
      // Computed values of the lines, or lines a trigger filled again.
      grid.setRows((this.row[part.name] as Row[]) ?? []);
    }
    await this.applyConditions();
  }

  /* ------------------------------ parts ------------------------------ */

  private renderPart(name: string, title?: string): HTMLElement {
    const part = (this.tb.parts ?? []).find((p) => p.name === name);
    if (!part) return h('div', { class: 'muted' }, `?${name}`);
    const partTable = partTableOf(this.tb, part.name);
    const writable = this.app.data.writable(this.tb);
    if (!Array.isArray(this.row[part.name])) this.row[part.name] = [];
    const lines = () => this.row[part.name] as Row[];
    // Lines need ids for the grid; they are dropped on saving (storable keeps only fields).
    for (const l of lines()) l.__id ??= Math.random().toString(36).slice(2);
    const grid: Grid<Row> = new Grid<Row>({
      columns: [],
      idOf: (r) => String(r.__id),
      filterRow: false,
      multi: true,
      onEdit: (line, column, cell, done, initial) => this.editLine(part, line, column, cell, done, initial),
      onKey: (e) => {
        if (!writable) return false;
        if (e.key === 'Insert') {
          void addLine();
          return true;
        }
        if (e.key === 'Delete') {
          removeLines();
          return true;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const line = grid.current();
          const col = grid.columns.find((c) => c.editable);
          if (line && col) grid.edit(line, col, e.key);
          return true;
        }
        return false;
      },
      footer: true,
    });
    const addLine = async () => {
      const line = (await this.app.data.newLine(this.tb, part.name, this.row)) as Row;
      line.__id = Math.random().toString(36).slice(2);
      lines().push(line);
      this.markChanged();
      await this.recompute();
      grid.setRows(lines());
      grid.focusRow(String(line.__id));
      const first = grid.columns.find((c) => c.editable);
      if (first) grid.edit(line, first);
    };
    const removeLines = () => {
      const doomed = new Set(grid.selection());
      if (!doomed.size) return;
      this.row[part.name] = lines().filter((l) => !doomed.has(l));
      this.markChanged();
      void this.recompute();
      grid.setRows(lines());
    };
    const move = (by: number) => {
      const line = grid.current();
      if (!line) return;
      const list = lines();
      const at = list.indexOf(line);
      const to = at + by;
      if (to < 0 || to >= list.length) return;
      list.splice(at, 1);
      list.splice(to, 0, line);
      this.markChanged();
      grid.setRows(list);
      grid.focusRow(String(line.__id));
    };
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('strong', { style: { padding: '0 6px' } }, title ?? part.title ?? part.name),
      button(t('card', 'Add'), { icon: 'plus', disabled: !writable, title: t('card', 'Add a line (Insert)'), onClick: () => void addLine() }),
      button(null, { icon: 'trash', title: t('card', 'Delete lines (Delete)'), disabled: !writable, onClick: removeLines }),
      button(null, { icon: 'arrowUp', title: t('card', 'Move up'), disabled: !writable, onClick: () => move(-1) }),
      button(null, { icon: 'arrowDown', title: t('card', 'Move down'), disabled: !writable, onClick: () => move(1) }),
      ...(part.fields.some((f) => f.type === 'ref' && f.ref)
        ? [button(t('card', 'Pick…'), { icon: 'list', disabled: !writable, title: t('card', 'Add several lines at once'), onClick: () => void this.pickLines(part, grid) })]
        : []),
    );
    void (async () => {
      // Fields kept out of lists (a line's helpers: the decimals of its currency) are not columns here either.
      const shown = part.fields.filter((f) => f.list !== false);
      const maps = await columnMaps(this.app.data, partTable, shown.map((f) => ({ field: f.name })));
      const cols: GridColumn<Row>[] = gridColumns(this.app.data, partTable, shown.map((f) => ({ field: f.name, ...(f.type === 'decimal' && f.computed ? { total: 'sum' as const } : {}) })), maps);
      for (const c of cols) {
        const f = part.fields.find((x) => x.name === c.key);
        c.editable = writable && !!f && !f.computed && f.readonly !== true;
        // Labels of references picked since the maps were loaded.
        if (f?.type === 'ref' && f.ref) {
          const ref = f.ref;
          c.value = (row) => {
            const id = row[f.name];
            if (!id) return null;
            const r = maps.get(ref)?.get(String(id));
            if (r) return this.app.data.rowLabel(tableOf(this.app.data.config, ref)!, r);
            void this.app.data.rowsById(ref).then((m) => {
              maps.set(ref, m);
              grid.setRows(lines());
            });
            return '…';
          };
        }
      }
      grid.setColumns([{ key: '__n', title: '#', width: 40, kind: 'number', align: 'num', value: (r) => lines().indexOf(r) + 1 }, ...cols]);
      grid.setRows(lines());
    })();
    this.parts.set(part.name, { grid, part });
    return h('div', { class: 'f-part', 'data-part': part.name }, toolbar, grid.el);
  }

  private editLine(part: PartDef, line: Row, column: GridColumn<Row>, cell: HTMLElement, done: (moved?: 'next' | 'down' | null) => void, initial?: string): void {
    const f = part.fields.find((x) => x.name === column.key);
    if (!f) return done(null);
    let value = line[f.name];
    const editor = editorFor(this.app, scaled(f, line), value, (v) => (value = v), { compact: true });
    clear(cell, editor.el);
    const input = cell.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
    let finished = false;
    const finish = async (commit: boolean, moved: 'next' | 'down' | null) => {
      if (finished) return;
      finished = true;
      this.pendingEdit = null;
      if (commit && value !== line[f.name]) {
        line[f.name] = value;
        this.markChanged();
        if (f.type === 'ref') await this.app.data.refreshLineDefaults(this.tb, part.name, this.row, line, f.name);
        await this.recompute();
      }
      done(moved);
    };
    this.pendingEdit = () => finish(true, null);
    if (input) {
      if (initial !== undefined && input instanceof HTMLInputElement && input.type !== 'checkbox') {
        input.value = initial;
        input.dispatchEvent(new Event('input'));
      }
      input.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return;
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter') {
          ke.preventDefault();
          void finish(true, 'next');
        } else if (ke.key === 'Tab') {
          ke.preventDefault();
          void finish(true, 'next');
        } else if (ke.key === 'Escape') {
          ke.preventDefault();
          ke.stopPropagation();
          void finish(false, null);
        }
      });
      input.addEventListener('blur', () =>
        setTimeout(() => {
          if (document.activeElement && cell.contains(document.activeElement)) return;
          if (document.querySelector('.popup, .overlay')) return;
          void finish(true, null);
        }, 180),
      );
      input.addEventListener('change', () => {
        if (input instanceof HTMLSelectElement || (input instanceof HTMLInputElement && input.type === 'checkbox')) void finish(true, null);
      });
      setTimeout(() => {
        input.focus();
        if (initial !== undefined && input instanceof HTMLInputElement) input.setSelectionRange(input.value.length, input.value.length);
      });
    }
    // A reference picked from its list: commit at once.
    if (f.type === 'ref') {
      const orig = value;
      const timer = setInterval(() => {
        if (finished) return clearInterval(timer);
        // The grid was redrawn under the editor: the edit is over either way.
        if (!cell.isConnected) {
          clearInterval(timer);
          void finish(true, null);
          return;
        }
        if (value !== orig) {
          clearInterval(timer);
          void finish(true, 'next');
        }
      }, 100);
    }
  }

  /** Adds lines for several records chosen at once — the products of a receipt. */
  private async pickLines(part: PartDef, grid: Grid<Row>): Promise<void> {
    const refField = part.fields.find((f) => f.type === 'ref' && f.ref)!;
    const target = tableOf(this.app.data.config, refField.ref);
    if (!target) return;
    const rows = await this.app.choose(target, { multi: true });
    if (!rows?.length) return;
    for (const r of rows) {
      if (r.isFolder) continue;
      const line = (await this.app.data.newLine(this.tb, part.name, this.row, { [refField.name]: r.id })) as Row;
      line.__id = Math.random().toString(36).slice(2);
      (this.row[part.name] as Row[]).push(line);
    }
    this.markChanged();
    await this.recompute();
    grid.setRows(this.row[part.name] as Row[]);
  }

  private renderRelated(table: string, field: string, title?: string): HTMLElement {
    const target = tableOf(this.app.data.config, table);
    if (!target) return h('div', { class: 'muted' }, `?${table}`);
    if (!this.recordId) return h('div', { class: 'grid-empty' }, t('card', 'Save the record to add {what}', { what: (title ?? target.title).toLocaleLowerCase() }));
    const list = new ListPage(
      this.app,
      { key: `rel_${target.key}_${field}`, name: `rel_${target.name}_${field}`, table: target.name, title: title ?? target.title, columns: target.fields.filter((f) => f.name !== field && f.type !== 'text' && f.list !== false).slice(0, 8).map((f) => ({ field: f.name })) },
      { embedded: true, filter: { field, op: 'eq', value: this.recordId }, init: { [field]: this.recordId } },
    );
    this.related.push(list);
    return h('div', { class: 'f-part', style: { minHeight: '220px', height: '300px' } }, list.el);
  }

  /* ------------------------------ commands ------------------------------ */

  /** Saves; true when saved. Problems are shown by their fields. */
  async save(): Promise<boolean> {
    if (this.saving) return false;
    // A value still in a line's cell editor (Ctrl+S pressed while typing) belongs to this save.
    await this.pendingEdit?.();
    this.saving = true;
    this.showProblems([]);
    // The id is fixed before the first attempt: a retry after a failure that came late cannot make a second record.
    if (!this.row.id) this.row.id = uuid();
    let conflict = false;
    try {
      const saved = await this.app.data.save(this.tb, this.row, this.original);
      // A new record, or a new version of a versioned one: the tab follows its id.
      const wasNew = !this.recordId || this.recordId !== saved.id;
      this.recordId = saved.id;
      this.original = structuredClone(saved);
      this.row = saved;
      this.changed = false;
      if (wasNew) {
        const old = this.id;
        this.id = `record:${this.tb.name}:${saved.id}`;
        this.app.updateTab(Object.assign(this, { previousId: old }));
        this.render();
      } else this.render();
      toast(t('card', 'Saved'), 'ok');
      this.onSaved?.(saved);
      return true;
    } catch (error) {
      if (error instanceof ValidationError) this.showProblems(error.problems);
      else if (error instanceof PluginError && error.code === 'conflict') conflict = true;
      else this.app.fail(error, this.title);
    } finally {
      this.saving = false;
    }
    // After `saving` is cleared: "Overwrite" saves again.
    if (conflict) return this.conflict();
    return false;
  }

  /** Commits the cell being edited in a part, if any. */
  private pendingEdit: (() => Promise<void>) | null = null;

  private showProblems(problems: Problem[]): void {
    for (const { editor } of this.editors.values()) editor.setError(null);
    if (!problems.length) {
      this.errors.classList.add('hidden');
      return;
    }
    const general: string[] = [];
    let focused = false;
    for (const p of problems) {
      const ed = p.field && !p.part ? this.editors.get(p.field) : undefined;
      if (ed) {
        ed.editor.setError(p.message);
        if (!focused) {
          ed.editor.focus();
          focused = true;
        }
      } else general.push(p.part ? `${t('card', 'Line {n}', { n: p.line ?? 0 })}: ${p.message}` : p.message);
    }
    clear(this.errors, h('strong', null, t('card', 'The record cannot be saved:')), h('ul', { style: { margin: '4px 0 0', paddingInlineStart: '20px' } }, problems.map((p) => h('li', null, p.part ? `${t('card', 'Line {n}', { n: p.line ?? 0 })}: ${p.message}` : p.message))));
    void general;
    this.errors.classList.remove('hidden');
    this.body.scrollTop = 0;
  }

  /** Someone else saved this record meanwhile. */
  private async conflict(): Promise<boolean> {
    const answer = await dialog<'theirs' | 'mine' | 'cancel'>({
      title: t('card', 'The record was changed elsewhere'),
      body: t('card', 'Someone saved this record after you opened it. Overwrite their changes with yours, or load their version and lose yours?'),
      buttons: [
        { label: t('card', 'Load their version'), value: 'theirs', left: true },
        { label: t('card', 'Cancel'), value: 'cancel' },
        { label: t('card', 'Overwrite'), value: 'mine', primary: true, danger: true },
      ],
      cancel: 'cancel',
    });
    if (answer === 'theirs') {
      this.changed = false;
      await this.reload();
    } else if (answer === 'mine') {
      const theirs = await this.app.data.get(this.tb.name, this.row.id);
      if (theirs) this.original = theirs;
      return this.save();
    }
    return false;
  }

  private async post(on: boolean): Promise<boolean> {
    const before = this.row.posted;
    this.row.posted = on;
    const ok = await this.save();
    if (!ok) this.row.posted = before;
    else toast(on ? t('card', 'Posted') : t('card', 'Posting cancelled'), 'ok');
    return ok;
  }

  private async print(template: string): Promise<void> {
    const p = this.app.data.config.printTemplates.find((x) => x.name === template);
    if (!p) return;
    if (this.changed || !this.recordId) {
      if (!(await this.save())) return;
    }
    printRecords(this.app, p, this.tb, [this.row]);
  }

  private async runAction(a: ActionDef): Promise<void> {
    if (this.changed && a.table && !(await this.save())) return;
    await this.app.runAction(a.name, { table: this.tb, current: this.row, selected: [this.row] });
  }
}

/** The inputs a person types into, in the order of the form. */
const EDITABLE = 'input:not([readonly]):not([disabled]):not([type=checkbox]), select:not([disabled]), textarea:not([readonly])';

/* ------------------------------------------------------------------ *
 * Layout rendering, shared with the form designer
 * ------------------------------------------------------------------ */

export interface LayoutRenderers {
  field(node: Extract<FormNode, { type: 'field' }>): HTMLElement;
  part(node: Extract<FormNode, { type: 'part' }>): HTMLElement;
  related(node: Extract<FormNode, { type: 'related' }>): HTMLElement;
  action(node: Extract<FormNode, { type: 'button' | 'link' }>): HTMLElement;
  /** The designer wraps every node to select and drag it. */
  wrap?(node: FormNode, el: HTMLElement): HTMLElement;
}

export function renderLayout(node: FormNode, r: LayoutRenderers, root = true): HTMLElement {
  const wrap = (el: HTMLElement) => (r.wrap ? r.wrap(node, el) : el);
  const kids = (n: { children: FormNode[] }) => n.children.map((c) => renderLayout(c, r, false));
  switch (node.type) {
    case 'group': {
      if (root || !node.title) return wrap(h('div', { class: root ? '' : 'f-plain-group' }, ...kids(node)));
      return wrap(h('fieldset', { class: 'f-group' }, h('legend', null, node.title), ...kids(node)));
    }
    case 'columns':
      return wrap(h('div', { class: 'f-columns' }, ...kids(node)));
    case 'tabs': {
      const tabs = node.children.filter((c): c is Extract<FormNode, { type: 'tab' }> => c.type === 'tab');
      const bar = h('div', { class: 'subtabs' });
      const body = h('div', { class: 'f-tab-body' });
      const panes = tabs.map((tab) => renderLayout(tab, r, false));
      const show = (i: number) => {
        bar.querySelectorAll('.subtab').forEach((b, k) => b.classList.toggle('active', k === i));
        panes.forEach((p, k) => p.classList.toggle('hidden', k !== i));
      };
      tabs.forEach((tab, i) => bar.appendChild(h('button', { type: 'button', class: 'subtab', onclick: () => show(i) }, tab.title)));
      body.append(...panes);
      show(0);
      return wrap(h('div', { class: 'f-tabs' }, bar, body));
    }
    case 'tab':
      return wrap(h('div', null, ...kids(node)));
    case 'field':
      return wrap(r.field(node));
    case 'part':
      return wrap(r.part(node));
    case 'related':
      return wrap(r.related(node));
    case 'button':
    case 'link':
      return wrap(h('div', { class: 'f-buttons' }, r.action(node)));
    case 'text':
      return wrap(h('div', { class: 'f-text' }, node.text));
    case 'spacer':
      return wrap(h('div', { style: { height: '14px' } }));
  }
}
