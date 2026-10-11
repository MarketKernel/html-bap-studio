/**
 * The menu designer (Task.md 9.4): the application's navigation as an
 * outline — sections and the items in them — rearranged by dragging, with
 * what each item opens, its icon, and whether it is hidden; plus the start
 * dashboard.
 *
 * A configuration without a menu gets one built from its tables and reports
 * (model.defaultMenu); it is shown here as it is, and "Make editable" stores a
 * copy, after which the menu is the configuration's own.
 */
import { t } from '../../core/i18n';
import { defaultMenu, menuOf, newKey, viewFor, constantsTable, normalizeHotkey } from '../../core/config/model';
import type { Config, MenuNode, MenuTarget } from '../../core/config/types';
import { button, clear, h, icon } from '../dom';
import { confirm } from '../ui';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { checkProp, iconProp, section, selectProp, textProp } from './props';

type Kind = MenuTarget['kind'];
type Drop = 'before' | 'after' | 'into';

function kindTitle(kind: Kind): string {
  switch (kind) {
    case 'view':
      return t('menuDesigner', 'View');
    case 'table':
      return t('menuDesigner', 'Table');
    case 'report':
      return t('menuDesigner', 'Report');
    case 'dashboard':
      return t('menuDesigner', 'Dashboard');
    case 'action':
      return t('menuDesigner', 'Action');
  }
}

function kindIcon(kind: Kind | undefined): string {
  return kind === 'report' ? 'chart' : kind === 'dashboard' ? 'dashboard' : kind === 'action' ? 'bolt' : kind === 'view' ? 'columns' : 'table';
}

/** What a target of each kind may name: [name, title]. */
function targetsOf(config: Config, kind: Kind): [string, string][] {
  switch (kind) {
    case 'view':
      return config.views.map((v) => [v.name, v.title]);
    case 'table': {
      const constants = constantsTable(config);
      return [...config.tables.map((tb): [string, string] => [tb.name, tb.title]), ...(constants ? [[constants.name, constants.title] as [string, string]] : [])];
    }
    case 'report':
      return config.reports.map((r) => [r.name, r.title]);
    case 'dashboard':
      return config.dashboards.map((d) => [d.name, d.title]);
    case 'action':
      return config.actions.map((a) => [a.name, a.title]);
  }
}

function targetExists(config: Config, target: MenuTarget): boolean {
  if (target.kind === 'view' || target.kind === 'table') return !!viewFor(config, target.name);
  return targetsOf(config, target.kind).some(([name]) => name === target.name);
}

function locate(nodes: MenuNode[], key: string): { list: MenuNode[]; index: number; node: MenuNode } | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.key === key) return { list: nodes, index: i, node };
    if (node.children) {
      const found = locate(node.children, key);
      if (found) return found;
    }
  }
  return null;
}

function contains(node: MenuNode, key: string): boolean {
  return node.key === key || (node.children ?? []).some((c) => contains(c, key));
}

export class MenuDesigner implements Page {
  readonly id = 'design:menu';
  title = t('menuDesigner', 'Menu');
  icon = 'menu';
  readonly el: HTMLElement;
  private selected: string | null = null;
  private collapsed = new Set<string>();
  private dragKey: string | null = null;
  private toolbar: HTMLElement;
  private main: HTMLElement;
  private props: HTMLElement;

  constructor(private readonly shell: Shell) {
    this.toolbar = h('div', { class: 'toolbar' });
    this.main = h('div', { class: 'md-main' });
    this.props = h('div', { class: 'props' });
    this.el = h('div', { class: 'page' }, this.toolbar, h('div', { class: 'designer' }, h('div', { class: 'designer-main' }, this.main), this.props));
    this.render();
  }

  configChanged(): void {
    this.render();
  }

  private editable(): boolean {
    return this.shell.session.config.menu.length > 0;
  }

  private change(fn: (c: Config) => void): Promise<void> {
    return this.shell.session
      .change(fn)
      .then(() => undefined)
      .catch((e: unknown) => this.shell.fail(e));
  }

