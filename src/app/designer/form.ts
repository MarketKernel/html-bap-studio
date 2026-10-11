/**
 * The form designer (Task.md 9.3): the element tree on the left, the form on
 * a canvas in the middle — drawn by the card's own renderLayout(), so what is
 * designed is what a record opens in — and on the right the selected
 * element's properties, the fields that are not on the form yet and the
 * palette of new elements. Elements are moved by dragging (on the canvas or in
 * the tree) or with Alt+arrows; every edit is one step of undo.
 *
 * The tree operations are small pure functions over a FormNode tree, exported
 * so they can be tested without a page.
 */
import { t } from '../../core/i18n';
import { allFields, backReferences, defaultForm, field as fieldOf, fieldTitle, formFields, IDENT, newKey, table as tableOf } from '../../core/config/model';
import type { Config, FormDef, FormNode, TableDef } from '../../core/config/types';
import { button, clear, h, icon } from '../dom';
import { editorFor } from '../fields';
import { confirm, toast } from '../ui';
import { renderLayout, type LayoutRenderers } from '../pages/card';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { checkProp, numberProp, section, selectProp, textProp } from './props';

/* ------------------------------------------------------------------ *
 * Pure tree helpers
 * ------------------------------------------------------------------ */

export type ContainerNode = Extract<FormNode, { children: FormNode[] }>;
export type Place = 'before' | 'after' | 'into';

export function isContainer(node: FormNode): node is ContainerNode {
  return 'children' in node;
}

/** A tab lives only in tabs, and tabs hold only tabs. */
export function accepts(container: FormNode, child: FormNode): boolean {
  if (!isContainer(container)) return false;
  return container.type === 'tabs' ? child.type === 'tab' : child.type !== 'tab';
}

export function findNode(root: FormNode, key: string): FormNode | undefined {
  if (root.key === key) return root;
  if (!isContainer(root)) return undefined;
  for (const c of root.children) {
    const found = findNode(c, key);
    if (found) return found;
  }
  return undefined;
}

export function findParent(root: FormNode, key: string): { parent: ContainerNode; index: number } | undefined {
  if (!isContainer(root)) return undefined;
  const index = root.children.findIndex((c) => c.key === key);
  if (index >= 0) return { parent: root, index };
  for (const c of root.children) {
    const found = findParent(c, key);
    if (found) return found;
  }
  return undefined;
}

/** Every node in tree order, the root first, with its depth. */
export function flatten(root: FormNode, depth = 0, out: { node: FormNode; depth: number }[] = []): { node: FormNode; depth: number }[] {
  out.push({ node: root, depth });
  if (isContainer(root)) for (const c of root.children) flatten(c, depth + 1, out);
  return out;
}

/** Removes the node (not the root); returns it. */
export function removeNode(root: FormNode, key: string): FormNode | undefined {
  const at = findParent(root, key);
  if (!at) return undefined;
  return at.parent.children.splice(at.index, 1)[0];
}

/** Whether `node` may go before/after/into the target. */
export function canPlace(root: FormNode, node: FormNode, targetKey: string, place: Place): boolean {
  const target = findNode(root, targetKey);
  if (!target) return false;
  if (place === 'into') return accepts(target, node);
  const at = findParent(root, targetKey);
  return !!at && accepts(at.parent, node);
}

/** Inserts `node` before/after the target or at the end of it; false when that is not allowed. */
export function insertNode(root: FormNode, node: FormNode, targetKey: string, place: Place): boolean {
  if (!canPlace(root, node, targetKey, place)) return false;
  if (place === 'into') {
    (findNode(root, targetKey) as ContainerNode).children.push(node);
    return true;
  }
  const at = findParent(root, targetKey)!;
  at.parent.children.splice(place === 'before' ? at.index : at.index + 1, 0, node);
  return true;
}

/** Moves a node next to or into another one; never into itself. */
export function moveNode(root: FormNode, key: string, targetKey: string, place: Place): boolean {
  if (key === root.key || key === targetKey) return false;
  const node = findNode(root, key);
  if (!node || findNode(node, targetKey)) return false;
  if (!canPlace(root, node, targetKey, place)) return false;
  removeNode(root, key);
  return insertNode(root, node, targetKey, place);
}

/** Moves a node one place up (-1) or down (1) among its siblings. */
export function moveAmongSiblings(root: FormNode, key: string, by: -1 | 1): boolean {
  const at = findParent(root, key);
  if (!at) return false;
  const to = at.index + by;
  if (to < 0 || to >= at.parent.children.length) return false;
  const [node] = at.parent.children.splice(at.index, 1);
  at.parent.children.splice(to, 0, node!);
  return true;
}

/** A copy of the tree with fresh keys — for a layout taken from the automatic form. */
export function rekey(node: FormNode): FormNode {
  return { ...node, key: newKey('e'), ...(isContainer(node) ? { children: node.children.map(rekey) } : {}) } as FormNode;
}

/* ------------------------------------------------------------------ *
 * The designer page
 * ------------------------------------------------------------------ */

type NewType = 'group' | 'columns' | 'tabs' | 'tab' | 'text' | 'spacer' | 'button' | 'link' | 'part' | 'related';

/** What is being dragged: a node of the form, a hidden field or part, a new element. */
type DragItem = { kind: 'node'; key: string } | { kind: 'field'; name: string } | { kind: 'part'; name: string } | { kind: 'new'; type: NewType };

const DRAG_TYPE = 'application/x-bap-form';

