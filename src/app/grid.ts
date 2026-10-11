/**
 * The grid (Task.md 8.2): virtual scrolling over any number of rows, sorting
 * (Shift adds a key), the auto-filter row, grouping by dragging a header to
 * the group bar, totals, multi-select, resizing and reordering columns,
 * editing in cells, and the keyboard.
 *
 * It works on what it is given: the caller loads the rows, the grid filters,
 * sorts and groups them on the client. Each column gives a `value` — the
 * thing sorted, filtered and grouped (a reference's label, an enum's title) —
 * and a `render` for the cell.
 */
import { t, tn } from '../core/i18n';
import type { AggregateFn, Filter } from '../core/query/types';
import { compare, matches, parseQuickFilter, type QuickKind } from '../core/query/index';
import { formatNumber } from '../core/format';
import { h, icon, clear, rafThrottle, modKey } from './dom';
import { popupMenu, type MenuItem } from './ui';

export interface GridColumn<R> {
  key: string;
  title: string;
  width: number;
  align?: 'num' | 'center';
  kind: QuickKind;
  value(row: R): unknown;
  render?(row: R, value: unknown): string | Node;
  total?: AggregateFn;
  /** Decimals for totals. */
  scale?: number;
  editable?: boolean;
  hidden?: boolean;
}

export interface CellStyle {
  background?: string;
  color?: string;
  bold?: boolean;
}

export interface GridOptions<R> {
  columns: GridColumn<R>[];
  idOf(row: R): string;
  multi?: boolean;
  filterRow?: boolean;
  groupBar?: boolean;
  footer?: boolean;
  emptyText?: string;
  /** Row and cell styles from conditional formatting. */
  styleOf?(row: R): { row?: CellStyle; cells?: Record<string, CellStyle> } | null;
  rowClass?(row: R): string;
  onOpen?(row: R): void;
  onSelect?(rows: R[], cursor: R | null): void;
  onContext?(e: MouseEvent, row: R | null, column: GridColumn<R> | null): MenuItem[];
  onHeaderMenu?(column: GridColumn<R>): MenuItem[];
  /** Mounts an editor in `cell`; calls `done` when finished (commit or not). */
  onEdit?(row: R, column: GridColumn<R>, cell: HTMLElement, done: (moved?: 'next' | 'down' | null) => void, initial?: string): void;
  onKey?(e: KeyboardEvent, row: R | null): boolean;
  /** The state the user set: sort, filters, widths, order, grouping — to remember it. */
  onState?(state: GridState): void;
  state?: Partial<GridState>;
}

export interface GridState {
  sort: { key: string; desc: boolean }[];
  filters: Record<string, string>;
  widths: Record<string, number>;
  order: string[];
  hidden: string[];
  group: string[];
}

interface Item<R> {
  row: R;
  v: Record<string, unknown>;
}

type Line<R> = { kind: 'row'; item: Item<R>; index: number } | { kind: 'group'; key: string; depth: number; value: unknown; column: GridColumn<R>; count: number; totals: Record<string, number> };

export class Grid<R> {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private totalsRow: HTMLElement | null = null;
  private foot: HTMLElement;
  private groupBar: HTMLElement | null = null;
  private items: Item<R>[] = [];
  private lines: Line<R>[] = [];
  private visible: Item<R>[] = [];
  private selected = new Set<string>();
  private cursor = -1;
  private collapsed = new Set<string>();
  private rowH = 28;
  private filterErrors = new Set<string>();
  private editing = false;
  state: GridState;
  columns: GridColumn<R>[];
  loading = false;

  constructor(private readonly opts: GridOptions<R>) {
    this.columns = opts.columns;
    this.state = { sort: [], filters: {}, widths: {}, order: [], hidden: [], group: [], ...opts.state };
    this.el = h('div', { class: 'grid', tabindex: 0 });
    if (opts.groupBar) {
      this.groupBar = h('div', { class: 'grid-group-bar' });
      this.el.appendChild(this.groupBar);
    }
    this.scroller = h('div', { class: 'grid-scroll' });
    this.head = h('div', { class: 'grid-head' });
    this.body = h('div', { class: 'grid-body' });
    this.scroller.append(this.head, this.body);
    this.el.appendChild(this.scroller);
    this.foot = h('div', { class: 'grid-foot' });
    if (opts.footer !== false) this.el.appendChild(this.foot);
    this.scroller.addEventListener('scroll', rafThrottle(() => this.paint()));
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.body.addEventListener('mousedown', (e) => this.mouse(e));
    this.body.addEventListener('dblclick', (e) => this.dbl(e));
    this.body.addEventListener('contextmenu', (e) => this.context(e));
    new ResizeObserver(rafThrottle(() => this.paint())).observe(this.scroller);
  }