  onKey(e: KeyboardEvent): boolean {
    if (!this.selected || !this.editable() || (e.target as HTMLElement).closest('input, textarea, select')) return false;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      void this.moveBy(e.key === 'ArrowUp' ? -1 : 1);
      return true;
    }
    if (e.key === 'Delete') {
      void this.remove();
      return true;
    }
    return false;
  }

  private render(): void {
    const config = this.shell.session.config;
    const editable = this.editable();
    const nodes = menuOf(config);
    if (this.selected && !locate(nodes, this.selected)) this.selected = null;
    const sel = this.selected ? locate(nodes, this.selected) : null;
    clear(
      this.toolbar,
      icon('menu'),
      h('span', { class: 'page-title' }, t('menuDesigner', 'Navigation menu')),
      h('span', { class: 'spacer' }),
      editable
        ? [
            button(t('menuDesigner', 'Section'), { icon: 'plus', title: t('menuDesigner', 'Add a section'), onClick: () => void this.add(true) }),
            button(t('menuDesigner', 'Item'), { icon: 'plus', class: 'primary', title: t('menuDesigner', 'Add an item'), onClick: () => void this.add(false) }),
            h('span', { class: 'sep' }),
            button(null, { icon: 'arrowUp', title: t('menuDesigner', 'Move up (Alt+↑)'), disabled: !sel || sel.index === 0, onClick: () => void this.moveBy(-1) }),
            button(null, { icon: 'arrowDown', title: t('menuDesigner', 'Move down (Alt+↓)'), disabled: !sel || sel.index >= sel.list.length - 1, onClick: () => void this.moveBy(1) }),
            button(sel?.node.hidden ? t('menuDesigner', 'Show') : t('menuDesigner', 'Hide'), { icon: sel?.node.hidden ? 'eye' : 'eyeOff', disabled: !sel, onClick: () => sel && this.setNode(sel.node.key, (n) => (n.hidden ? delete n.hidden : (n.hidden = true))) }),
            button(t('menuDesigner', 'Delete'), { icon: 'trash', class: 'danger', disabled: !sel, onClick: () => void this.remove() }),
            h('span', { class: 'sep' }),
            button(t('menuDesigner', 'Reset to automatic'), { icon: 'undo', onClick: () => void this.reset() }),
          ]
        : button(t('menuDesigner', 'Make editable'), { icon: 'edit', class: 'primary', onClick: () => void this.change((c) => (c.menu = structuredClone(defaultMenu(c)))) }),
    );
    const tree = h('div', { class: `md-tree${editable ? '' : ' md-readonly'}`, role: 'tree' });
    this.renderNodes(tree, nodes, 0, config, editable);
    if (editable) this.wireRootDrop(tree);
    clear(
      this.main,
      editable
        ? h('p', { class: 'muted md-hint' }, t('menuDesigner', 'Drag items to reorder them, or onto a section to put them inside. Hidden items stay in the configuration but are not shown.'))
        : h('div', { class: 'info-bar md-auto' }, icon('info'), t('menuDesigner', 'This menu is built automatically from the tables and reports, and follows them as they change. Make it editable to arrange it yourself.')),
      tree,
      nodes.length ? null : h('div', { class: 'grid-empty' }, t('menuDesigner', 'The menu is empty. Add a section or an item.')),
    );
    clear(this.props, sel ? this.nodeProps(sel.node, config, editable) : null, this.appProps(config));
  }

  private renderNodes(host: HTMLElement, nodes: MenuNode[], depth: number, config: Config, editable: boolean): void {
    for (const node of nodes) {
      const isSection = !!node.children;
      const closed = this.collapsed.has(node.key);
      const broken = node.target && !targetExists(config, node.target);
      const twisty = h('span', { class: 'twisty' }, isSection ? icon(closed ? 'chevronRight' : 'chevronDown', 12) : null);
      if (isSection) {
        twisty.addEventListener('click', (e) => {
          e.stopPropagation();
          if (closed) this.collapsed.delete(node.key);
          else this.collapsed.add(node.key);
          this.render();
        });
      }
      const row = h(
        'div',
        {
          class: `md-node${isSection ? ' section' : ''}${node.key === this.selected ? ' selected' : ''}${node.hidden ? ' md-off' : ''}`,
          role: 'treeitem',
          tabindex: 0,
          draggable: editable ? 'true' : null,
          'data-menu': node.key,
        },
        editable ? h('span', { class: 'md-grip' }, icon('grip', 14)) : null,
        twisty,
        icon(node.icon ?? (isSection ? 'folder' : kindIcon(node.target?.kind))),
        h('span', { class: 'label' }, node.title),
        node.target ? h('span', { class: `md-target mono${broken ? ' broken' : ''}`, title: broken ? t('menuDesigner', 'Nothing with this name exists') : '' }, broken ? icon('warning', 12) : null, `${kindTitle(node.target.kind).toLocaleLowerCase()} ${node.target.name}`) : null,
        isSection ? h('span', { class: 'md-count muted' }, String(node.children!.length)) : null,
        node.hidden ? h('span', { class: 'md-hidden', title: t('menuDesigner', 'Hidden') }, icon('eyeOff', 13)) : null,
      );
      // A custom property cannot be set through Object.assign on a style.
      row.style.setProperty('--depth', String(depth));
      row.addEventListener('click', () => {
        this.selected = node.key;
        this.render();
        this.main.querySelector<HTMLElement>(`[data-menu="${CSS.escape(node.key)}"]`)?.focus();
      });
      if (editable) this.wireDrag(row, node);
      host.appendChild(row);
      if (isSection && !closed) this.renderNodes(host, node.children!, depth + 1, config, editable);
    }
  }

  /* ------------------------------ drag and drop ------------------------------ */

  private wireDrag(row: HTMLElement, node: MenuNode): void {
    const isSection = !!node.children;
    const clearMarks = () => this.main.querySelectorAll('.md-drop-before, .md-drop-after, .md-drop-into').forEach((el) => el.classList.remove('md-drop-before', 'md-drop-after', 'md-drop-into'));
    const where = (e: DragEvent): Drop => {
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      // An open section's lower edge is where its first child goes, so only a closed one takes "after".
      if (isSection) return y < 0.25 ? 'before' : y > 0.75 && this.collapsed.has(node.key) ? 'after' : 'into';
      return y < 0.5 ? 'before' : 'after';
    };
    row.addEventListener('dragstart', (e) => {
      this.dragKey = node.key;
      e.dataTransfer?.setData('text/plain', node.key);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      this.dragKey = null;
      row.classList.remove('dragging');
      clearMarks();
    });
    row.addEventListener('dragover', (e) => {
      const dragged = this.dragKey ? locate(this.shell.session.config.menu, this.dragKey)?.node : null;
      if (!dragged || contains(dragged, node.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clearMarks();
      row.classList.add(`md-drop-${where(e)}`);
    });
    row.addEventListener('dragleave', () => row.classList.remove('md-drop-before', 'md-drop-after', 'md-drop-into'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearMarks();
      const key = this.dragKey;
      this.dragKey = null;
      if (key) void this.move(key, node.key, where(e));
    });
  }

  /** Dropping below the last row puts the node at the end of the top level. */
  private wireRootDrop(tree: HTMLElement): void {
    tree.addEventListener('dragover', (e) => {
      if (!this.dragKey) return;
      e.preventDefault();
      tree.classList.add('md-drop-end');
    });
    tree.addEventListener('dragleave', (e) => {
      if (e.target === tree) tree.classList.remove('md-drop-end');
    });
    tree.addEventListener('drop', (e) => {
      e.preventDefault();
      tree.classList.remove('md-drop-end');
      const key = this.dragKey;
      this.dragKey = null;
      if (!key) return;
      void this.change((c) => {
        const from = locate(c.menu, key);
        if (!from) return;
        from.list.splice(from.index, 1);
        c.menu.push(from.node);
      });
    });
  }

  /** Moves a node before or after another, or into a section (at its end). */
  private move(key: string, targetKey: string, drop: Drop): Promise<void> {
    if (key === targetKey) return Promise.resolve();
    this.selected = key;
    return this.change((c) => {
      const from = locate(c.menu, key);
      if (!from || contains(from.node, targetKey)) return;
      from.list.splice(from.index, 1);
      const to = locate(c.menu, targetKey);
      if (!to) {
        from.list.splice(from.index, 0, from.node);
        return;
      }
      if (drop === 'into') {
        (to.node.children ??= []).push(from.node);
        this.collapsed.delete(to.node.key);
      } else to.list.splice(to.index + (drop === 'after' ? 1 : 0), 0, from.node);
    });
  }

  /* ------------------------------ editing ------------------------------ */

  private setNode(key: string, fn: (n: MenuNode) => void): void {
    void this.change((c) => {
      const found = locate(c.menu, key);
      if (found) fn(found.node);
    });
  }

  private moveBy(by: number): Promise<void> {
    const key = this.selected;
    if (!key) return Promise.resolve();
    return this.change((c) => {
      const found = locate(c.menu, key);
      if (!found) return;
      const to = found.index + by;
      if (to < 0 || to >= found.list.length) return;
      found.list.splice(found.index, 1);
      found.list.splice(to, 0, found.node);
    });
  }

  private add(isSection: boolean): Promise<void> {
    const config = this.shell.session.config;
    let node: MenuNode;
    if (isSection) node = { key: newKey('m'), title: t('menuDesigner', 'New section'), children: [] };
    else {
      const kind: Kind = config.views.length ? 'view' : config.tables.length ? 'table' : config.reports.length ? 'report' : 'dashboard';
      const [name, title] = targetsOf(config, kind)[0] ?? ['', t('menuDesigner', 'New item')];
      node = { key: newKey('m'), title, icon: kindIcon(kind), target: { kind, name } as MenuTarget };
    }
    const after = this.selected;
    this.selected = node.key;
    return this.change((c) => {
      const at = after ? locate(c.menu, after) : null;
      if (isSection) {
        // Sections go to the top level, after the one holding the selection.
        const top = after ? c.menu.findIndex((n) => contains(n, after)) : -1;
        c.menu.splice(top < 0 ? c.menu.length : top + 1, 0, node);
      } else if (!at) c.menu.push(node);
      else if (at.node.children) {
        at.node.children.push(node);
        this.collapsed.delete(at.node.key);
      } else at.list.splice(at.index + 1, 0, node);
    });
  }

  private async remove(): Promise<void> {
    const key = this.selected;
    if (!key) return;
    const found = locate(this.shell.session.config.menu, key);
    if (!found) return;
    if (found.node.children?.length && !(await confirm(t('menuDesigner', 'Delete the section'), t('menuDesigner', 'Delete “{title}” with the {n} items in it?', { title: found.node.title, n: found.node.children.length }), t('menuDesigner', 'Delete'), true))) return;
    this.selected = found.list[found.index + 1]?.key ?? found.list[found.index - 1]?.key ?? null;
    await this.change((c) => {
      const at = locate(c.menu, key);
      at?.list.splice(at.index, 1);
    });
  }

  private async reset(): Promise<void> {
    if (!(await confirm(t('menuDesigner', 'Reset to automatic'), t('menuDesigner', 'Throw away this menu and show the tables and reports grouped by kind?'), t('menuDesigner', 'Reset'), true))) return;
    this.selected = null;
    await this.change((c) => (c.menu = []));
  }

  /* ------------------------------ properties ------------------------------ */

  private nodeProps(node: MenuNode, config: Config, editable: boolean): HTMLElement {
    const isSection = !!node.children;
    const set = (fn: (n: MenuNode) => void) => this.setNode(node.key, fn);
    const kind = node.target?.kind ?? 'view';
    const names = targetsOf(config, kind);
    if (node.target && !names.some(([n]) => n === node.target!.name)) names.unshift([node.target.name, `${node.target.name} ?`]);
    const box = section(
      isSection ? t('menuDesigner', 'Section') : t('menuDesigner', 'Item'),
      textProp(t('menuDesigner', 'Title'), node.title, (v) => set((n) => (n.title = v || n.title))),
      iconProp(t('menuDesigner', 'Icon'), node.icon, (v) => set((n) => (n.icon = v))),
      isSection
        ? null
        : selectProp<Kind>(t('menuDesigner', 'Opens'), kind, (['view', 'table', 'report', 'dashboard', 'action'] as Kind[]).map((k) => [k, kindTitle(k)]), (v) =>
            set((n) => {
              const config = this.shell.session.config;
              const before = n.target ? targetsOf(config, n.target.kind).find(([name]) => name === n.target!.name)?.[1] : undefined;
              const first = targetsOf(config, v)[0];
              n.target = { kind: v, name: first?.[0] ?? '' } as MenuTarget;
              if (first && (!n.title || n.title === before)) n.title = first[1];
              if (!n.icon || n.icon === kindIcon(kind)) n.icon = kindIcon(v);
            }),
          ),
      isSection
        ? null
        : selectProp(t('menuDesigner', 'Which'), node.target?.name, names, (v) =>
            set((n) => {
              const before = n.target ? targetsOf(this.shell.session.config, n.target.kind).find(([name]) => name === n.target!.name)?.[1] : undefined;
              n.target = { kind, name: v } as MenuTarget;
              // An item still called after what it opened follows the new choice.
              if (!n.title || n.title === before) n.title = names.find(([name]) => name === v)?.[1] ?? n.title;
            }),
          ),
      node.target ? textProp(t('menuDesigner', 'Shortcut'), node.hotkey, (v) => set((n) => (v ? (n.hotkey = normalizeHotkey(v) ?? v) : delete n.hotkey)), { mono: true, placeholder: 'R, Shift+N, Ctrl+Alt+R' }) : null,
      checkProp(t('menuDesigner', 'Hidden'), node.hidden, (v) => set((n) => (v ? (n.hidden = true) : delete n.hidden)), t('menuDesigner', 'Kept in the menu’s configuration, not shown in the application')),
      node.target ? h('div', { class: 'prop' }, h('span'), button(t('menuDesigner', 'Open it'), { icon: 'external', onClick: () => this.shell.openTarget(node.target!, { title: node.title }) })) : null,
    );
    if (!editable) box.querySelectorAll('input, select, textarea, button.btn.outline').forEach((el) => ((el as HTMLInputElement).disabled = true));
    return box;
  }

  private appProps(config: Config): HTMLElement {
    return section(
      t('menuDesigner', 'Application'),
      selectProp(t('menuDesigner', 'Start dashboard'), config.app.home ?? '', config.dashboards.map((d) => [d.name, d.title] as [string, string]), (v) => void this.change((c) => (v ? (c.app.home = v) : delete c.app.home)), true),
      h('p', { class: 'muted md-note' }, t('menuDesigner', 'Opened when the application starts. Without one, the first menu item opens.')),
    );
  }
}