const TYPE_ICONS: Record<FormNode['type'], string> = {
  group: 'group',
  columns: 'columns',
  tabs: 'layers',
  tab: 'doc',
  field: 'edit',
  part: 'table',
  related: 'link',
  button: 'bolt',
  link: 'external',
  text: 'text',
  spacer: 'minus',
};

function typeName(type: FormNode['type']): string {
  switch (type) {
    case 'group':
      return t('formDesigner', 'Group');
    case 'columns':
      return t('formDesigner', 'Columns');
    case 'tabs':
      return t('formDesigner', 'Tabs');
    case 'tab':
      return t('formDesigner', 'Tab');
    case 'field':
      return t('formDesigner', 'Field');
    case 'part':
      return t('formDesigner', 'Part');
    case 'related':
      return t('formDesigner', 'Related list');
    case 'button':
      return t('formDesigner', 'Button');
    case 'link':
      return t('formDesigner', 'Link');
    case 'text':
      return t('formDesigner', 'Text');
    case 'spacer':
      return t('formDesigner', 'Spacer');
  }
}

export class FormDesigner implements Page {
  id: string;
  title: string;
  icon = 'form';
  readonly el: HTMLElement;
  private selected: string | null = null;
  private dragging: DragItem | null = null;
  private dropMark: HTMLElement | null = null;
  /** The tab shown in each tabs element, kept across re-renders. */
  private shownTab = new Map<string, number>();
  private toolbar: HTMLElement;
  private outline: HTMLElement;
  private canvas: HTMLElement;
  private props: HTMLElement;

  constructor(
    private readonly shell: Shell,
    private readonly key: string,
  ) {
    this.id = `design:form:${key}`;
    this.title = t('formDesigner', 'Form');
    this.toolbar = h('div', { class: 'toolbar' });
    this.outline = h('div', { class: 'fd-outline', role: 'tree' });
    this.canvas = h('div', { class: 'canvas fd-canvas' });
    this.props = h('div', { class: 'props' });
    this.el = h('div', { class: 'page form-designer' }, this.toolbar, h('div', { class: 'designer' }, this.outline, h('div', { class: 'designer-main' }, this.canvas), this.props));
    this.canvas.addEventListener('click', (e) => this.canvasClick(e));
    this.canvas.addEventListener('mouseover', (e) => this.hover((e.target as HTMLElement).closest<HTMLElement>('.d-node')));
    this.canvas.addEventListener('mouseleave', () => this.hover(null));
    this.dropZone(this.canvas, '.d-node', true);
    this.dropZone(this.outline, '.tree-item[data-key]', false);
    this.render();
  }

  private form(): FormDef | undefined {
    return this.shell.session.config.forms.find((f) => f.key === this.key);
  }

  private tb(form = this.form()): TableDef | undefined {
    return form ? tableOf(this.shell.session.config, form.table) : undefined;
  }

  configChanged(): void {
    if (!this.form()) {
      this.shell.closePage(this.id);
      return;
    }
    this.render();
  }

