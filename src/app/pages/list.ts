/**
 * A list (Task.md 8.2–8.3): a view of a table in the grid, with its toolbar,
 * the info line, the group tree of a hierarchical catalog, conditional
 * formatting, and the detail tabs of the selected record below a splitter.
 *
 * The same page, in selection mode, is the "choose a record" dialog of a
 * reference field.
 */
import { t, tn } from '../../core/i18n';
import { allFields, defaultDetails, field as fieldOf, inForce, table as tableOf } from '../../core/config/model';
import type { ActionDef, ColumnDef, DetailDef, TableDef, ViewDef } from '../../core/config/types';
import { isoDateTime, parseCached, truthy } from '../../core/data';
import { runQuery } from '../../core/query/index';
import { evaluate } from '../../core/expr/index';
import type { Filter, Row } from '../../core/query/types';
import { toCsv } from '../../core/csv';
import { button, clear, debounce, download, h, icon } from '../dom';
import { columnMaps, gridColumns } from '../fields';
import { Grid, type CellStyle, type GridColumn, type GridState } from '../grid';
import { confirm, popupMenu, toast, type MenuItem } from '../ui';
import { settings, saveSettings } from '../settings';
import type { App, OpenOptions, Page } from '../app';
import { printRecords } from './print';

export interface ListOptions extends OpenOptions {
  /** Selection mode: the list is a picker. */
  select?: { multi: boolean; done: (rows: Row[] | null) => void };
  /** Embedded (a detail tab, a dashboard): no info bar, no details, smaller toolbar. */
  embedded?: boolean;
  /** An expression filter on top of the view's, with `vars` as `$name` (a detail tab's `$master`). */
  where?: string;
  vars?: Record<string, unknown>;
  /** A versioned table's every version, not only those in force. */
  versions?: boolean;
}

export class ListPage implements Page {
  readonly id: string;
  title: string;
  icon?: string;
  readonly el: HTMLElement;
  private grid: Grid<Row>;
  private tb: TableDef;
  private rows: Row[] = [];
  private group: string | null = null;
  private flat = false;
  private treeEl: HTMLElement | null = null;
  private detailHost: HTMLElement | null = null;
  private detailTabs: HTMLElement | null = null;
  private detailBody: HTMLElement | null = null;
  private activeDetail = 0;
  private detailGrid: ListPage | null = null;
  private unsubscribe: () => void;
  private toolbar: HTMLElement;
  private stale = false;
  private visible = true;
  private ruleFn: ((row: Row) => { row?: CellStyle; cells?: Record<string, CellStyle> } | null) | null = null;

  constructor(
    private readonly app: App,
    private view: ViewDef,
    private readonly opts: ListOptions = {},
  ) {
    this.tb = app.data.table(view.table);
    this.id = opts.select ? `select:${view.name}` : `view:${view.name}${opts.filter ? `:${JSON.stringify(opts.filter)}` : ''}`;
    this.title = opts.title ?? view.title;
    this.icon = view.icon ?? this.tb.icon ?? 'table';
    const stateKey = this.stateKey();
    const saved = settings.views[stateKey] as Partial<GridState> | undefined;
    this.grid = new Grid<Row>({
      columns: [],
      idOf: (r) => r.id,
      multi: !opts.select || opts.select.multi ? true : false,
      groupBar: !opts.embedded,
      emptyText: t('list', 'No records yet. Press Insert or “Create” to add one.'),
      state: { ...(view.group ? { group: view.group } : {}), ...(view.sort ? { sort: view.sort.map((s) => ({ key: s.field, desc: s.desc === true })) } : {}), ...(saved ?? {}) },
      onState: (state) => {
        if (opts.select || opts.embedded) return;
        settings.views[stateKey] = state;
        saveSettings();
      },
      styleOf: (row) => this.ruleFn?.(row) ?? null,
      rowClass: (row) => (row.isFolder ? 'folder' : ''),
      onOpen: (row) => this.open(row),
      onSelect: () => {
        this.refreshToolbar();
        this.showDetail();
      },
      onContext: (_e, row, column) => this.contextMenu(row, column),
      onHeaderMenu: (column) => this.headerMenu(column),
      onKey: (e, row) => this.key(e, row),
    });
    this.toolbar = h('div', { class: 'toolbar' });
    const info = view.description && !opts.embedded && !opts.select ? h('div', { class: 'info-bar' }, view.description) : null;
    const main = h('div', { class: 'side-split' });
    if (this.tb.hierarchical && !opts.embedded) {
      this.treeEl = h('div', { class: 'side-tree' });
      main.appendChild(this.treeEl);
    }
    main.appendChild(h('div', { style: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column' } }, this.grid.el));
    const details = opts.embedded || opts.select ? [] : (view.details ?? defaultDetails(app.data.config, this.tb));
    if (details.length) {
      const split = settings.splits[`list:${view.name}`] ?? 0.62;
      const top = h('div', { class: 'split-pane', style: { flex: `${split} 1 0` } }, main);
      this.detailTabs = h('div', { class: 'subtabs' });
      this.detailBody = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } });
      this.detailHost = h('div', { class: 'split-pane', style: { flex: `${1 - split} 1 0` } }, this.detailTabs, this.detailBody);
      const splitter = h('div', { class: 'splitter-h', role: 'separator', 'aria-orientation': 'horizontal' });
      this.wireSplitter(splitter, top, this.detailHost);
      this.el = h('div', { class: 'page' }, this.toolbar, info, h('div', { class: 'split-h' }, top, splitter, this.detailHost));
      this.renderDetailTabs(details);
    } else {
      this.el = h('div', { class: `page${opts.embedded || opts.select ? ' embedded' : ''}` }, this.toolbar, info, main);
    }
    this.unsubscribe = app.data.onChange((tables) => {
      if (tables.includes(this.tb.name) || tables.some((n) => this.dependsOn(n))) {
        if (this.visible || this.opts.embedded) void this.load();
        else this.stale = true;
      }
    });
    this.refreshToolbar();
    void this.load();
  }