  /* ------------------------------ data ------------------------------ */

  setRows(rows: R[], keepSelection = true): void {
    this.items = rows.map((row) => ({ row, v: this.valuesOf(row) }));
    if (!keepSelection) this.selected.clear();
    else {
      const ids = new Set(rows.map((r) => this.opts.idOf(r)));
      for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    }
    this.recompute();
  }

  setColumns(columns: GridColumn<R>[]): void {
    this.columns = columns;
    this.items = this.items.map((i) => ({ row: i.row, v: this.valuesOf(i.row) }));
    this.recompute();
  }

  private valuesOf(row: R): Record<string, unknown> {
    const v: Record<string, unknown> = {};
    for (const c of this.columns) {
      try {
        v[c.key] = c.value(row);
      } catch {
        v[c.key] = null;
      }
    }
    return v;
  }

  rows(): R[] {
    return this.visible.map((i) => i.row);
  }

  allRows(): R[] {
    return this.items.map((i) => i.row);
  }

  selection(): R[] {
    if (this.selected.size) return this.items.filter((i) => this.selected.has(this.opts.idOf(i.row))).map((i) => i.row);
    const c = this.current();
    return c ? [c] : [];
  }

  current(): R | null {
    const line = this.lines[this.cursor];
    return line?.kind === 'row' ? line.item.row : null;
  }

  /** Puts the cursor on the row with this id, if it is shown. */
  focusRow(id: string): void {
    const at = this.lines.findIndex((l) => l.kind === 'row' && this.opts.idOf(l.item.row) === id);
    if (at >= 0) this.moveTo(at);
  }

  cellOf(row: R, columnKey: string): HTMLElement | null {
    const id = this.opts.idOf(row);
    return this.body.querySelector<HTMLElement>(`.grid-row[data-id="${CSS.escape(id)}"] .cell[data-col="${CSS.escape(columnKey)}"]`);
  }

  private ordered(): GridColumn<R>[] {
    const byKey = new Map(this.columns.map((c) => [c.key, c]));
    const out: GridColumn<R>[] = [];
    for (const k of this.state.order) {
      const c = byKey.get(k);
      if (c) {
        out.push(c);
        byKey.delete(k);
      }
    }
    out.push(...byKey.values());
    return out.filter((c) => !this.state.hidden.includes(c.key) && !c.hidden);
  }

  private width(c: GridColumn<R>): number {
    return this.state.widths[c.key] ?? c.width;
  }