  onKey(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.closest('.overlay, .popup'))) return false;
    const form = this.form();
    if (!form) return false;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const by = e.key === 'ArrowUp' ? -1 : 1;
      if (e.altKey) {
        if (this.selected) void this.change((f) => moveAmongSiblings(f.layout, this.selected!, by));
        return true;
      }
      const order = flatten(form.layout).map((x) => x.node.key);
      const at = this.selected ? order.indexOf(this.selected) : 0;
      const next = order[Math.max(0, Math.min(order.length - 1, at + by))];
      this.select(next === form.layout.key ? null : (next ?? null));
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      this.removeSelected();
      return true;
    }
    if (e.key === 'Escape' && this.selected) {
      this.select(null);
      return true;
    }
    return false;
  }

  /** Applies a change to this form; `fn` gets the form inside the draft configuration. */
  private change(fn: (form: FormDef, c: Config) => void): Promise<void> {
    return this.shell.session
      .change((c) => {
        const form = c.forms.find((f) => f.key === this.key);
        if (form) fn(form, c);
      })
      .then(() => undefined)
      .catch((e: unknown) => this.shell.fail(e));
  }

  private select(key: string | null): void {
    this.selected = key;
    this.render();
    const el = key ? this.canvas.querySelector<HTMLElement>(`.d-node[data-key="${CSS.escape(key)}"]`) : null;
    el?.scrollIntoView({ block: 'nearest' });
    (key ? this.outline.querySelector<HTMLElement>(`.tree-item[data-key="${CSS.escape(key)}"]`) : null)?.scrollIntoView({ block: 'nearest' });
  }

  private render(): void {
    const form = this.form();
    const tb = this.tb(form);
    if (!form) return;
    if (this.selected && (this.selected === form.layout.key || !findNode(form.layout, this.selected))) this.selected = null;
    this.title = `${t('formDesigner', 'Form')}: ${form.title ?? form.name}`;
    this.shell.updateTab(this);
    this.renderToolbar(form, tb);
    this.renderOutline(form, tb);
    this.renderCanvas(form, tb);
    this.renderProps(form, tb);
  }

  /* ------------------------------ toolbar ------------------------------ */

  private renderToolbar(form: FormDef, tb: TableDef | undefined): void {
    clear(
      this.toolbar,
      icon('form'),
      h('span', { class: 'page-title' }, form.title ?? form.name),
      h('span', { class: 'muted mono' }, form.name),
      tb ? h('span', { class: 'muted fd-table-of' }, icon(tb.icon ?? 'table', 14), tb.title) : h('span', { class: 'field-error' }, t('formDesigner', 'The table “{table}” does not exist', { table: form.table })),
      h('span', { class: 'spacer' }),
      button(t('formDesigner', 'Open a record with this form'), { icon: 'external', disabled: !tb, onClick: () => void this.openRecord() }),
      button(t('formDesigner', 'Reset to automatic'), { icon: 'refresh', disabled: !tb, onClick: () => void this.reset() }),
      button(t('formDesigner', 'Delete form'), { icon: 'trash', class: 'danger', onClick: () => void this.deleteForm() }),
    );
  }

  private async openRecord(): Promise<void> {
    const form = this.form();
    const tb = this.tb(form);
    if (!form || !tb) return;
    const first = this.shell.session.config.forms.find((f) => f.table === tb.name);
    if (first && first.key !== form.key) toast(t('formDesigner', 'Records of “{table}” open in the form “{form}”, which comes first', { table: tb.title, form: first.title ?? first.name }));
    try {
      const rows = await this.shell.data.all(tb.name);
      this.shell.openRecord(tb.name, rows.find((r) => !r.isFolder)?.id ?? null);
    } catch (error) {
      this.shell.fail(error);
    }
  }

  private async reset(): Promise<void> {
    const tb = this.tb();
    if (!tb) return;
    if (!(await confirm(t('formDesigner', 'Reset to automatic'), t('formDesigner', 'Replace the layout with the automatic one? The current arrangement is lost (Undo brings it back).'), t('formDesigner', 'Reset'), true))) return;
    this.selected = null;
    await this.change((f, c) => {
      const auto = tableOf(c, f.table);
      if (auto) f.layout = rekey(defaultForm(c, auto).layout);
    });
  }

  private async deleteForm(): Promise<void> {
    const form = this.form();
    if (!form) return;
    if (!(await confirm(t('formDesigner', 'Delete form'), t('formDesigner', 'Delete the form “{form}”? Records will open in the automatic form.', { form: form.title ?? form.name }), t('formDesigner', 'Delete'), true))) return;
    await this.shell.session
      .change((c) => {
        c.forms = c.forms.filter((f) => f.key !== this.key);
        for (const v of c.views) if (v.form === form.name) delete v.form;
      })
      .catch((e: unknown) => this.shell.fail(e));
    this.shell.closePage(this.id);
  }

  /* ------------------------------ outline ------------------------------ */

  private nodeLabel(node: FormNode, tb: TableDef | undefined): string {
    const config = this.shell.session.config;
    switch (node.type) {
      case 'group':
        return node.title || typeName('group');
      case 'tab':
        return node.title || typeName('tab');
      case 'field': {
        const f = tb ? fieldOf(tb, node.field) : undefined;
        return node.title ?? (f ? fieldTitle(f) : `?${node.field}`);
      }
      case 'part': {
        const p = (tb?.parts ?? []).find((x) => x.name === node.part);
        return node.title ?? p?.title ?? p?.name ?? `?${node.part}`;
      }
      case 'related':
        return node.title ?? tableOf(config, node.table)?.title ?? `?${node.table}`;
      case 'button':
      case 'link':
        return node.title ?? config.actions.find((a) => a.name === node.action)?.title ?? `?${node.action}`;
      case 'text':
        return node.text.length > 40 ? `${node.text.slice(0, 40)}…` : node.text || typeName('text');
      default:
        return typeName(node.type);
    }
  }

  private renderOutline(form: FormDef, tb: TableDef | undefined): void {
    const items = flatten(form.layout).map(({ node, depth }) => {
      const root = node === form.layout;
      const selected = root ? this.selected === null : node.key === this.selected;
      const item = h(
        'div',
        { class: `tree-item${selected ? ' selected' : ''}`, 'data-key': node.key, role: 'treeitem', 'aria-selected': String(selected), draggable: root ? null : 'true', title: typeName(node.type) },
        icon(root ? 'form' : TYPE_ICONS[node.type], 14),
        h('span', { class: 'label' }, root ? (form.title ?? form.name) : this.nodeLabel(node, tb)),
        node.type === 'field' ? h('span', { class: 'badge mono' }, node.field) : null,
      );
      item.style.setProperty('--depth', String(depth));
      item.addEventListener('click', () => this.select(root ? null : node.key));
      if (!root) this.dragSource(item, { kind: 'node', key: node.key });
      return item;
    });
    clear(this.outline, h('div', { class: 'fd-pane-title' }, t('formDesigner', 'Elements')), ...items);
  }

  /* ------------------------------ canvas ------------------------------ */

  private renderCanvas(form: FormDef, tb: TableDef | undefined): void {
    const scroll = this.canvas.scrollTop;
    if (!tb) {
      clear(this.canvas, h('div', { class: 'grid-empty' }, t('formDesigner', 'The table “{table}” does not exist', { table: form.table })));
      return;
    }
    const sheet = h(
      'div',
      { class: 'canvas-form', style: { ...(form.width ? { maxWidth: `${form.width}px` } : {}), ...(form.height ? { minHeight: `${form.height}px` } : {}) } },
      h('div', { class: 'fd-caption' }, h('h2', null, form.title ?? tb.itemTitle ?? tb.title), form.modal ? h('span', { class: 'badge-state' }, t('formDesigner', 'Dialog')) : null),
      renderLayout(form.layout, this.renderers(form, tb)),
    );
    clear(this.canvas, sheet);
    // Show the tabs that were shown, and the one holding the selection.
    for (const [key, index] of this.shownTab) this.showTab(key, index);
    const sel = this.selected ? sheet.querySelector<HTMLElement>(`.d-node[data-key="${CSS.escape(this.selected)}"]`) : null;
    for (let el = sel?.parentElement ?? null; el && el !== sheet; el = el.parentElement) {
      if (el.parentElement?.classList.contains('f-tab-body')) {
        const tabsNode = el.parentElement.closest<HTMLElement>('.d-node');
        if (tabsNode?.dataset.key) this.showTab(tabsNode.dataset.key, [...el.parentElement.children].indexOf(el));
      }
    }
    this.canvas.scrollTop = scroll;
  }

  /** Shows a tab the way the tab header does — not by clicking it, which would select it. */
  private showTab(tabsKey: string, index: number): void {
    const node = this.canvas.querySelector<HTMLElement>(`.d-node[data-key="${CSS.escape(tabsKey)}"]`);
    const bar = node?.querySelector(':scope > .f-tabs > .subtabs');
    const body = node?.querySelector(':scope > .f-tabs > .f-tab-body');
    if (!bar || !body || index >= bar.children.length) return;
    [...bar.children].forEach((b, k) => b.classList.toggle('active', k === index));
    [...body.children].filter((p) => p.classList.contains('d-node')).forEach((p, k) => p.classList.toggle('hidden', k !== index));
    this.shownTab.set(tabsKey, index);
  }

  private hovered: HTMLElement | null = null;

  private hover(el: HTMLElement | null): void {
    if (el === this.hovered) return;
    this.hovered?.classList.remove('fd-hover');
    this.hovered = el;
    el?.classList.add('fd-hover');
  }

  private canvasClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const tabButton = target.closest<HTMLElement>('.subtab');
    const node = target.closest<HTMLElement>('.d-node');
    const form = this.form();
    if (!form) return;
    if (tabButton && node?.dataset.key) {
      // A tab header selects that tab (and keeps it shown).
      const index = [...(tabButton.parentElement?.children ?? [])].indexOf(tabButton);
      this.shownTab.set(node.dataset.key, index);
      const tabs = findNode(form.layout, node.dataset.key);
      const tab = tabs && isContainer(tabs) ? tabs.children[index] : undefined;
      this.select(tab?.key ?? node.dataset.key);
      return;
    }
    if (!node || !this.canvas.contains(node)) return this.select(null);
    const key = node.dataset.key ?? null;
    this.select(key === form.layout.key ? null : key);
  }

  private renderers(form: FormDef, tb: TableDef): LayoutRenderers {
    const config = this.shell.session.config;
    return {
      field: (node) => {
        const f = fieldOf(tb, node.field);
        if (!f) return h('div', { class: 'f-text field-error' }, `?${node.field}`);
        const editor = editorFor(this.shell, f, null, () => {});
        editor.setReadonly(true);
        editor.el.querySelectorAll('input, select, textarea, button').forEach((x) => ((x as HTMLElement).tabIndex = -1));
        const title = node.title ?? fieldTitle(f);
        const label = node.label === 'none' ? null : h('label', null, title, f.required ? h('span', { class: 'req' }, '*') : null);
        return h('div', { class: `f-field${node.label === 'top' ? ' top' : ''}`, style: node.span ? { gridColumn: `span ${node.span}` } : {} }, label, h('div', null, editor.el));
      },
      part: (node) => {
        const p = (tb.parts ?? []).find((x) => x.name === node.part);
        return h(
          'div',
          { class: 'f-part fd-placeholder' },
          h('div', { class: 'fd-placeholder-head' }, icon('table', 14), h('strong', null, node.title ?? p?.title ?? p?.name ?? `?${node.part}`)),
          p ? h('div', { class: 'fd-placeholder-cols' }, ...p.fields.map((f) => h('span', null, fieldTitle(f)))) : h('div', { class: 'field-error' }, t('formDesigner', 'No part “{part}”', { part: node.part })),
        );
      },
      related: (node) => {
        const other = tableOf(config, node.table);
        const f = other ? fieldOf(other, node.field) : undefined;
        return h(
          'div',
          { class: 'f-part fd-placeholder' },
          h('div', { class: 'fd-placeholder-head' }, icon('link', 14), h('strong', null, node.title ?? other?.title ?? `?${node.table}`)),
          h('div', { class: 'muted' }, other && f ? t('formDesigner', 'Records of “{table}” whose “{field}” is this record', { table: other.title, field: fieldTitle(f) }) : t('formDesigner', 'No table “{table}” with the field “{field}”', { table: node.table, field: node.field })),
        );
      },
      action: (node) => {
        const a = config.actions.find((x) => x.name === node.action);
        if (node.type === 'link') return h('span', { class: 'f-link' }, node.title ?? a?.title ?? `?${node.action}`);
        return button(node.title ?? a?.title ?? `?${node.action}`, { icon: a?.icon ?? 'bolt', class: 'outline' });
      },
      wrap: (node, el) => this.wrap(form, node, el),
    };
  }

  /** Every node on the canvas sits in a frame that selects, drags and takes drops. */
  private wrap(form: FormDef, node: FormNode, el: HTMLElement): HTMLElement {
    const root = node === form.layout;
    const frame = h(
      'div',
      { class: `d-node fd-${node.type}${root ? ' d-root' : ''}${node.key === this.selected ? ' selected' : ''}`, 'data-key': node.key, draggable: root ? null : 'true' },
      root ? null : h('span', { class: 'd-label' }, typeName(node.type)),
      el,
    );
    // The span of a field in columns belongs to the frame, which is the grid item now.
    if (el.style.gridColumn) {
      frame.style.gridColumn = el.style.gridColumn;
      el.style.gridColumn = '';
    }
    if (isContainer(node) && !node.children.length) {
      const hint = h('div', { class: 'fd-empty' }, node.type === 'tabs' ? t('formDesigner', 'Drop a tab here') : t('formDesigner', 'Drop elements here'));
      (el.querySelector('.f-tab-body') ?? el).appendChild(hint);
    }
    if (!root) this.dragSource(frame, { kind: 'node', key: node.key });
    return frame;
  }

  /* ------------------------------ drag and drop ------------------------------ */

  private dragSource(el: HTMLElement, item: DragItem): void {
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.dragging = item;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = item.kind === 'node' ? 'move' : 'copy';
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
        e.dataTransfer.setData('text/plain', item.kind === 'node' ? item.key : item.kind === 'new' ? item.type : item.name);
      }
      el.classList.add('fd-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('fd-dragging');
      this.dragging = null;
      this.mark(null);
    });
  }

  /** The node the dragged item would make; null for an existing node. */
  private draggedNode(form: FormDef, item: DragItem): FormNode | null {
    if (item.kind === 'node') return findNode(form.layout, item.key) ?? null;
    if (item.kind === 'field') return { type: 'field', key: '', field: item.name };
    if (item.kind === 'part') return { type: 'part', key: '', part: item.name };
    return { type: item.type, key: '', children: [] } as unknown as FormNode;
  }

  /** Where a drop at the pointer would go: the innermost frame where the item fits. */
  private dropTarget(e: DragEvent, selector: string, canvas: boolean): { el: HTMLElement; key: string; place: Place } | null {
    const form = this.form();
    const item = this.dragging ?? readDrag(e);
    if (!form || !item) return null;
    const dragged = this.draggedNode(form, item);
    if (!dragged) return null;
    const ok = (key: string, place: Place) => {
      if (item.kind === 'node') {
        if (key === item.key) return false;
        const self = findNode(form.layout, item.key);
        if (!self || findNode(self, key)) return false;
      }
      return canPlace(form.layout, dragged, key, place);
    };
    const start = (e.target as HTMLElement).closest<HTMLElement>(selector);
    for (let el = start; el; el = el.parentElement?.closest<HTMLElement>(selector) ?? null) {
      if (canvas && !this.canvas.contains(el)) break;
      const key = el.dataset.key;
      if (!key) continue;
      const node = findNode(form.layout, key);
      if (!node) continue;
      if (node === form.layout) return ok(key, 'into') ? { el, key, place: 'into' } : null;
      const parent = findParent(form.layout, key)?.parent;
      const horizontal = canvas && parent?.type === 'columns';
      const r = el.getBoundingClientRect();
      const rtl = getComputedStyle(el).direction === 'rtl';
      const pos = horizontal ? (rtl ? r.right - e.clientX : e.clientX - r.left) : e.clientY - r.top;
      const size = horizontal ? r.width : r.height;
      const edge = isContainer(node) ? Math.min(14, size / 4) : size / 2;
      const candidates: Place[] = isContainer(node) ? (pos < edge ? ['before', 'into'] : pos > size - edge ? ['after', 'into'] : ['into', pos < size / 2 ? 'before' : 'after']) : [pos < size / 2 ? 'before' : 'after'];
      for (const place of candidates) if (ok(key, place)) return { el, key, place };
    }
    return null;
  }

  private mark(target: { el: HTMLElement; place: Place } | null): void {
    if (this.dropMark) this.dropMark.classList.remove('drop-before', 'drop-after', 'drop-into');
    this.dropMark = target?.el ?? null;
    if (target) target.el.classList.add(`drop-${target.place}`);
  }

  private dropZone(zone: HTMLElement, selector: string, canvas: boolean): void {
    zone.addEventListener('dragover', (e) => {
      const target = this.dropTarget(e, selector, canvas);
      this.mark(target);
      if (!target) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = this.dragging?.kind === 'node' ? 'move' : 'copy';
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget as Node | null)) this.mark(null);
    });
    zone.addEventListener('drop', (e) => {
      const target = this.dropTarget(e, selector, canvas);
      const item = this.dragging ?? readDrag(e);
      this.mark(null);
      this.dragging = null;
      if (!target || !item) return;
      e.preventDefault();
      void this.place(item, target.key, target.place);
    });
  }

  /** Puts the dragged or added item at the place; a new element becomes the selection. */
  private async place(item: DragItem, targetKey: string, place: Place): Promise<void> {
    const form = this.form();
    const tb = this.tb(form);
    if (!form || !tb) return;
    if (item.kind === 'node') {
      await this.change((f) => moveNode(f.layout, item.key, targetKey, place));
      this.select(item.key);
      return;
    }
    const node = this.makeNode(item, tb);
    if (!node) return;
    let placed = false;
    await this.change((f) => (placed = insertNode(f.layout, node, targetKey, place)));
    if (placed) this.select(node.key);
  }

  private makeNode(item: DragItem, tb: TableDef): FormNode | null {
    const config = this.shell.session.config;
    const key = newKey('e');
    if (item.kind === 'field') return { type: 'field', key, field: item.name, ...(fieldOf(tb, item.name)?.type === 'text' ? { label: 'top' as const } : {}) };
    if (item.kind === 'part') return { type: 'part', key, part: item.name };
    if (item.kind !== 'new') return null;
    switch (item.type) {
      case 'group':
        return { type: 'group', key, title: t('formDesigner', 'New group'), children: [] };
      case 'columns':
        return { type: 'columns', key, children: [{ type: 'group', key: newKey('e'), children: [] }, { type: 'group', key: newKey('e'), children: [] }] };
      case 'tabs':
        return { type: 'tabs', key, children: [{ type: 'tab', key: newKey('e'), title: t('formDesigner', 'New tab'), children: [] }] };
      case 'tab':
        return { type: 'tab', key, title: t('formDesigner', 'New tab'), children: [] };
      case 'text':
        return { type: 'text', key, text: t('formDesigner', 'Text') };
      case 'spacer':
        return { type: 'spacer', key };
      case 'button':
      case 'link': {
        const action = this.actionsFor(tb)[0];
        return action ? { type: item.type, key, action: action.name } : null;
      }
      case 'part': {
        const form = this.form();
        const placed = new Set(form ? flatten(form.layout).flatMap(({ node }) => (node.type === 'part' ? [node.part] : [])) : []);
        const p = (tb.parts ?? []).find((x) => !placed.has(x.name)) ?? tb.parts?.[0];
        return p ? { type: 'part', key, part: p.name } : null;
      }
      case 'related': {
        const ref = backReferences(config, tb)[0];
        return ref ? { type: 'related', key, table: ref.table.name, field: ref.field.name } : null;
      }
    }
  }

  private actionsFor(tb: TableDef) {
    return this.shell.session.config.actions.filter((a) => !a.table || a.table === tb.name);
  }

  /**
   * Adds an item by click: into the selected container when it takes it,
   * otherwise after the selection (or after its nearest ancestor that can
   * hold it), at the end of the form when nothing is selected. A tab with
   * no tabs to go to comes wrapped in new tabs.
   */
  private async add(item: DragItem): Promise<void> {
    const form = this.form();
    const tb = this.tb(form);
    if (!form || !tb) return;
    let node = this.makeNode(item, tb);
    if (!node) return;
    const root = form.layout;
    const tries: [string, Place][] = [];
    if (this.selected) {
      const sel = findNode(root, this.selected);
      if (sel && isContainer(sel)) tries.push([sel.key, 'into']);
      for (let key: string | undefined = this.selected; key && key !== root.key; key = findParent(root, key)?.parent.key) tries.push([key, 'after']);
    }
    tries.push([root.key, 'into']);
    let spot = tries.find(([key, place]) => canPlace(root, node!, key, place));
    if (!spot && node.type === 'tab') {
      node = { type: 'tabs', key: newKey('e'), children: [node] };
      spot = tries.find(([key, place]) => canPlace(root, node!, key, place));
    }
    if (!spot) return;
    const [key, place] = spot;
    const added = node;
    await this.change((f) => insertNode(f.layout, added, key, place));
    this.select(item.kind === 'new' && item.type === 'tab' && added.type === 'tabs' ? (added.children[0]?.key ?? added.key) : added.key);
  }

  private removeSelected(): void {
    const key = this.selected;
    const form = this.form();
    if (!key || !form) return;
    // The next selection: the following sibling, else the previous one, else the parent.
    const at = findParent(form.layout, key);
    const next = at ? (at.parent.children[at.index + 1] ?? at.parent.children[at.index - 1] ?? at.parent) : undefined;
    this.selected = next && next !== form.layout ? next.key : null;
    void this.change((f) => removeNode(f.layout, key));
  }

  /* ------------------------------ properties ------------------------------ */

  private renderProps(form: FormDef, tb: TableDef | undefined): void {
    const scroll = this.props.scrollTop;
    const node = this.selected ? findNode(form.layout, this.selected) : undefined;
    clear(this.props, node && tb ? this.nodeProps(form, tb, node) : this.formProps(form), tb ? this.hiddenList(form, tb) : null, tb ? this.palette(tb) : null);
    this.props.scrollTop = scroll;
  }

  private formProps(form: FormDef): HTMLElement {
    const set = (fn: (f: FormDef) => void) => void this.change(fn);
    return section(
      t('formDesigner', 'Form'),
      textProp(t('formDesigner', 'Title'), form.title, (v) => set((f) => (v ? (f.title = v) : delete f.title))),
      textProp(t('formDesigner', 'Name'), form.name, (v) => {
        if (!IDENT.test(v)) return toast(t('formDesigner', 'The name must be a Latin identifier'), 'error');
        if (this.shell.session.config.forms.some((f) => f.name === v && f.key !== form.key)) return toast(t('formDesigner', 'There is already a form named “{name}”', { name: v }), 'error');
        const old = form.name;
        void this.shell.session
          .change((c) => {
            const f = c.forms.find((x) => x.key === this.key);
            if (f) f.name = v;
            for (const view of c.views) if (view.form === old) view.form = v;
          })
          .catch((e: unknown) => this.shell.fail(e));
      }, { mono: true }),
      h('div', { class: 'prop' }, h('label', null, t('formDesigner', 'Table')), h('span', { class: 'mono' }, form.table)),
      numberProp(t('formDesigner', 'Width, px'), form.width, (v) => set((f) => (v ? (f.width = Math.max(200, Math.round(v))) : delete f.width))),
      numberProp(t('formDesigner', 'Height, px'), form.height, (v) => set((f) => (v ? (f.height = Math.max(100, Math.round(v))) : delete f.height))),
      checkProp(t('formDesigner', 'Dialog'), form.modal, (v) => set((f) => (v ? (f.modal = true) : delete f.modal)), t('formDesigner', 'Opens in a modal window rather than a tab')),
      selectProp(t('formDesigner', 'Cursor in'), form.focus ?? '', allFields(this.tb(form) ?? { key: '', name: '', kind: 'table', title: '', fields: [] }).filter((f) => !f.computed && f.readonly !== true).map((f) => [f.name, fieldTitle(f)] as [string, string]), (v) => set((f) => (v ? (f.focus = v) : delete f.focus)), true),
      checkProp(t('formDesigner', 'Enter saves'), form.enterSaves, (v) => set((f) => (v ? (f.enterSaves = true) : delete f.enterSaves)), t('formDesigner', 'Enter goes to the next field, and in the last one saves and closes: for quick entry')),
      h('p', { class: 'muted fd-tip' }, t('formDesigner', 'Click an element to change it. Drag elements to move them; arrows select, Alt+arrows move, Delete hides.')),
    );
  }

  private nodeProps(form: FormDef, tb: TableDef, node: FormNode): HTMLElement {
    const config = this.shell.session.config;
    /** Changes the node, found by its key in the draft. */
    const set = <N extends FormNode>(fn: (n: N) => void) =>
      void this.change((f) => {
        const n = findNode(f.layout, node.key);
        if (n && n.type === node.type) fn(n as N);
      });
    const at = findParent(form.layout, node.key);
    const tools = h(
      'div',
      { class: 'fd-node-tools' },
      h('span', { class: 'fd-node-type' }, icon(TYPE_ICONS[node.type], 14), typeName(node.type)),
      h('span', { class: 'spacer' }),
      button(null, { icon: 'arrowUp', title: t('formDesigner', 'Move up (Alt+↑)'), disabled: !at || at.index === 0, onClick: () => void this.change((f) => moveAmongSiblings(f.layout, node.key, -1)) }),
      button(null, { icon: 'arrowDown', title: t('formDesigner', 'Move down (Alt+↓)'), disabled: !at || at.index === at.parent.children.length - 1, onClick: () => void this.change((f) => moveAmongSiblings(f.layout, node.key, 1)) }),
      button(null, { icon: 'trash', title: t('formDesigner', 'Remove from the form (Delete)'), onClick: () => this.removeSelected() }),
    );
    const body: (HTMLElement | null)[] = [];
    switch (node.type) {
      case 'field': {
        const f = fieldOf(tb, node.field);
        const options = allFields(tb).map((x) => [x.name, `${fieldTitle(x)} (${x.name})`] as [string, string]);
        if (!f) options.unshift([node.field, `?${node.field}`]);
        body.push(
          selectProp(t('formDesigner', 'Field'), node.field, options, (v) => set<typeof node>((n) => (n.field = v))),
          textProp(t('formDesigner', 'Title'), node.title, (v) => set<typeof node>((n) => (v ? (n.title = v) : delete n.title)), { placeholder: f ? fieldTitle(f) : '' }),
          selectProp(t('formDesigner', 'Label'), node.label ?? 'left', [['left', t('formDesigner', 'On the left')], ['top', t('formDesigner', 'On top')], ['none', t('formDesigner', 'None')]], (v) => set<typeof node>((n) => (v === 'left' ? delete n.label : (n.label = v)))),
          numberProp(t('formDesigner', 'Span (1–12)'), node.span, (v) => set<typeof node>((n) => (v ? (n.span = Math.max(1, Math.min(12, Math.round(v)))) : delete n.span))),
          f ? h('div', { class: 'prop' }, h('span'), button(t('formDesigner', 'Field properties…'), { icon: 'wrench', class: 'outline', onClick: () => this.shell.designTable(tb.name, f.name) })) : null,
        );
        break;
      }
      case 'group':
        body.push(
          textProp(t('formDesigner', 'Title'), node.title, (v) => set<typeof node>((n) => (v ? (n.title = v) : delete n.title)), { hint: t('formDesigner', 'A group with a title is drawn in a frame') }),
          checkProp(t('formDesigner', 'Collapsed'), node.collapsed, (v) => set<typeof node>((n) => (v ? (n.collapsed = true) : delete n.collapsed))),
        );
        break;
      case 'tab':
        body.push(textProp(t('formDesigner', 'Title'), node.title, (v) => set<typeof node>((n) => (n.title = v || typeName('tab')))));
        break;
      case 'tabs':
        body.push(button(t('formDesigner', 'Add a tab'), { icon: 'plus', class: 'outline fd-wide', onClick: () => void this.add({ kind: 'new', type: 'tab' }) }));
        break;
      case 'columns':
        body.push(
          h('p', { class: 'muted fd-tip' }, t('formDesigner', 'Each element inside is a column; put groups in it to stack fields in a column.')),
          button(t('formDesigner', 'Add a column'), { icon: 'plus', class: 'outline fd-wide', onClick: () => void this.add({ kind: 'new', type: 'group' }) }),
        );
        break;
      case 'text':
        body.push(textProp(t('formDesigner', 'Text'), node.text, (v) => set<typeof node>((n) => (n.text = v)), { multiline: true }));
        break;
      case 'button':
      case 'link': {
        const actions = this.actionsFor(tb).map((a) => [a.name, a.title] as [string, string]);
        if (!actions.some(([name]) => name === node.action)) actions.unshift([node.action, `?${node.action}`]);
        body.push(
          selectProp(t('formDesigner', 'Action'), node.action, actions, (v) => set<typeof node>((n) => (n.action = v))),
          textProp(t('formDesigner', 'Title'), node.title, (v) => set<typeof node>((n) => (v ? (n.title = v) : delete n.title)), { placeholder: config.actions.find((a) => a.name === node.action)?.title ?? '' }),
        );
        break;
      }
      case 'part': {
        const parts = (tb.parts ?? []).map((p) => [p.name, p.title ?? p.name] as [string, string]);
        if (!parts.some(([name]) => name === node.part)) parts.unshift([node.part, `?${node.part}`]);
        body.push(
          selectProp(t('formDesigner', 'Part'), node.part, parts, (v) => set<typeof node>((n) => (n.part = v))),
          textProp(t('formDesigner', 'Title'), node.title, (v) => set<typeof node>((n) => (v ? (n.title = v) : delete n.title))),
        );
        break;
      }
      case 'related': {
        const refs = backReferences(config, tb);
        const tables = [...new Map(refs.map((r) => [r.table.name, r.table.title])).entries()];
        if (!tables.some(([name]) => name === node.table)) tables.unshift([node.table, `?${node.table}`]);
        const fields = refs.filter((r) => r.table.name === node.table).map((r) => [r.field.name, fieldTitle(r.field)] as [string, string]);
        if (!fields.some(([name]) => name === node.field)) fields.unshift([node.field, `?${node.field}`]);
        body.push(
          selectProp(t('formDesigner', 'Table'), node.table, tables, (v) =>
            set<typeof node>((n) => {
              n.table = v;
              n.field = refs.find((r) => r.table.name === v)?.field.name ?? n.field;
            }),
          ),
          selectProp(t('formDesigner', 'Linked by'), node.field, fields, (v) => set<typeof node>((n) => (n.field = v))),
          textProp(t('formDesigner', 'Title'), node.title, (v) => set<typeof node>((n) => (v ? (n.title = v) : delete n.title))),
        );
        break;
      }
      case 'spacer':
        body.push(h('p', { class: 'muted fd-tip' }, t('formDesigner', 'Empty space between elements.')));
        break;
    }
    return section(this.nodeLabel(node, tb), tools, ...body);
  }

  /** The fields (and parts) of the table that are not on the form. */
  private hiddenList(form: FormDef, tb: TableDef): HTMLElement {
    const placed = new Set(formFields(form.layout));
    const placedParts = new Set(flatten(form.layout).flatMap(({ node }) => (node.type === 'part' ? [node.part] : [])));
    const chip = (title: string, hint: string, item: DragItem, iconName: string) => {
      const el = h(
        'span',
        { class: 'chip fd-chip', draggable: 'true', title: hint, 'data-item': item.kind === 'node' || item.kind === 'new' ? '' : item.name },
        icon(iconName, 12),
        h('span', null, title),
        h('button', { type: 'button', class: 'fd-chip-add', title: t('formDesigner', 'Add to the form'), 'aria-label': t('formDesigner', 'Add to the form'), onclick: () => void this.add(item) }, icon('plus', 12)),
      );
      this.dragSource(el, item);
      return el;
    };
    const chips = [
      ...allFields(tb)
        .filter((f) => !placed.has(f.name))
        .map((f) => chip(fieldTitle(f), f.name, { kind: 'field', name: f.name }, 'edit')),
      ...(tb.parts ?? []).filter((p) => !placedParts.has(p.name)).map((p) => chip(p.title ?? p.name, p.name, { kind: 'part', name: p.name }, 'table')),
    ];
    return section(t('formDesigner', 'Hidden fields'), h('div', { class: 'chip-list fd-hidden' }, chips.length ? chips : h('span', { class: 'muted' }, t('formDesigner', 'Every field is on the form'))));
  }

  private palette(tb: TableDef): HTMLElement {
    const config = this.shell.session.config;
    const items: [NewType, string, boolean][] = [
      ['group', typeName('group'), true],
      ['columns', typeName('columns'), true],
      ['tabs', typeName('tabs'), true],
      ['tab', typeName('tab'), true],
      ['text', typeName('text'), true],
      ['spacer', typeName('spacer'), true],
      ['button', typeName('button'), this.actionsFor(tb).length > 0],
      ['link', typeName('link'), this.actionsFor(tb).length > 0],
      ['part', typeName('part'), (tb.parts ?? []).length > 0],
      ['related', typeName('related'), backReferences(config, tb).length > 0],
    ];
    return section(
      t('formDesigner', 'New element'),
      h(
        'div',
        { class: 'palette-items' },
        ...items.map(([type, title, enabled]) => {
          const b = button(title, { icon: TYPE_ICONS[type], disabled: !enabled, title: t('formDesigner', 'Click to add, or drag onto the form'), onClick: () => void this.add({ kind: 'new', type }) });
          b.dataset.new = type;
          if (enabled) {
            b.draggable = true;
            this.dragSource(b, { kind: 'new', type });
          }
          return b;
        }),
      ),
    );
  }
}

function readDrag(e: DragEvent): DragItem | null {
  try {
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    return raw ? (JSON.parse(raw) as DragItem) : null;
  } catch {
    return null;
  }
}