  private stateKey(): string {
    return `${this.app.session.workspace.id}:${this.view.key}`;
  }

  /** A list shows labels of referenced tables and computed values from registers: their writes concern it too. */
  private dependsOn(table: string): boolean {
    if (allFields(this.tb).some((f) => f.ref === table)) return true;
    return allFields(this.tb).some((f) => f.computed?.includes(`'${table}'`));
  }

  onShow(): void {
    this.visible = true;
    if (this.stale) {
      this.stale = false;
      void this.load();
    }
    this.grid.focus();
  }

  dispose(): void {
    this.unsubscribe();
    this.detailGrid?.dispose();
  }

  setView(view: ViewDef): void {
    this.view = view;
    this.tb = this.app.data.table(view.table);
    void this.load();
  }

  focus(): void {
    this.grid.focus();
  }

  /* ------------------------------ data ------------------------------ */

  private columns(): ColumnDef[] {
    return this.view.columns.filter((c) => fieldOf(this.tb, c.field.split('.')[0]!));
  }

  async load(): Promise<void> {
    this.grid.setLoading(true);
    try {
      const data = this.app.data;
      this.tb = data.table(this.view.table);
      const where = combine(this.view.filter, this.opts.filter);
      // A register's movements up to now, the planned ones included; a versioned table's versions in force.
      let rows = this.tb.kind === 'register' ? runQuery(await data.movements(this.tb.name), { table: this.tb.name, ...(where ? { where } : {}) }).rows : (await data.query(where ? { table: this.tb.name, where } : { table: this.tb.name })).rows;
      if (this.tb.versioned && !this.opts.versions) {
        const now = isoDateTime(data.context.now());
        rows = rows.filter((r) => inForce(this.tb, r, now));
      }
      await data.compute(this.tb, rows);
      for (const where of [this.view.where, this.opts.where]) {
        if (!where) continue;
        const envOf = await data.scope(this.tb, [where], this.opts.vars ?? {});
        const expr = parseCached(where);
        rows = rows.filter((r) => {
          try {
            return truthy(evaluate(expr, envOf(r)));
          } catch {
            return false;
          }
        });
      }
      this.rows = rows;
      const columns = this.columns();
      const maps = await columnMaps(data, this.tb, columns);
      const gridCols: GridColumn<Row>[] = gridColumns(data, this.tb, columns, maps);
      if (this.tb.kind === 'register') await this.recorders(gridCols);
      if (this.tb.hierarchical && gridCols[0]) {
        const first = gridCols[0];
        const render = first.render;
        first.render = (row, v) => (row.isFolder ? h('span', { style: { fontWeight: '600' } }, icon('folder', 14), ' ', String(v ?? '')) : render ? render(row, v) : String(v ?? ''));
      }
      await this.prepareRules();
      this.grid.setColumns(gridCols);
      this.applyGroup();
      this.renderTree();
      this.grid.setLoading(false);
      this.showDetail();
      this.refreshToolbar();
    } catch (error) {
      this.grid.setLoading(false);
      this.grid.setRows([]);
      this.app.fail(error, this.view.title);
    }
  }