  /** Filter → sort → group, then paint. */
  recompute(): void {
    const filters: Filter[] = [];
    this.filterErrors.clear();
    for (const [key, text] of Object.entries(this.state.filters)) {
      const c = this.columns.find((x) => x.key === key);
      if (!c || !text.trim()) continue;
      const f = parseQuickFilter(key, text, c.kind);
      if (f && 'error' in f) this.filterErrors.add(key);
      else if (f) filters.push(f);
    }
    const where: Filter | undefined = filters.length ? { and: filters } : undefined;
    let visible = where ? this.items.filter((i) => matches(i.v, where)) : this.items.slice();
    const sort = this.state.sort.filter((s) => this.columns.some((c) => c.key === s.key));
    if (sort.length) {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      visible = visible
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          for (const s of sort) {
            const d = compare(a.item.v[s.key], b.item.v[s.key], collator);
            if (d) return s.desc ? -d : d;
          }
          return a.index - b.index;
        })
        .map((x) => x.item);
    }
    this.visible = visible;
    this.lines = [];
    const group = this.state.group.map((k) => this.columns.find((c) => c.key === k)).filter((c): c is GridColumn<R> => !!c);
    if (!group.length) visible.forEach((item, index) => this.lines.push({ kind: 'row', item, index }));
    else this.groupLines(visible, group, 0, '');
    if (this.cursor >= this.lines.length) this.cursor = this.lines.length - 1;
    this.renderHead();
    this.renderGroupBar();
    this.paint(true);
    this.renderFoot();
  }

  private groupLines(items: Item<R>[], group: GridColumn<R>[], depth: number, prefix: string): void {
    const column = group[depth]!;
    const buckets = new Map<string, { value: unknown; items: Item<R>[] }>();
    for (const item of items) {
      const value = item.v[column.key];
      const key = JSON.stringify(value ?? null);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { value, items: [] }));
      b.items.push(item);
    }
    const sorted = [...buckets.entries()].sort((a, b) => compare(a[1].value, b[1].value));
    for (const [key, b] of sorted) {
      const id = `${prefix}/${key}`;
      const totals: Record<string, number> = {};
      for (const c of this.columns) if (c.total) totals[c.key] = this.aggregate(c, b.items);
      this.lines.push({ kind: 'group', key: id, depth, value: b.value, column, count: b.items.length, totals });
      if (this.collapsed.has(id)) continue;
      if (depth + 1 < group.length) this.groupLines(b.items, group, depth + 1, id);
      else b.items.forEach((item, index) => this.lines.push({ kind: 'row', item, index }));
    }
  }

  private aggregate(c: GridColumn<R>, items: Item<R>[]): number {
    const values = items.map((i) => i.v[c.key]).filter((v): v is number => typeof v === 'number');
    switch (c.total) {
      case 'sum':
        return Number(values.reduce((a, b) => a + b, 0).toPrecision(15));
      case 'avg':
        return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toPrecision(15)) : 0;
      case 'min':
        return values.length ? Math.min(...values) : 0;
      case 'max':
        return values.length ? Math.max(...values) : 0;
      case 'countDistinct':
        return new Set(items.map((i) => JSON.stringify(i.v[c.key]))).size;
      default:
        return items.filter((i) => i.v[c.key] !== null && i.v[c.key] !== undefined && i.v[c.key] !== '').length;
    }
  }

  /* ------------------------------ painting ------------------------------ */

  private renderHead(): void {
    const cols = this.ordered();
    const row = h('div', { class: 'grid-row' });
    if (this.opts.multi) {
      const all = h('input', { type: 'checkbox', 'aria-label': t('grid', 'Select all') });
      all.checked = this.visible.length > 0 && this.visible.every((i) => this.selected.has(this.opts.idOf(i.row)));
      all.addEventListener('change', () => {
        if (all.checked) for (const i of this.visible) this.selected.add(this.opts.idOf(i.row));
        else this.selected.clear();
        this.paint(true);
        this.emitSelect();
      });
      row.appendChild(h('div', { class: 'cell sel' }, all));
    }
    for (const c of cols) {
      const s = this.state.sort.findIndex((x) => x.key === c.key);
      const cell = h(
        'div',
        { class: `cell ${c.align ?? ''}`, style: { width: `${this.width(c)}px` }, draggable: 'true', 'data-col': c.key, title: c.title },
        h('span', { class: 't' }, c.title),
        s >= 0 ? h('span', { class: 'sort' }, `${this.state.sort[s]!.desc ? '▼' : '▲'}${this.state.sort.length > 1 ? s + 1 : ''}`) : null,
      );
      const grip = h('span', { class: 'resize' });
      cell.appendChild(grip);
      cell.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('resize')) return;
        this.toggleSort(c.key, e.shiftKey);
      });
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        popupMenu({ x: e.clientX, y: e.clientY }, this.headerMenu(c));
      });
      grip.addEventListener('pointerdown', (e) => this.startResize(e, c, cell));
      grip.addEventListener('dblclick', () => this.autoWidth(c));
      cell.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/x-grid-col', c.key);
        e.dataTransfer!.effectAllowed = 'move';
      });
      cell.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('text/x-grid-col')) {
          e.preventDefault();
          cell.classList.add('drag-over');
        }
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
      cell.addEventListener('drop', (e) => {
        cell.classList.remove('drag-over');
        const from = e.dataTransfer?.getData('text/x-grid-col');
        if (!from || from === c.key) return;
        e.preventDefault();
        const order = this.ordered().map((x) => x.key).filter((k) => k !== from);
        order.splice(order.indexOf(c.key), 0, from);
        this.state.order = order;
        this.changed();
        this.renderHead();
        this.paint(true);
      });
      row.appendChild(cell);
    }
    const nodes: Node[] = [row];
    if (this.opts.filterRow !== false) {
      const filters = h('div', { class: 'grid-row grid-filter-row' });
      if (this.opts.multi) filters.appendChild(h('div', { class: 'cell sel' }));
      for (const c of cols) {
        const value = this.state.filters[c.key] ?? '';
        const input = h('input', {
          'data-filter': c.key,
          value,
          class: `${this.filterErrors.has(c.key) ? 'error' : ''} ${value.trim() && !this.filterErrors.has(c.key) ? 'active' : ''}`,
          placeholder: c.kind === 'number' ? '>0, 1..9' : c.kind === 'date' ? '>=01.01.2026' : '',
          'aria-label': t('grid', 'Filter by {column}', { column: c.title }),
          title: t('grid', 'Text: contains; =exact, abc*, !abc. Numbers and dates: >, <, >=, <=, <>, a..b'),
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        input.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (input.value.trim()) this.state.filters[c.key] = input.value;
            else delete this.state.filters[c.key];
            const focused = c.key;
            const pos = input.selectionStart;
            this.recompute();
            this.changed();
            const again = this.head.querySelector<HTMLInputElement>(`input[data-filter="${CSS.escape(focused)}"]`);
            again?.focus();
            if (again && pos !== null) again.setSelectionRange(pos, pos);
          }, 220);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.el.focus();
            this.moveTo(Math.max(0, this.cursor));
          }
          if (e.key === 'Escape' && input.value) {
            e.stopPropagation();
            input.value = '';
            input.dispatchEvent(new Event('input'));
          }
        });
        filters.appendChild(h('div', { class: 'cell', style: { width: `${this.width(c)}px` } }, input));
      }
      nodes.push(filters);
    }
    clear(this.head, ...nodes);
    const total = cols.reduce((sum, c) => sum + this.width(c), this.opts.multi ? 32 : 0);
    this.head.style.width = `${total}px`;
    this.body.style.width = `${total}px`;
  }

  private renderGroupBar(): void {
    if (!this.groupBar) return;
    const bar = this.groupBar;
    const chips = this.state.group.map((k) => {
      const c = this.columns.find((x) => x.key === k);
      return h('span', { class: 'chip' }, c?.title ?? k, h('button', { class: 'btn icon-only', type: 'button', 'aria-label': t('grid', 'Ungroup'), style: { width: '18px', height: '18px' }, onclick: () => this.setGroup(this.state.group.filter((x) => x !== k)) }, icon('x', 12)));
    });
    clear(bar, icon('group'), chips.length ? chips : h('span', null, t('grid', 'Drag a column header here to group by it')));
    if (!bar.dataset.wired) {
      bar.dataset.wired = '1';
      bar.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('text/x-grid-col')) {
          e.preventDefault();
          bar.classList.add('drop');
        }
      });
      bar.addEventListener('dragleave', () => bar.classList.remove('drop'));
      bar.addEventListener('drop', (e) => {
        bar.classList.remove('drop');
        const key = e.dataTransfer?.getData('text/x-grid-col');
        if (key && !this.state.group.includes(key)) {
          e.preventDefault();
          this.setGroup([...this.state.group, key]);
        }
      });
    }
  }

  setGroup(keys: string[]): void {
    this.state.group = keys;
    this.collapsed.clear();
    this.changed();
    this.recompute();
  }

  private renderFoot(): void {
    const total = this.items.length;
    const shown = this.visible.length;
    const sel = this.selected.size;
    const parts: (Node | string)[] = [];
    parts.push(
      h(
        'span',
        null,
        this.loading
          ? t('grid', 'Loading…')
          : shown === total
            ? tn('grid', '{count} record', '{count} records', total)
            : t('grid', '{shown} of {total}', { shown: formatNumber(shown, 0), total: formatNumber(total, 0) }),
      ),
    );
    if (sel) parts.push(h('span', null, tn('grid', '{count} selected', '{count} selected', sel)));
    const cursor = this.current();
    if (cursor && !sel) {
      const at = this.visible.findIndex((i) => i.row === cursor);
      if (at >= 0) parts.push(h('span', { class: 'muted' }, t('grid', 'Record {n} of {total}', { n: formatNumber(at + 1, 0), total: formatNumber(shown, 0) })));
    }
    if (Object.keys(this.state.filters).length) {
      parts.push(h('button', { class: 'btn', type: 'button', style: { height: '22px' }, onclick: () => this.clearFilters() }, icon('x', 12), t('grid', 'Clear filters')));
    }
    clear(this.foot, ...parts);
  }

  clearFilters(): void {
    this.state.filters = {};
    this.changed();
    this.recompute();
  }

  setFilter(key: string, text: string): void {
    if (text) this.state.filters[key] = text;
    else delete this.state.filters[key];
    this.changed();
    this.recompute();
  }

  /** Draws the rows in view (and a few around): the rest of the body is empty height. */
  paint(force = false): void {
    this.rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 28;
    const cols = this.ordered();
    const totalsH = this.hasTotals() ? this.rowH : 0;
    this.body.style.height = `${this.lines.length * this.rowH + totalsH}px`;
    const headH = this.head.offsetHeight;
    const top = Math.max(0, this.scroller.scrollTop - headH);
    const first = Math.max(0, Math.floor(top / this.rowH) - 8);
    const last = Math.min(this.lines.length, Math.ceil((top + this.scroller.clientHeight) / this.rowH) + 8);
    if (!force && this.body.dataset.range === `${first}:${last}` && !this.editing) return;
    // Not under an open cell editor, forced or not: the edit's end repaints (edit() → done).
    if (this.editing) return;
    this.body.dataset.range = `${first}:${last}`;
    const frag = document.createDocumentFragment();
    if (!this.lines.length) {
      frag.appendChild(h('div', { class: 'grid-empty' }, this.loading ? t('grid', 'Loading…') : this.items.length ? t('grid', 'Nothing matches the filters') : (this.opts.emptyText ?? t('grid', 'No records yet'))));
      this.body.style.height = '120px';
    }
    for (let i = first; i < last; i++) frag.appendChild(this.renderLine(i, cols));
    if (totalsH) frag.appendChild(this.renderTotals(cols));
    clear(this.body, frag);
  }

  private hasTotals(): boolean {
    return this.columns.some((c) => c.total) && this.visible.length > 0;
  }

  private renderTotals(cols: GridColumn<R>[]): HTMLElement {
    const row = h('div', { class: 'grid-row grid-totals', style: { top: `${this.lines.length * this.rowH}px`, position: 'absolute' } });
    if (this.opts.multi) row.appendChild(h('div', { class: 'cell sel' }));
    // The word goes in the first column wide enough for it, not into a narrow "#".
    const labelAt = cols.findIndex((c) => !c.total && this.width(c) >= 70);
    cols.forEach((c, i) => {
      const value = c.total ? this.aggregate(c, this.visible) : null;
      row.appendChild(h('div', { class: `cell ${c.align ?? ''}`, style: { width: `${this.width(c)}px` } }, value !== null ? formatNumber(value, c.total === 'count' || c.total === 'countDistinct' ? 0 : (c.scale ?? 2), c.total !== 'count') : i === labelAt ? t('grid', 'Total') : ''));
    });
    this.totalsRow = row;
    return row;
  }

  private renderLine(i: number, cols: GridColumn<R>[]): HTMLElement {
    const line = this.lines[i]!;
    if (line.kind === 'group') {
      const collapsed = this.collapsed.has(line.key);
      const label = line.column.render ? line.column.render({} as R, line.value) : line.value === null || line.value === undefined || line.value === '' ? t('grid', '(empty)') : String(line.value);
      const totals = Object.entries(line.totals).map(([k, v]) => {
        const c = this.columns.find((x) => x.key === k);
        return `${c?.title ?? k}: ${formatNumber(v, c?.total === 'count' ? 0 : (c?.scale ?? 2))}`;
      });
      const row = h(
        'div',
        { class: 'grid-row group-row', style: { top: `${i * this.rowH}px` }, 'data-line': i },
        h('div', { class: 'cell', style: { width: '100%', paddingInlineStart: `${8 + line.depth * 18}px` } }, icon(collapsed ? 'chevronRight' : 'chevronDown', 14), ' ', `${line.column.title}: `, typeof label === 'string' ? label : (label.textContent ?? ''), h('span', { class: 'muted' }, `  (${line.count})${totals.length ? `  ·  ${totals.join('  ·  ')}` : ''}`)),
      );
      return row;
    }
    const { item } = line;
    const id = this.opts.idOf(item.row);
    const style = this.opts.styleOf?.(item.row) ?? null;
    const cls = `grid-row${line.index % 2 ? ' alt' : ''}${this.selected.has(id) ? ' selected' : ''}${i === this.cursor ? ' cursor' : ''} ${this.opts.rowClass?.(item.row) ?? ''}`;
    const row = h('div', { class: cls, style: { top: `${i * this.rowH}px` }, 'data-line': i, 'data-id': id });
    if (style?.row && !this.selected.has(id)) applyStyle(row, style.row);
    if (this.opts.multi) {
      const box = h('input', { type: 'checkbox', tabindex: -1, 'aria-label': t('grid', 'Select') });
      box.checked = this.selected.has(id);
      row.appendChild(h('div', { class: 'cell sel' }, box));
    }
    for (const c of cols) {
      const value = item.v[c.key];
      const content = c.render ? c.render(item.row, value) : defaultRender(value);
      const cell = h('div', { class: `cell ${c.align ?? ''}`, style: { width: `${this.width(c)}px` }, 'data-col': c.key }, content);
      if (typeof content === 'string') cell.title = content;
      const cs = style?.cells?.[c.key];
      if (cs) applyStyle(cell, cs);
      row.appendChild(cell);
    }
    return row;
  }

  /** Updates the selected and cursor marks of the rows on screen without redrawing them. */
  private refreshMarks(): void {
    for (const el of Array.from(this.body.children) as HTMLElement[]) {
      const i = Number(el.dataset.line);
      const line = this.lines[i];
      if (line?.kind !== 'row') continue;
      const selected = this.selected.has(this.opts.idOf(line.item.row));
      el.classList.toggle('selected', selected);
      el.classList.toggle('cursor', i === this.cursor);
      const box = el.querySelector<HTMLInputElement>('.cell.sel input');
      if (box) box.checked = selected;
      const style = this.opts.styleOf?.(line.item.row)?.row;
      if (style) {
        el.style.background = selected ? '' : (style.background ?? '');
        el.style.color = selected ? '' : (style.color ?? '');
      }
    }
  }

  /* ------------------------------ interaction ------------------------------ */

  private lineAt(e: MouseEvent): number {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.grid-row');
    return el?.dataset.line ? Number(el.dataset.line) : -1;
  }

  private mouse(e: MouseEvent): void {
    if (this.editing) return;
    const i = this.lineAt(e);
    if (i < 0) return;
    const line = this.lines[i]!;
    if (line.kind === 'group') {
      if (this.collapsed.has(line.key)) this.collapsed.delete(line.key);
      else this.collapsed.add(line.key);
      this.recompute();
      return;
    }
    const id = this.opts.idOf(line.item.row);
    const onBox = (e.target as HTMLElement).closest('.cell.sel');
    if (onBox || (this.opts.multi && modKey(e))) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      e.preventDefault();
    } else if (this.opts.multi && e.shiftKey && this.cursor >= 0) {
      const [a, b] = [Math.min(this.cursor, i), Math.max(this.cursor, i)];
      for (let k = a; k <= b; k++) {
        const l = this.lines[k];
        if (l?.kind === 'row') this.selected.add(this.opts.idOf(l.item.row));
      }
      e.preventDefault();
    } else if (e.button === 0 && this.selected.size) this.selected.clear();
    this.cursor = i;
    // Classes only: replacing the rows here would lose the second click of a double click.
    this.refreshMarks();
    this.renderFoot();
    this.emitSelect();
    if (!onBox) setTimeout(() => this.el.focus({ preventScroll: true }));
  }

  private dbl(e: MouseEvent): void {
    const i = this.lineAt(e);
    const line = this.lines[i];
    if (line?.kind !== 'row') return;
    const cellEl = (e.target as HTMLElement).closest<HTMLElement>('.cell[data-col]');
    const column = cellEl ? this.columns.find((c) => c.key === cellEl.dataset.col) : undefined;
    if (column?.editable && this.opts.onEdit) this.edit(line.item.row, column);
    else this.opts.onOpen?.(line.item.row);
  }

  private context(e: MouseEvent): void {
    if (!this.opts.onContext) return;
    e.preventDefault();
    const i = this.lineAt(e);
    const line = this.lines[i];
    let row: R | null = null;
    if (line?.kind === 'row') {
      row = line.item.row;
      if (!this.selected.has(this.opts.idOf(row))) {
        this.selected.clear();
        this.cursor = i;
        this.paint(true);
        this.emitSelect();
      }
    }
    const cellEl = (e.target as HTMLElement).closest<HTMLElement>('.cell[data-col]');
    const column = cellEl ? (this.columns.find((c) => c.key === cellEl.dataset.col) ?? null) : null;
    const items = this.opts.onContext(e, row, column);
    if (items.length) popupMenu({ x: e.clientX, y: e.clientY }, items);
  }

  /** Starts editing a cell (Enter, F2, double click or typing). */
  edit(row: R, column: GridColumn<R>, initial?: string): void {
    if (!this.opts.onEdit || !column.editable) return;
    const cell = this.cellOf(row, column.key);
    if (!cell) return;
    this.editing = true;
    this.opts.onEdit(row, column, cell, (moved) => {
      this.editing = false;
      const items = this.items.find((i) => i.row === row);
      if (items) items.v = this.valuesOf(row);
      this.paint(true);
      this.renderFoot();
      if (moved === 'next') {
        const cols = this.ordered().filter((c) => c.editable);
        const at = cols.findIndex((c) => c.key === column.key);
        const next = cols[at + 1];
        if (next) setTimeout(() => this.edit(row, next));
        else this.el.focus({ preventScroll: true });
      } else if (moved === 'down') {
        this.moveTo(this.cursor + 1);
        const nextRow = this.current();
        if (nextRow && nextRow !== row) setTimeout(() => this.edit(nextRow, column));
        else this.el.focus({ preventScroll: true });
      } else this.el.focus({ preventScroll: true });
    }, initial);
  }

  private moveTo(i: number): void {
    if (!this.lines.length) return;
    this.cursor = Math.max(0, Math.min(this.lines.length - 1, i));
    const top = this.cursor * this.rowH;
    const headH = this.head.offsetHeight;
    const viewTop = this.scroller.scrollTop;
    const viewH = this.scroller.clientHeight - headH - (this.hasTotals() ? this.rowH : 0);
    if (top < viewTop) this.scroller.scrollTop = top;
    else if (top + this.rowH > viewTop + viewH) this.scroller.scrollTop = top + this.rowH - viewH;
    this.paint(true);
    this.renderFoot();
    this.emitSelect();
  }

  private key(e: KeyboardEvent): void {
    if (this.editing || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (this.opts.onKey?.(e, this.current())) {
      e.preventDefault();
      return;
    }
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / this.rowH) - 2);
    switch (e.key) {
      case 'ArrowDown':
        this.moveTo(this.cursor + 1);
        break;
      case 'ArrowUp':
        this.moveTo(this.cursor - 1);
        break;
      case 'PageDown':
        this.moveTo(this.cursor + page);
        break;
      case 'PageUp':
        this.moveTo(this.cursor - page);
        break;
      case 'Home':
        this.moveTo(0);
        break;
      case 'End':
        this.moveTo(this.lines.length - 1);
        break;
      case ' ': {
        const row = this.current();
        if (!row || !this.opts.multi) return;
        const id = this.opts.idOf(row);
        if (this.selected.has(id)) this.selected.delete(id);
        else this.selected.add(id);
        this.paint(true);
        this.renderFoot();
        this.emitSelect();
        break;
      }
      case 'Enter': {
        const line = this.lines[this.cursor];
        if (line?.kind === 'group') {
          if (this.collapsed.has(line.key)) this.collapsed.delete(line.key);
          else this.collapsed.add(line.key);
          this.recompute();
        } else if (line?.kind === 'row') {
          const editable = this.ordered().find((c) => c.editable);
          if (editable && this.opts.onEdit) this.edit(line.item.row, editable);
          else this.opts.onOpen?.(line.item.row);
        }
        break;
      }
      case 'F2': {
        const row = this.current();
        const editable = this.ordered().find((c) => c.editable);
        if (row && editable) this.edit(row, editable);
        break;
      }
      case 'a':
        if (modKey(e) && this.opts.multi) {
          for (const i of this.visible) this.selected.add(this.opts.idOf(i.row));
          this.paint(true);
          this.renderFoot();
          this.emitSelect();
          break;
        }
        return;
      default:
        return;
    }
    e.preventDefault();
  }

  private emitSelect(): void {
    this.opts.onSelect?.(this.selection(), this.current());
  }

  private toggleSort(key: string, add: boolean): void {
    const at = this.state.sort.findIndex((s) => s.key === key);
    if (add) {
      if (at >= 0) this.state.sort[at] = { key, desc: !this.state.sort[at]!.desc };
      else this.state.sort.push({ key, desc: false });
    } else if (at >= 0 && this.state.sort.length === 1) this.state.sort = this.state.sort[0]!.desc ? [] : [{ key, desc: true }];
    else this.state.sort = [{ key, desc: false }];
    this.changed();
    this.recompute();
  }

  private headerMenu(c: GridColumn<R>): MenuItem[] {
    const items: MenuItem[] = [
      { label: t('grid', 'Sort ascending'), icon: 'arrowUp', run: () => ((this.state.sort = [{ key: c.key, desc: false }]), this.changed(), this.recompute()) },
      { label: t('grid', 'Sort descending'), icon: 'arrowDown', run: () => ((this.state.sort = [{ key: c.key, desc: true }]), this.changed(), this.recompute()) },
      { label: t('grid', 'Clear sorting'), disabled: !this.state.sort.length, run: () => ((this.state.sort = []), this.changed(), this.recompute()) },
      { separator: true },
      { label: t('grid', 'Group by this column'), icon: 'group', disabled: this.state.group.includes(c.key), run: () => this.setGroup([...this.state.group, c.key]) },
      { label: t('grid', 'Hide column'), icon: 'eyeOff', run: () => ((this.state.hidden = [...this.state.hidden, c.key]), this.changed(), this.recompute()) },
      { label: t('grid', 'Columns…'), icon: 'columns', run: () => this.chooseColumns() },
      { label: t('grid', 'Best fit'), run: () => this.autoWidth(c) },
      { label: t('grid', 'Best fit (all columns)'), run: () => this.ordered().forEach((x) => this.autoWidth(x, false)) },
    ];
    const extra = this.opts.onHeaderMenu?.(c) ?? [];
    return extra.length ? [...extra, { separator: true }, ...items] : items;
  }

  chooseColumns(): void {
    const items: MenuItem[] = [{ title: t('grid', 'Columns') }];
    for (const c of this.columns) {
      const hidden = this.state.hidden.includes(c.key);
      items.push({
        label: c.title,
        icon: hidden ? 'square' : 'checkSquare',
        run: () => {
          this.state.hidden = hidden ? this.state.hidden.filter((k) => k !== c.key) : [...this.state.hidden, c.key];
          this.changed();
          this.recompute();
          setTimeout(() => this.chooseColumns());
        },
      });
    }
    const r = this.head.getBoundingClientRect();
    popupMenu({ x: r.left + 40, y: r.top + 30 }, items);
  }

  private startResize(e: PointerEvent, c: GridColumn<R>, cell: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const base = this.width(c);
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const rtl = document.documentElement.dir === 'rtl';
    const move = (m: PointerEvent) => {
      const w = Math.max(40, Math.round(base + (rtl ? start - m.clientX : m.clientX - start)));
      this.state.widths[c.key] = w;
      cell.style.width = `${w}px`;
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      this.changed();
      this.renderHead();
      this.paint(true);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  private autoWidth(c: GridColumn<R>, repaint = true): void {
    const probe = h('span', { style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap', font: getComputedStyle(this.el).font } });
    document.body.appendChild(probe);
    let w = 0;
    probe.textContent = c.title;
    w = probe.offsetWidth + 34;
    for (const item of this.visible.slice(0, 500)) {
      const content = c.render ? c.render(item.row, item.v[c.key]) : defaultRender(item.v[c.key]);
      probe.textContent = typeof content === 'string' ? content : (content.textContent ?? '');
      w = Math.max(w, probe.offsetWidth + 20);
    }
    probe.remove();
    this.state.widths[c.key] = Math.min(600, Math.max(50, w));
    if (repaint) {
      this.changed();
      this.renderHead();
      this.paint(true);
    } else {
      this.changed();
      this.renderHead();
      this.paint(true);
    }
  }

  private changed(): void {
    this.opts.onState?.(structuredClone(this.state));
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.renderFoot();
    if (loading && !this.items.length) this.paint(true);
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
    if (this.cursor < 0 && this.lines.length) this.moveTo(0);
  }
}

function applyStyle(el: HTMLElement, s: CellStyle): void {
  if (s.background) el.style.background = s.background;
  if (s.color) el.style.color = s.color;
  if (s.bold) el.style.fontWeight = '600';
}

function defaultRender(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? '✓' : '';
  return String(value);
}