  private applyGroup(): void {
    if (!this.tb.hierarchical || this.flat || this.opts.embedded) {
      this.grid.setRows(this.flat || this.opts.embedded ? this.rows.filter((r) => !r.isFolder) : this.rows);
      return;
    }
    this.grid.setRows(this.rows.filter((r) => (r.parent ?? null) === this.group));
  }

  private async prepareRules(): Promise<void> {
    const rules = (this.view.rules ?? []).filter((r) => r.active !== false);
    if (!rules.length) {
      this.ruleFn = null;
      return;
    }
    const envOf = await this.app.data.scope(this.tb, rules.map((r) => r.when));
    const compiled = rules.map((r) => {
      try {
        return { rule: r, expr: parseCached(r.when) };
      } catch {
        return null;
      }
    });
    const cache = new WeakMap<Row, { row?: CellStyle; cells?: Record<string, CellStyle> } | null>();
    this.ruleFn = (row) => {
      if (cache.has(row)) return cache.get(row)!;
      let out: { row?: CellStyle; cells?: Record<string, CellStyle> } | null = null;
      const env = envOf(row);
      for (const c of compiled) {
        if (!c) continue;
        let ok = false;
        try {
          ok = truthy(evaluate(c.expr, env));
        } catch {
          ok = false;
        }
        if (!ok) continue;
        out ??= {};
        const style: CellStyle = { ...(c.rule.background ? { background: c.rule.background } : {}), ...(c.rule.color ? { color: c.rule.color } : {}), ...(c.rule.bold ? { bold: true } : {}) };
        if (c.rule.field) (out.cells ??= {})[c.rule.field] = { ...(out.cells?.[c.rule.field] ?? {}), ...style };
        else out.row = { ...(out.row ?? {}), ...style };
      }
      cache.set(row, out);
      return out;
    };
  }

  /* ------------------------------ group tree ------------------------------ */

  private renderTree(): void {
    if (!this.treeEl) return;
    const folders = this.rows.filter((r) => r.isFolder);
    const byParent = new Map<string | null, Row[]>();
    for (const f of folders) {
      const p = (f.parent as string | null) ?? null;
      byParent.set(p, [...(byParent.get(p) ?? []), f]);
    }
    const items: Node[] = [];
    const add = (label: string, id: string | null, depth: number, folder: boolean) => {
      const el = h('div', { class: `tree-item${!this.flat && this.group === id ? ' selected' : ''}`, style: { ['--depth' as string]: String(depth) } as Partial<CSSStyleDeclaration>, 'data-group': id ?? '' }, h('span', { class: 'twisty' }), icon(folder ? 'folder' : 'list'), h('span', { class: 'label' }, label));
      el.addEventListener('click', () => {
        this.flat = false;
        this.group = id;
        this.applyGroup();
        this.renderTree();
      });
      el.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('text/x-records')) {
          e.preventDefault();
          el.classList.add('drop-into');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-into'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop-into');
        e.preventDefault();
        void this.moveTo(id);
      });
      items.push(el);
    };
    add(t('list', 'All groups'), null, 0, true);
    const walk = (parent: string | null, depth: number) => {
      for (const f of (byParent.get(parent) ?? []).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))) {
        add(this.app.data.rowLabel(this.tb, f), f.id, depth, true);
        walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
    const all = h('div', { class: `tree-item${this.flat ? ' selected' : ''}` }, h('span', { class: 'twisty' }), icon('list'), h('span', { class: 'label' }, t('list', 'Everything, without groups')));
    all.addEventListener('click', () => {
      this.flat = true;
      this.applyGroup();
      this.renderTree();
    });
    clear(this.treeEl, all, ...items);
  }

  private async moveTo(group: string | null): Promise<void> {
    const rows = this.grid.selection().filter((r) => r.id !== group);
    for (const row of rows) await this.app.data.save(this.tb, { ...row, parent: group }, row).catch((e: unknown) => this.app.fail(e));
  }

  /* ------------------------------ toolbar ------------------------------ */

  private actions(): ActionDef[] {
    const config = this.app.data.config;
    const named = (this.view.actions ?? []).map((n) => config.actions.find((a) => a.name === n)).filter((a): a is ActionDef => !!a);
    const forTable = config.actions.filter((a) => a.table === this.tb.name && (a.where ?? ['list', 'card']).includes('list') && !named.includes(a));
    return [...named, ...forTable];
  }

  refreshToolbar(): void {
    const sel = this.grid.selection();
    const one = sel.length === 1 ? sel[0]! : null;
    const writable = this.app.data.writable(this.tb);
    const items: (Node | null)[] = [];
    if (this.opts.select) {
      items.push(button(t('list', 'Choose'), { icon: 'check', class: 'primary', disabled: !sel.length || sel.some((r) => r.isFolder), onClick: () => this.opts.select!.done(this.grid.selection()) }));
      items.push(h('span', { class: 'sep' }));
    }
    items.push(button(this.opts.embedded ? null : t('list', 'Refresh'), { icon: 'refresh', title: t('list', 'Refresh (F5)'), onClick: () => void this.load() }));
    if (this.tb.kind !== 'register') {
      items.push(button(t('list', 'Create'), { icon: 'plus', title: t('list', 'Create (Insert)'), disabled: !writable, class: this.opts.select ? '' : 'primary', onClick: () => this.create() }));
      if (this.tb.hierarchical && !this.opts.embedded) items.push(button(t('list', 'Group'), { icon: 'folder', title: t('list', 'Create a group'), disabled: !writable, onClick: () => this.create(true) }));
    }
    items.push(button(this.opts.embedded ? null : t('list', 'Open'), { icon: 'edit', title: t('list', 'Open (Enter)'), disabled: !one, onClick: () => one && this.open(one) }));
    if (this.tb.kind !== 'register') {
      items.push(button(null, { icon: 'copy', title: t('list', 'Copy'), disabled: !one || !writable, onClick: () => one && this.copy(one) }));
      items.push(button(null, { icon: 'trash', title: t('list', 'Delete (Delete)'), disabled: !sel.length || !writable, class: 'danger', onClick: () => void this.remove() }));
    }
    if (this.tb.orderable && !this.opts.select) {
      items.push(button(null, { icon: 'arrowUp', title: t('list', 'Move up (Alt+↑)'), disabled: !one || !writable, onClick: () => void this.move(-1) }));
      items.push(button(null, { icon: 'arrowDown', title: t('list', 'Move down (Alt+↓)'), disabled: !one || !writable, onClick: () => void this.move(1) }));
    }
    if (this.tb.kind === 'document' && this.tb.posting?.length) {
      items.push(h('span', { class: 'sep' }));
      items.push(button(this.opts.embedded ? null : t('list', 'Post'), { icon: 'post', disabled: !sel.length || !writable, onClick: () => void this.post(true) }));
      items.push(button(null, { icon: 'unpost', title: t('list', 'Cancel posting'), disabled: !sel.length || !writable, onClick: () => void this.post(false) }));
    }
    const actions = this.actions();
    if (actions.length && !this.opts.select) {
      items.push(h('span', { class: 'sep' }));
      if (actions.length <= 2 && !this.opts.embedded) {
        for (const a of actions) items.push(button(a.title, { icon: a.icon ?? 'bolt', disabled: !sel.length && !!a.table, onClick: () => void this.runAction(a) }));
      } else {
        const b = button(t('list', 'Actions'), { icon: 'bolt' });
        b.appendChild(icon('chevronDown', 12));
        b.addEventListener('click', () => popupMenu(b, actions.map((a) => ({ label: a.title, icon: a.icon ?? 'bolt', disabled: !sel.length && !!a.table, run: () => void this.runAction(a) }))));
        items.push(b);
      }
    }
    if (!this.opts.select) {
      const templates = this.app.data.config.printTemplates.filter((p) => p.table === this.tb.name);
      const print = button(this.opts.embedded ? null : t('list', 'Print'), { icon: 'print', title: t('list', 'Print') });
      print.addEventListener('click', () =>
        void this.app.exporters().then((exporters) =>
          popupMenu(print, [
            ...templates.map((p): MenuItem => ({ label: p.title, icon: 'doc', disabled: !sel.length, run: () => printRecords(this.app, p, this.tb, this.grid.selection()) })),
            ...(templates.length ? [{ separator: true } as MenuItem] : []),
            { label: t('list', 'The list as shown'), icon: 'table', run: () => this.printList() },
            { label: t('list', 'Export to CSV'), icon: 'download', run: () => this.exportCsv() },
            ...(exporters.length ? [{ title: t('list', 'Plugins') } as MenuItem] : []),
            ...exporters.map((e): MenuItem => ({ label: e.title, icon: 'puzzle', hint: `.${e.extension}`, run: () => void this.app.runExporter(e.plugin, e.name, this.shownData()) })),
          ]),
        ),
      );
      items.push(h('span', { class: 'sep' }), print);
    }
    items.push(h('span', { class: 'spacer' }));
    if (!this.opts.embedded && !this.opts.select) {
      items.push(button(null, { icon: 'columns', title: t('list', 'Columns'), onClick: () => this.grid.chooseColumns() }));
      if (this.app.isDesign()) items.push(button(t('list', 'Design'), { icon: 'wrench', title: t('list', 'Open this table in the designer'), onClick: () => this.app.designTable(this.tb.name) }));
    }
    clear(this.toolbar, ...items);
  }

  /* ------------------------------ commands ------------------------------ */

  private create(folder = false): void {
    if (!this.app.data.writable(this.tb)) return;
    const init: Record<string, unknown> = { ...(this.opts.init ?? {}) };
    if (this.tb.hierarchical) {
      init.parent = this.flat ? null : this.group;
      init.isFolder = folder;
    }
    this.app.openRecord(this.tb.name, null, init, (row) => {
      void this.load().then(() => this.grid.focusRow(row.id));
      if (this.opts.select && !row.isFolder) this.opts.select.done([row]);
    });
  }

  private copy(row: Row): void {
    const { id: _id, _rev: _r, number: _n, posted: _p, _createdAt: _c1, _createdBy: _c2, _updatedAt: _u1, _updatedBy: _u2, ...rest } = row;
    this.app.openRecord(this.tb.name, null, rest, () => void this.load());
  }

  private open(row: Row): void {
    if (row.isFolder && !this.opts.embedded) {
      this.flat = false;
      this.group = row.id;
      this.applyGroup();
      this.renderTree();
      return;
    }
    if (this.opts.select) {
      this.opts.select.done([row]);
      return;
    }
    if (this.tb.kind === 'register' && row.recorder) {
      const doc = this.app.data.config.tables.find((tb) => tb.posting?.some((p) => p.register === this.tb.name));
      if (doc) {
        void this.app.data.get(doc.name, String(row.recorder)).then((d) => {
          const owner = d ? doc : this.app.data.config.tables.find((tb) => tb.kind === 'document' && tb.posting?.some((p) => p.register === this.tb.name) && tb !== doc);
          if (d) this.app.openRecord(doc.name, String(row.recorder));
          else if (owner) this.app.openRecord(owner.name, String(row.recorder));
        });
        return;
      }
    }
    this.app.openRecord(this.tb.name, row.id, undefined, () => void this.load());
  }

  private async remove(): Promise<void> {
    const rows = this.grid.selection();
    if (!rows.length) return;
    const text = rows.length === 1 ? t('list', 'Delete “{name}”?', { name: this.app.data.rowLabel(this.tb, rows[0]!) }) : tn('list', 'Delete {count} record?', 'Delete {count} records?', rows.length);
    if (!(await confirm(t('list', 'Delete'), text, t('list', 'Delete'), true))) return;
    let done = 0;
    for (const row of rows) {
      try {
        await this.app.data.remove(this.tb, row);
        done++;
      } catch (error) {
        this.app.fail(error);
        break;
      }
    }
    if (done) toast(tn('list', '{count} record deleted', '{count} records deleted', done), 'ok');
  }

  private async post(on: boolean): Promise<void> {
    let done = 0;
    for (const row of this.grid.selection()) {
      if (Boolean(row.posted) === on) continue;
      try {
        const fresh = (await this.app.data.get(this.tb.name, row.id)) ?? row;
        await this.app.data.save(this.tb, { ...fresh, posted: on }, fresh);
        done++;
      } catch (error) {
        this.app.fail(error, this.app.data.rowLabel(this.tb, row));
        break;
      }
    }
    if (done) toast(on ? tn('list', '{count} document posted', '{count} documents posted', done) : tn('list', 'Posting cancelled for {count} document', 'Posting cancelled for {count} documents', done), 'ok');
  }

  hotkeyAction(a: ActionDef): boolean {
    if (a.table !== this.tb.name || this.opts.select) return false;
    void this.runAction(a);
    return true;
  }

  private async runAction(a: ActionDef): Promise<void> {
    const sel = this.grid.selection();
    await this.app.runAction(a.name, { table: this.tb, current: sel[0] ?? null, selected: sel });
  }

  private printList(): void {
    const cols = this.grid.columns.filter((c) => !this.grid.state.hidden.includes(c.key));
    const rows = this.grid.rows();
    const html = `<h1>${escapeHtml(this.title)}</h1><table><thead><tr>${cols.map((c) => `<th class="${c.align ?? ''}">${escapeHtml(c.title)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${cols.map((c) => {
        const v = c.value(r);
        const out = c.render ? c.render(r, v) : String(v ?? '');
        return `<td class="${c.align ?? ''}">${escapeHtml(typeof out === 'string' ? out : (out.textContent ?? ''))}</td>`;
      }).join('')}</tr>`)
      .join('')}</tbody></table>`;
    printRecords(this.app, { key: 'list', name: 'list', title: this.title, table: this.tb.name, html }, this.tb, [], html);
  }

  /** The list as shown — filtered, sorted, values as displayed — for a plugin exporter. */
  private shownData(): { table: string; rows: Record<string, unknown>[]; columns: { field: string; title: string }[] } {
    const cols = this.grid.columns.filter((c) => !this.grid.state.hidden.includes(c.key));
    return {
      table: this.tb.name,
      columns: cols.map((c) => ({ field: c.key, title: c.title })),
      rows: this.grid.rows().map((r) => Object.fromEntries(cols.map((c) => [c.key, c.value(r) ?? null]))),
    };
  }

  private exportCsv(): void {
    const cols = this.grid.columns.filter((c) => !this.grid.state.hidden.includes(c.key));
    const rows = this.grid.rows().map((r) => cols.map((c) => {
      const v = c.value(r);
      return typeof v === 'number' || typeof v === 'boolean' ? v : v === null || v === undefined ? '' : String(v);
    }));
    download(new Blob(['﻿', toCsv([cols.map((c) => c.title), ...rows])], { type: 'text/csv;charset=utf-8' }), `${this.view.name}.csv`);
  }

  /** A movement's recorder by name: the document, the account or the recurring payment that wrote it, whichever table it is in. */
  private async recorders(columns: GridColumn<Row>[]): Promise<void> {
    const col = columns.find((c) => c.key === 'recorder');
    if (!col) return;
    const data = this.app.data;
    const sources = data.config.tables.filter((x) => x.posting?.some((p) => p.register === this.tb.name));
    const labels = new Map<string, string>();
    for (const src of sources) for (const [id, row] of await data.rowsById(src.name)) labels.set(id, data.rowLabel(src, row));
    col.value = (row) => (row.recorder ? (labels.get(String(row.recorder)) ?? String(row.recorder)) : null);
    col.render = (row, v) => (v === null ? '' : h('span', { class: row.planned ? 'muted' : '' }, String(v)));
  }

  /** Swaps the current record with its neighbour in the order the person keeps. */
  private async move(by: -1 | 1): Promise<void> {
    const row = this.grid.current();
    if (!row || !this.tb.orderable) return;
    const ordered = [...this.rows].filter((r) => !!r.isFolder === !!row.isFolder && (r.parent ?? null) === (row.parent ?? null)).sort((a, b) => (Number(a._order) || 0) - (Number(b._order) || 0));
    const at = ordered.findIndex((r) => r.id === row.id);
    const other = ordered[at + by];
    if (at < 0 || !other) return;
    try {
      // Equal or missing positions are numbered afresh first, so a swap always changes something.
      const positions = ordered.map((r) => r._order);
      if (new Set(positions).size !== ordered.length || positions.some((p) => typeof p !== 'number')) {
        for (const [i, r] of ordered.entries()) if (r._order !== i + 1) await this.app.data.save(this.tb, { ...r, _order: i + 1 }, r);
        for (const [i, r] of ordered.entries()) r._order = i + 1;
      }
      const fresh = async (r: Row) => (await this.app.data.get(this.tb.name, r.id)) ?? r;
      const [x, y] = [await fresh(row), await fresh(other)];
      await this.app.data.save(this.tb, { ...x, _order: other._order }, x);
      await this.app.data.save(this.tb, { ...y, _order: row._order }, y);
      this.grid.focusRow(row.id);
    } catch (error) {
      this.app.fail(error);
    }
  }

  private key(e: KeyboardEvent, row: Row | null): boolean {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.tb.orderable) {
      void this.move(e.key === 'ArrowUp' ? -1 : 1);
      return true;
    }
    if (e.key === 'Insert' || (e.key === 'n' && (e.altKey || e.ctrlKey) && !e.metaKey)) {
      this.create();
      return true;
    }
    if (e.key === 'Delete' && this.tb.kind !== 'register') {
      void this.remove();
      return true;
    }
    if (e.key === 'F5') {
      void this.load();
      return true;
    }
    if (e.key === 'F9' && row) {
      this.copy(row);
      return true;
    }
    if (e.key === 'Backspace' && this.tb.hierarchical && this.group) {
      const parent = this.rows.find((r) => r.id === this.group)?.parent ?? null;
      this.group = parent as string | null;
      this.applyGroup();
      this.renderTree();
      return true;
    }
    return false;
  }

  private contextMenu(row: Row | null, column: GridColumn<Row> | null): MenuItem[] {
    const writable = this.app.data.writable(this.tb);
    const items: MenuItem[] = [];
    if (row) items.push({ label: t('list', 'Open'), icon: 'edit', hint: 'Enter', run: () => this.open(row) });
    if (this.tb.kind !== 'register') {
      items.push({ label: t('list', 'Create'), icon: 'plus', hint: 'Ins', disabled: !writable, run: () => this.create() });
      if (row) items.push({ label: t('list', 'Copy'), icon: 'copy', hint: 'F9', disabled: !writable, run: () => this.copy(row) });
      if (row) items.push({ label: t('list', 'Delete'), icon: 'trash', hint: 'Del', disabled: !writable, run: () => void this.remove() });
    }
    if (row && column) {
      const value = column.value(row);
      items.push({ separator: true });
      items.push({ label: t('list', 'Filter by this value'), icon: 'filter', run: () => this.grid.setFilter(column.key, value === null || value === undefined || value === '' ? '=' : column.kind === 'text' ? `=${String(value)}` : column.kind === 'date' ? String(value).slice(0, 10) : String(value)) });
      items.push({ label: t('list', 'Copy the value'), icon: 'copy', run: () => void navigator.clipboard?.writeText(String(value ?? '')) });
    }
    const actions = this.actions();
    if (actions.length) {
      items.push({ separator: true });
      for (const a of actions) items.push({ label: a.title, icon: a.icon ?? 'bolt', run: () => void this.runAction(a) });
    }
    if (this.app.isDesign() && column) items.push({ separator: true }, ...this.headerMenu(column));
    return items;
  }

  private headerMenu(column: GridColumn<Row>): MenuItem[] {
    if (!this.app.isDesign()) return [];
    const name = column.key.split('.')[0]!;
    return [
      { title: t('list', 'Designer') },
      { label: t('list', 'Field properties “{field}”', { field: column.title }), icon: 'wrench', run: () => this.app.designTable(this.tb.name, name) },
      { label: t('list', 'Add a field…'), icon: 'plus', run: () => this.app.designTable(this.tb.name, '+') },
    ];
  }

  /* ------------------------------ details ------------------------------ */

  private renderDetailTabs(details: DetailDef[]): void {
    if (!this.detailTabs) return;
    const tabs = details.map((d, i) => {
      const b = h('button', { type: 'button', class: `subtab${i === this.activeDetail ? ' active' : ''}` }, d.title ?? d.table ?? d.part ?? '');
      b.addEventListener('click', () => {
        this.activeDetail = i;
        this.renderDetailTabs(details);
        this.showDetail(true);
      });
      return b;
    });
    clear(this.detailTabs, ...tabs);
    this.detailTabs.dataset.count = String(details.length);
    (this.detailTabs as HTMLElement & { details?: DetailDef[] }).details = details;
  }

  private lastDetailFor: string | null = null;

  private showDetail = debounce((force?: boolean) => void this.renderDetail(force === true), 120);

  private async renderDetail(force: boolean): Promise<void> {
    if (!this.detailBody || !this.detailTabs) return;
    const details = (this.detailTabs as HTMLElement & { details?: DetailDef[] }).details ?? [];
    const d = details[this.activeDetail];
    const row = this.grid.current();
    const key = `${this.activeDetail}:${row?.id ?? ''}:${row?._rev ?? ''}`;
    if (!force && key === this.lastDetailFor) return;
    this.lastDetailFor = key;
    this.detailGrid?.dispose();
    this.detailGrid = null;
    if (!d || !row || row.isFolder) {
      clear(this.detailBody, h('div', { class: 'grid-empty' }, row?.isFolder ? '' : t('list', 'Select a record to see what is linked to it')));
      return;
    }
    const config = this.app.data.config;
    if (d.kind === 'part') {
      const part = (this.tb.parts ?? []).find((p) => p.name === d.part);
      if (!part) return;
      const fake: TableDef = { key: `${this.tb.key}.${part.key}`, name: `${this.tb.name}.${part.name}`, kind: 'table', title: part.title ?? part.name, fields: part.fields };
      const lines = ((row[part.name] as Row[] | undefined) ?? []).map((l, i) => ({ ...l, id: String(i + 1) }));
      const grid = new Grid<Row>({ columns: [], idOf: (r) => r.id, filterRow: false, onOpen: () => this.open(row) });
      const maps = await columnMaps(this.app.data, fake, part.fields.map((f) => ({ field: f.name })));
      const cols = gridColumns(this.app.data, fake, part.fields.map((f) => ({ field: f.name, ...(f.type === 'decimal' && /amount|sum|total/i.test(f.name) ? { total: 'sum' as const } : {}) })), maps);
      grid.setColumns([{ key: '#', title: '#', width: 44, kind: 'number', align: 'num', value: (r) => Number(r.id) }, ...cols]);
      grid.setRows(lines);
      clear(this.detailBody, grid.el);
      return;
    }
    if (d.kind === 'versions') {
      const v = { key: `detail_${d.key}`, name: `detail_${d.key}`, table: this.tb.name, title: d.title ?? this.tb.title, columns: [{ field: 'validFrom' }, { field: 'validTo' }, ...this.view.columns.filter((c) => c.field !== 'validFrom' && c.field !== 'validTo')], sort: [{ field: 'validFrom', desc: true }] };
      this.detailGrid = new ListPage(this.app, v, { embedded: true, versions: true, filter: { field: 'seriesId', op: 'eq', value: row.seriesId ?? row.id } });
      clear(this.detailBody, this.detailGrid.el);
      return;
    }
    const target = tableOf(config, d.table);
    if (!target) return;
    if (d.kind === 'view') {
      const v = (d.view && config.views.find((x) => x.name === d.view)) || { key: `detail_${d.key}`, name: `detail_${d.key}`, table: target.name, title: d.title ?? target.title, columns: defaultDetailColumns(target) };
      this.detailGrid = new ListPage(this.app, v, { embedded: true, ...(d.where ? { where: d.where } : {}), vars: { master: row } });
      clear(this.detailBody, this.detailGrid.el);
      return;
    }
    const filter: Filter = d.kind === 'movements' ? { field: 'recorder', op: 'eq', value: row.id } : { field: d.field ?? '', op: 'eq', value: row.id };
    const v = (d.view && config.views.find((x) => x.name === d.view)) || { key: `detail_${d.key}`, name: `detail_${d.key}`, table: target.name, title: d.title ?? target.title, columns: defaultDetailColumns(target, d.field) };
    this.detailGrid = new ListPage(this.app, v, { embedded: true, filter, init: d.kind === 'backref' && d.field ? { [d.field]: row.id } : {} });
    clear(this.detailBody, this.detailGrid.el);
  }

  private wireSplitter(splitter: HTMLElement, top: HTMLElement, bottom: HTMLElement): void {
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('dragging');
      const parent = splitter.parentElement!.getBoundingClientRect();
      const move = (m: PointerEvent) => {
        const ratio = Math.min(0.9, Math.max(0.15, (m.clientY - parent.top) / parent.height));
        top.style.flex = `${ratio} 1 0`;
        bottom.style.flex = `${1 - ratio} 1 0`;
        settings.splits[`list:${this.view.name}`] = Math.round(ratio * 100) / 100;
      };
      const up = () => {
        splitter.classList.remove('dragging');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        saveSettings();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
  }
}

function defaultDetailColumns(tb: TableDef, without?: string): ColumnDef[] {
  return allFields(tb)
    .filter((f) => f.name !== without && f.list !== false && f.type !== 'text' && f.name !== 'isFolder' && f.name !== 'parent')
    .slice(0, 9)
    .map((f) => ({ field: f.name, ...(f.type === 'decimal' && f.role === 'resource' ? { total: 'sum' as const } : {}) }));
}

function combine(a?: Filter, b?: Filter): Filter | undefined {
  if (a && b) return { and: [a, b] };
  return a ?? b;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
