/**
 * The studio's frame (Task.md 8.1): the top bar with the command search and
 * the Application/Designer switch, the navigation tree, the tabs, the status
 * bar — and the start screen before any workspace is open.
 *
 * Everything a screen asks for — open a record, run an action, choose a
 * record — goes through here (App, app.ts).
 */
import { t, tn } from '../core/i18n';
import { CONSTANTS, CONSTANTS_ID, constantsTable, defaultView, formFor, menuOf, normalizeHotkey, table as tableOf, viewFor } from '../core/config/model';
import type { MenuNode, MenuTarget, TableDef } from '../core/config/types';
import { runAction, setTriggerUI, type ActionContext, type ActionUI } from '../core/actions';
import { ValidationError } from '../core/data';
import { PluginError } from '../core/plugin-protocol';
import type { Filter, Row } from '../core/query/types';
import { button, clear, h, icon, isMac, modKey } from './dom';
import { alertDialog, closeMenu, dialog, dialogOpen, popupMenu, toast, type MenuItem } from './ui';
import { applyTheme, designerShown, DISTRIBUTION, effectiveLanguage, ownWorkspaces, saveSettings, settings, type Workspace } from './settings';
import { saveHandles, Session } from './session';
import { PluginRegistry } from './plugins/host';
import { TEMPLATES, type Template } from './templates';
import { editorFor } from './fields';
import type { App, OpenOptions, Page } from './app';
import { ListPage } from './pages/list';
import { CardPage } from './pages/card';
import { ReportPage } from './pages/report';
import { DashboardPage } from './pages/dashboard';
import { printRecords } from './pages/print';
import { openDesigner, designerTree, type DesignerTarget } from './designer/index';
import { pluginManager } from './plugins/manager';
import { openSettings } from './pages/settings';
import { idb, persistStorage } from './storage';
import { applyUpdate, justUpdated, startUpdates, type UpdateState } from './update';
import { LANGUAGES, setLanguage, translatePage } from '../core/i18n';

const ICON = (document.querySelector('link[rel=icon]') as HTMLLinkElement | null)?.href ?? '';

export class Shell implements App {
  session!: Session;
  readonly registry = new PluginRegistry();
  private root: HTMLElement;
  private pages: Page[] = [];
  private active: Page | null = null;
  private tabsEl!: HTMLElement;
  private hostEl!: HTMLElement;
  private navEl!: HTMLElement;
  private navBody!: HTMLElement;
  private statusEl!: HTMLElement;
  private statusText!: HTMLElement;
  private navFilter = '';
  private selectedNav: string | null = null;
  private collapsedNav = new Set<string>();
  private update: UpdateState = { kind: 'idle' };

  constructor(root: HTMLElement) {
    this.root = root;
    document.addEventListener('keydown', (e) => this.key(e));
    addEventListener('beforeunload', (e) => {
      if (this.pages.some((p) => p.dirty?.()) || this.session?.dirty) e.preventDefault();
    });
  }

  get data() {
    return this.session.data;
  }

  async start(): Promise<void> {
    applyTheme();
    setLanguage(effectiveLanguage());
    translatePage();
    await this.registry.load();
    if (justUpdated()) toast(t('shell', 'Updated to {version}', { version: __APP_VERSION__ }), 'ok');
    startUpdates((state) => {
      this.update = state;
      this.renderStatus();
      if (state.kind === 'ready') toast(t('shell', 'Version {version} is ready', { version: state.version ?? '' }), 'info', { label: t('shell', 'Update'), run: () => void this.applyUpdate() }, 20000);
    });
    this.registry.onLog = (plugin, line) => {
      if (line.level !== 'error') return;
      this.status(`${plugin}: ${line.message}`);
      // A file that could not be written means data the person believes saved is not: say it aloud.
      if (plugin === 'json-file') toast(`${plugin}: ${line.message}`, 'error');
    };
    this.registry.onProgress = (fraction, text) => this.status(text ?? (fraction === null ? '' : `${Math.round(fraction * 100)}%`));
    const last = ownWorkspaces().find((w) => w.id === settings.lastWorkspace);
    if (last) {
      try {
        await this.openWorkspace(last);
        return;
      } catch (error) {
        toast(t('shell', 'Could not open “{name}”: {error}', { name: last.name, error: error instanceof Error ? error.message : String(error) }), 'error');
      }
    }
    this.renderStart();
  }

  /* ------------------------------ start screen ------------------------------ */

  renderStart(): void {
    // A distribution is one application: its own templates, its own databases, its name.
    const offered = DISTRIBUTION ? TEMPLATES.filter((tpl) => DISTRIBUTION!.templates.includes(tpl.id)) : TEMPLATES;
    const name = DISTRIBUTION ? (offered[0]?.config().app.name ?? 'BAP Studio') : 'BAP Studio';
    document.title = name;
    const tiles = offered.map((tpl) =>
      h('button', { type: 'button', class: 'tile', 'data-template': tpl.id, onclick: () => void this.create(tpl) }, h('div', { class: 'tile-icon' }, icon(tpl.icon, 22)), h('div', null, h('div', { class: 'tile-title' }, tpl.title), h('div', { class: 'tile-sub' }, tpl.description))),
    );
    const recent = ownWorkspaces().length
      ? h(
          'div',
          { class: 'recent' },
          ownWorkspaces().map((w) =>
            h(
              'div',
              { class: 'recent-item', 'data-workspace': w.id, onclick: () => void this.openWorkspace(w).catch((e: unknown) => this.fail(e, w.name)) },
              icon('database', 18),
              h('div', { class: 'grow' }, h('div', { style: { fontWeight: '600' } }, w.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${w.plugin}${w.settings.name ? ` · ${String(w.settings.name)}` : ''}${w.settings.url ? ` · ${String(w.settings.url)}` : ''}`)),
              button(null, {
                icon: 'trash',
                title: t('shell', 'Remove from the list'),
                onClick: (e) => {
                  e.stopPropagation();
                  settings.workspaces = settings.workspaces.filter((x) => x.id !== w.id);
                  saveSettings();
                  this.renderStart();
                },
              }),
            ),
          ),
        )
      : null;
    clear(
      this.root,
      h(
        'div',
        { class: 'start' },
        h(
          'div',
          { class: 'start-inner' },
          h('h1', null, h('img', { src: ICON, alt: '' }), name),
          h('p', { class: 'lead' }, DISTRIBUTION ? (offered[0]?.description ?? '') : t('shell', 'Build business applications — catalogs, documents, registers, forms, reports — and work in them right away. One file, offline, extensible with plugins.')),
          recent ? [h('h3', null, t('shell', 'Recent')), recent] : null,
          h('h3', null, t('shell', 'Create')),
          this.storageChoice(),
          h('div', { class: 'cards' }, tiles),
          h('h3', null, t('shell', 'Open')),
          h(
            'div',
            { class: 'cards' },
            fileAccess() ? h('button', { type: 'button', class: 'tile', 'data-open': 'file', onclick: () => void this.openFile() }, h('div', { class: 'tile-icon' }, icon('folderOpen', 22)), h('div', null, h('div', { class: 'tile-title' }, t('shell', 'Open a database file')), h('div', { class: 'tile-sub' }, t('shell', 'A .bap.json file: the application with all its data, made here or saved as a backup.')))) : null,
            DISTRIBUTION ? null : h('button', { type: 'button', class: 'tile', onclick: () => void this.connectDialog() }, h('div', { class: 'tile-icon' }, icon('plug', 22)), h('div', null, h('div', { class: 'tile-title' }, t('shell', 'Connect to a data source')), h('div', { class: 'tile-sub' }, t('shell', 'A server, a file or another browser database — through a data source plugin.')))),
            h('button', { type: 'button', class: 'tile', onclick: () => void pluginManager(this) }, h('div', { class: 'tile-icon' }, icon('puzzle', 22)), h('div', null, h('div', { class: 'tile-title' }, t('shell', 'Plugins')), h('div', { class: 'tile-sub' }, t('shell', 'Install data sources and actions from files or a plugins folder.')))),
          ),
          h('div', { class: 'start-foot' }, h('span', null, DISTRIBUTION ? `${name} · BAP Studio ${__APP_VERSION__}` : `BAP Studio ${__APP_VERSION__}`), h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), openSettings(this)) }, t('shell', 'Settings'))),
        ),
      ),
    );
  }

  private async create(tpl: Template): Promise<void> {
    const name = tpl.title;
    const id = `ws${Date.now().toString(36)}`;
    let workspace: Workspace = { id, name, plugin: 'local', source: 'local', settings: { name: id }, openedAt: new Date().toISOString(), template: tpl.id };
    if (this.storage === 'file') {
      const handle = await pickDatabaseFile(true, `${tpl.config().app.name}.bap.json`);
      if (!handle) return;
      await saveHandles(id, { file: handle });
      workspace = { id, name, plugin: 'json-file', source: 'file', settings: { path: handle.name }, openedAt: new Date().toISOString(), template: tpl.id };
    }
    const progress = h('div', { class: 'muted' }, t('shell', 'Creating…'));
    const overlay = h('div', { class: 'overlay' }, h('div', { class: 'dialog', style: { padding: '24px', minWidth: '320px' } }, h('div', { style: { fontWeight: '600', marginBottom: '8px' } }, name), progress));
    document.body.appendChild(overlay);
    try {
      const config = tpl.config();
      workspace.name = config.app.name;
      const session = await Session.create(this.registry, workspace, config);
      if (tpl.seed) await tpl.seed(session.data, (text) => (progress.textContent = text));
      persistStorage();
      overlay.remove();
      this.enter(session);
    } catch (error) {
      overlay.remove();
      this.fail(error, name);
    }
  }

  async openWorkspace(w: Workspace): Promise<void> {
    const session = await Session.open(this.registry, w);
    this.enter(session);
  }

  /** Connect to a data source that already holds an application, or create one there. */
  private async connectDialog(): Promise<void> {
    const sources = await this.registry.dataSources();
    if (!sources.length) return alertDialog(t('shell', 'Connect'), t('shell', 'No data source plugins are enabled.'));
    const select = h('select', { class: 'input' }, sources.map((s, i) => h('option', { value: String(i) }, `${s.title} — ${s.plugin.name ?? s.plugin.id}`)));
    const form = h('div', { class: 'col' });
    const values: Record<string, unknown> = {};
    const renderSettings = () => {
      const s = sources[Number(select.value)]!;
      for (const k of Object.keys(values)) delete values[k];
      clear(
        form,
        s.description ? h('div', { class: 'muted' }, s.description) : null,
        ...s.settings.map((def) => {
          values[def.key] = def.default ?? null;
          if (def.type === 'file') {
            const label = h('span', { class: 'muted' }, t('shell', 'No file chosen'));
            const choose = button(t('shell', 'Choose a file…'), {
              icon: 'folderOpen',
              class: 'outline',
              onClick: async () => {
                const handle = await pickDatabaseFile(false);
                if (handle) {
                  values[def.key] = handle;
                  label.textContent = handle.name;
                }
              },
            });
            return h('div', { class: 'prop', style: { gridTemplateColumns: '150px 1fr', padding: '3px 0' } }, h('label', null, def.title), h('div', { class: 'row' }, choose, label));
          }
          const ed = editorFor(this, { key: def.key, name: def.key, title: def.title, type: def.type === 'number' ? 'decimal' : def.type === 'boolean' ? 'boolean' : 'string' }, def.default ?? null, (v) => (values[def.key] = v));
          if (def.type === 'password' || def.secret) ed.el.querySelector('input')?.setAttribute('type', 'password');
          return h('div', { class: 'prop', style: { gridTemplateColumns: '150px 1fr', padding: '3px 0' } }, h('label', null, def.title), ed.el);
        }),
      );
    };
    select.addEventListener('change', renderSettings);
    renderSettings();
    const ok = await dialog({
      title: t('shell', 'Connect to a data source'),
      body: h('div', { class: 'col', style: { minWidth: '460px' } }, h('label', null, t('shell', 'Data source')), select, form),
      buttons: [
        { label: t('dialog', 'Cancel'), value: false },
        { label: t('shell', 'Connect'), value: true, primary: true },
      ],
      cancel: false,
    });
    if (!ok) return;
    const s = sources[Number(select.value)]!;
    const secrets: Record<string, unknown> = {};
    const plain: Record<string, unknown> = {};
    for (const def of s.settings) (def.secret ? secrets : plain)[def.key] = values[def.key];
    const id = `ws${Date.now().toString(36)}`;
    const workspace: Workspace = { id, name: s.title, plugin: s.plugin.id, source: s.name, settings: await saveHandles(id, plain), openedAt: new Date().toISOString() };
    await idb.set('secrets', `ws:${workspace.id}`, secrets);
    await this.openOrCreate(workspace, s.title);
  }

  /** Opens a database file; an empty or new one is offered the templates. */
  private async openFile(): Promise<void> {
    const handle = await pickDatabaseFile(false);
    if (!handle) return;
    const id = `ws${Date.now().toString(36)}`;
    await saveHandles(id, { file: handle });
    await this.openOrCreate({ id, name: handle.name, plugin: 'json-file', source: 'file', settings: { path: handle.name }, openedAt: new Date().toISOString() }, handle.name);
  }

  private async openOrCreate(workspace: Workspace, title: string): Promise<void> {
    try {
      const session = await Session.open(this.registry, workspace);
      workspace.name = session.config.app.name;
      settings.workspaces = [workspace, ...settings.workspaces];
      saveSettings();
      this.enter(session);
    } catch (error) {
      if (error instanceof PluginError && error.code === 'not_found') {
        const tplId = await dialog<string | null>({
          title: t('shell', 'No application there yet'),
          body: t('shell', 'The data source is empty. Create an application in it?'),
          buttons: [{ label: t('dialog', 'Cancel'), value: null }, ...TEMPLATES.map((tpl, i) => ({ label: tpl.title, value: tpl.id, primary: i === 0 }))],
          cancel: null,
        });
        const tpl = TEMPLATES.find((x) => x.id === tplId);
        if (!tpl) return;
        const config = tpl.config();
        workspace.name = config.app.name;
        const session = await Session.create(this.registry, workspace, config);
        if (tpl.seed) await tpl.seed(session.data, (text) => this.status(text));
        this.enter(session);
      } else this.fail(error, title);
    }
  }

  /** Where a new application keeps its data: this browser, or a file on disk (Chrome, Edge). */
  private storage: 'browser' | 'file' = 'browser';

  private storageChoice(): HTMLElement | null {
    if (!fileAccess()) return null;
    const select = h('select', { class: 'input', style: { width: 'auto' }, 'data-storage': '' }, h('option', { value: 'browser' }, t('shell', 'in this browser')), h('option', { value: 'file' }, t('shell', 'in a file on disk…')));
    select.value = this.storage;
    select.addEventListener('change', () => (this.storage = select.value as 'browser' | 'file'));
    return h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'muted' }, t('shell', 'Keep the data')), select);
  }

  /* ------------------------------ the frame ------------------------------ */

  private enter(session: Session): void {
    void this.session?.close();
    this.session = session;
    this.pages = [];
    this.active = null;
    setTriggerUI(this.actionUI());
    session.data.onWarning = (error) => this.fail(error, t('shell', 'Saved, but afterwards'));
    session.data.onNotice = (messages) => toast(messages.join('\n'), 'warning');
    session.on('config', () => this.configChanged());
    session.on('connections', () => this.renderStatus());
    session.on('dirty', () => this.renderStatus());
    this.renderFrame();
    const saved = settings.tabs[session.workspace.id] ?? [];
    let opened = false;
    for (const key of saved) opened = this.restoreTab(key) || opened;
    if (!opened) {
      const home = session.config.app.home;
      if (home && session.config.dashboards.some((d) => d.name === home)) this.openTarget({ kind: 'dashboard', name: home });
      else {
        const first = findFirst(menuOf(session.config));
        if (first?.target) this.openTarget(first.target);
      }
    }
  }

  private renderFrame(): void {
    const config = this.session.config;
    document.title = DISTRIBUTION ? config.app.name : `${config.app.name} — BAP Studio`;
    const switchEl = !designerShown() ? null : h(
      'div',
      { class: 'mode-switch', role: 'group' },
      h('button', { type: 'button', class: this.session.mode === 'run' ? 'on' : '', 'data-mode': 'run', onclick: () => this.setMode('run') }, t('shell', 'Application')),
      h('button', { type: 'button', class: this.session.mode === 'design' ? 'on' : '', 'data-mode': 'design', title: 'F12', onclick: () => this.setMode('design') }, t('shell', 'Designer')),
    );
    const menuButton = button(null, { icon: 'menu', title: t('shell', 'Navigation'), onClick: () => this.toggleNav() });
    const appMenu = button(null, { icon: 'more', title: t('shell', 'Menu') });
    appMenu.addEventListener('click', () => popupMenu(appMenu, this.appMenu()));
    const topbar = h(
      'div',
      { class: 'topbar' },
      menuButton,
      h('div', { class: 'brand' }, h('img', { src: ICON, alt: '' }), h('span', { class: 'app-name' }, config.app.name)),
      h('button', { type: 'button', class: 'cmd-trigger', onclick: () => this.palette() }, icon('search'), h('span', null, t('shell', 'Search and commands')), h('span', { class: 'kbd' }, isMac ? '⌘K' : 'Ctrl+K')),
      switchEl,
      button(null, { icon: 'settings', title: t('shell', 'Settings'), onClick: () => openSettings(this) }),
      appMenu,
    );
    this.navBody = h('div', { class: 'nav-body', role: 'tree' });
    const search = h('input', { class: 'input', placeholder: t('shell', 'Find in the menu'), value: this.navFilter, 'aria-label': t('shell', 'Find in the menu') });
    search.addEventListener('input', () => {
      this.navFilter = search.value;
      this.renderNav();
    });
    this.navEl = h('nav', { class: `nav${settings.navCollapsed ? ' collapsed' : ''}`, style: { width: `${settings.navWidth}px` } }, h('div', { class: 'nav-head' }, search), this.navBody);
    const splitter = h('div', { class: 'splitter-v' });
    splitter.addEventListener('pointerdown', (e) => {
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('dragging');
      const start = e.clientX;
      const base = this.navEl.offsetWidth;
      const rtl = document.documentElement.dir === 'rtl';
      const move = (m: PointerEvent) => {
        settings.navWidth = Math.max(160, Math.min(600, base + (rtl ? start - m.clientX : m.clientX - start)));
        this.navEl.style.width = `${settings.navWidth}px`;
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
    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    this.hostEl = h('div', { class: 'page-host' });
    this.statusText = h('span', null);
    this.statusEl = h('footer', { class: 'statusbar' });
    clear(this.root, h('div', { class: 'shell' }, topbar, h('div', { class: 'main' }, this.navEl, splitter, h('div', { class: 'workspace' }, this.tabsEl, this.hostEl)), this.statusEl));
    for (const p of this.pages) this.hostEl.appendChild(p.el);
    this.renderNav();
    this.renderTabs();
    this.renderStatus();
  }

  private toggleNav(): void {
    // On a phone the menu is a panel over the page, closed by default; the setting is the computer's.
    if (matchMedia('(max-width: 760px)').matches) {
      this.navEl.classList.toggle('mobile-open');
      return;
    }
    settings.navCollapsed = !settings.navCollapsed;
    this.navEl.classList.toggle('collapsed', settings.navCollapsed);
    saveSettings();
  }

  private appMenu(): MenuItem[] {
    return [
      { label: t('shell', 'Save the configuration'), icon: 'save', disabled: !this.session.dirty, run: () => void this.session.save().then(() => toast(t('shell', 'Saved'), 'ok'), (e: unknown) => this.fail(e)) },
      { label: t('shell', 'Undo'), icon: 'undo', hint: isMac ? '⌘Z' : 'Ctrl+Z', disabled: !this.session.canUndo(), run: () => void this.session.undo().catch((e: unknown) => this.fail(e)) },
      { label: t('shell', 'Redo'), icon: 'redo', disabled: !this.session.canRedo(), run: () => void this.session.redo().catch((e: unknown) => this.fail(e)) },
      { separator: true },
      { label: t('shell', 'Plugins'), icon: 'puzzle', run: () => void pluginManager(this) },
      { label: t('shell', 'Connections'), icon: 'plug', run: () => this.openDesigner({ kind: 'connections' }) },
      { label: t('shell', 'Schema diagram'), icon: 'diagram', run: () => this.openDesigner({ kind: 'diagram' }) },
      { label: t('shell', 'Export the configuration'), icon: 'download', run: () => this.openDesigner({ kind: 'export' }) },
      { separator: true },
      { label: t('shell', 'Settings'), icon: 'settings', run: () => openSettings(this) },
      { label: t('shell', 'Close the application'), icon: 'x', run: () => void this.closeWorkspace() },
    ];
  }

  async closeWorkspace(): Promise<void> {
    for (const p of [...this.pages]) if (!(await this.closePageAsync(p.id))) return;
    await this.session.close();
    settings.lastWorkspace = null;
    saveSettings();
    this.renderStart();
  }

  /** The designer shown or hidden in the settings: the frame follows, and leaves the designer if it went. */
  designerChanged(): void {
    if (!this.session) return;
    if (!designerShown() && this.session.mode === 'design') this.setMode('run');
    else this.renderFrame();
  }

  setMode(mode: 'run' | 'design'): void {
    if (this.session.mode === mode) return;
    if (mode === 'design' && !designerShown()) return;
    this.session.mode = mode;
    this.renderFrame();
    if (mode === 'design' && !this.pages.some((p) => p.id.startsWith('design:'))) this.openDesigner({ kind: 'overview' });
    for (const p of this.pages) if (p instanceof ListPage) p.refreshToolbar();
    this.active?.onShow?.();
  }

  /** Unsaved cards are saved or given up first: the new version starts with a reload. */
  private async applyUpdate(): Promise<void> {
    for (const page of [...this.pages]) if (page.dirty?.() && !(await this.closePageAsync(page.id))) return;
    if (this.session?.dirty) await this.session.save().catch((e: unknown) => this.fail(e));
    applyUpdate();
  }

  isDesign(): boolean {
    return this.session.mode === 'design';
  }

  private configChanged(): void {
    document.title = `${this.session.config.app.name} — BAP Studio`;
    const name = this.root.querySelector('.app-name');
    if (name) name.textContent = this.session.config.app.name;
    this.renderNav();
    this.renderEmpty();
    this.renderStatus();
    for (const p of this.pages) {
      if (p instanceof ListPage) {
        const v = viewFor(this.session.config, (p as unknown as { view: { name: string } }).view.name);
        if (v) p.setView(v);
      }
      (p as Page & { configChanged?(): void }).configChanged?.();
    }
  }

  /* ------------------------------ navigation ------------------------------ */

  private renderNav(): void {
    if (!this.navBody) return;
    const items: Node[] = [];
    const filter = this.navFilter.trim().toLocaleLowerCase();
    if (this.session.mode === 'design') {
      items.push(...designerTree(this, filter));
    } else {
      const walk = (nodes: MenuNode[], depth: number) => {
        for (const node of nodes) {
          if (node.hidden) continue;
          if (node.children) {
            const kids = document.createDocumentFragment();
            const before = items.length;
            const collapsed = this.collapsedNav.has(node.key) && !filter;
            const row = h('div', { class: `tree-item section`, style: { ['--depth' as string]: String(depth) } as Partial<CSSStyleDeclaration>, role: 'treeitem', 'aria-expanded': String(!collapsed) }, h('span', { class: 'twisty' }, icon(collapsed ? 'chevronRight' : 'chevronDown', 12)), h('span', { class: 'label' }, node.title));
            row.addEventListener('click', () => {
              if (this.collapsedNav.has(node.key)) this.collapsedNav.delete(node.key);
              else this.collapsedNav.add(node.key);
              this.renderNav();
            });
            items.push(row);
            if (!collapsed) walk(node.children, depth + 1);
            if (filter && items.length === before + 1) items.pop();
            void kids;
          } else {
            if (filter && !node.title.toLocaleLowerCase().includes(filter)) continue;
            const row = h('div', { class: `tree-item${this.selectedNav === node.key ? ' selected' : ''}`, style: { ['--depth' as string]: String(depth) } as Partial<CSSStyleDeclaration>, role: 'treeitem', tabindex: 0, 'data-nav': node.key }, h('span', { class: 'twisty' }), icon(node.icon ?? targetIcon(node.target)), h('span', { class: 'label' }, node.title));
            const go = () => {
              this.selectedNav = node.key;
              if (node.target) this.openTarget(node.target, { title: node.title });
              this.renderNav();
              if (matchMedia('(max-width: 760px)').matches) this.toggleNav();
            };
            row.addEventListener('click', go);
            row.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') go();
            });
            items.push(row);
          }
        }
      };
      walk(menuOf(this.session.config), 0);
      if (!items.length) items.push(h('div', { class: 'grid-empty' }, t('shell', 'The menu is empty. Switch to the Designer to add tables.')));
    }
    clear(this.navBody, ...items);
  }

  openTarget(target: MenuTarget, opts: OpenOptions = {}): void {
    const config = this.session.config;
    try {
      if (target.kind === 'table' && target.name === CONSTANTS) {
        void this.openConstants();
        return;
      }
      if (target.kind === 'view' || target.kind === 'table') {
        const v = viewFor(config, target.name);
        if (!v) throw new PluginError('not_found', t('shell', 'Nothing named “{name}”', { name: target.name }));
        this.openOrShow(`view:${v.name}${opts.filter ? `:${JSON.stringify(opts.filter)}` : ''}`, () => new ListPage(this, v, opts));
      } else if (target.kind === 'report') {
        const r = config.reports.find((x) => x.name === target.name);
        if (!r) throw new PluginError('not_found', t('shell', 'Nothing named “{name}”', { name: target.name }));
        this.openOrShow(`report:${r.name}`, () => new ReportPage(this, r));
      } else if (target.kind === 'dashboard') {
        const d = config.dashboards.find((x) => x.name === target.name);
        if (!d) throw new PluginError('not_found', t('shell', 'Nothing named “{name}”', { name: target.name }));
        this.openOrShow(`dashboard:${d.name}`, () => new DashboardPage(this, d));
      } else if (target.kind === 'action') {
        void this.runAction(target.name, {});
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** The application's constants: their one record, created on the first save. */
  async openConstants(): Promise<void> {
    try {
      const row = await this.session.data.get(CONSTANTS, CONSTANTS_ID);
      this.openRecord(CONSTANTS, row ? CONSTANTS_ID : null, row ? undefined : { id: CONSTANTS_ID });
    } catch (error) {
      this.fail(error);
    }
  }

  openRecord(table: string, id: string | null, init?: Row | Record<string, unknown>, onSaved?: (row: Row) => void): void {
    const tb = tableOf(this.session.config, table);
    const form = tb ? formFor(this.session.config, tb) : undefined;
    if (form?.modal) {
      this.openModal(new CardPage(this, table, id, init ?? {}, onSaved), form.width, form.height);
      return;
    }
    if (id) this.openOrShow(`record:${table}:${id}`, () => new CardPage(this, table, id, {}, onSaved));
    else this.openPage(new CardPage(this, table, null, init ?? {}, onSaved));
  }

  /** Pages shown as windows over the tabs (a form marked "dialog"), with what closes each. */
  private modals = new Map<Page, () => void>();

  private openModal(page: Page, width?: number, height?: number): void {
    page.el.classList.add('embedded');
    void dialog<undefined>({
      title: page.title,
      body: page.el,
      flush: true,
      wide: true,
      size: { width: width || 900, height: height || 640 },
      buttons: [],
      cancel: undefined,
      canCancel: () => page.canClose?.() ?? Promise.resolve(true),
      onOpen: (close) => this.modals.set(page, () => close(undefined)),
    }).then(() => {
      this.modals.delete(page);
      page.dispose?.();
    });
  }

  openDesigner(target: DesignerTarget): void {
    openDesigner(this, target);
  }

  designTable(table: string, field?: string): void {
    if (this.session.mode !== 'design') this.setMode('design');
    openDesigner(this, { kind: 'table', name: table, ...(field ? { field } : {}) });
  }

  private openOrShow(id: string, make: () => Page): void {
    const existing = this.pages.find((p) => p.id === id);
    if (existing) this.show(existing);
    else this.openPage(make());
  }

  /* ------------------------------ tabs ------------------------------ */

  openPage(page: Page): void {
    const existing = this.pages.find((p) => p.id === page.id);
    if (existing) {
      this.show(existing);
      return;
    }
    this.pages.push(page);
    page.el.classList.add('page');
    this.hostEl.appendChild(page.el);
    this.show(page);
    this.rememberTabs();
  }

  private show(page: Page): void {
    if (this.active && this.active !== page) (this.active as Page & { visible?: boolean }).visible = false;
    this.active = page;
    for (const p of this.pages) p.el.classList.toggle('hidden-page', p !== page);
    this.renderTabs();
    page.onShow?.();
    this.renderStatus();
  }

  updateTab(page: Page & { previousId?: string }): void {
    if (page.previousId) {
      delete page.previousId;
      this.rememberTabs();
    }
    this.renderTabs();
  }

  closePage(id: string): void {
    for (const [page, close] of this.modals) {
      if (page.id === id) {
        close();
        return;
      }
    }
    void this.closePageAsync(id);
  }

  private async closePageAsync(id: string): Promise<boolean> {
    const page = this.pages.find((p) => p.id === id);
    if (!page) return true;
    if (page.canClose && !(await page.canClose())) return false;
    page.dispose?.();
    page.el.remove();
    const at = this.pages.indexOf(page);
    this.pages.splice(at, 1);
    if (this.active === page) {
      const next = this.pages[at] ?? this.pages[at - 1] ?? null;
      this.active = null;
      if (next) this.show(next);
    }
    this.renderTabs();
    this.rememberTabs();
    return true;
  }

  private renderTabs(): void {
    if (!this.tabsEl) return;
    this.renderEmpty();
    clear(
      this.tabsEl,
      ...this.pages.map((p) => {
        const tab = h(
          'div',
          { class: `tab${p === this.active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(p === this.active), title: p.title, 'data-tab': p.id },
          p.icon ? icon(p.icon, 14) : null,
          h('span', { class: 'label' }, p.title),
          p.dirty?.() ? h('span', { class: 'dirty', title: t('shell', 'Not saved') }) : null,
          h('button', { type: 'button', class: 'close', 'aria-label': t('shell', 'Close'), onclick: (e: MouseEvent) => (e.stopPropagation(), this.closePage(p.id)) }, icon('x', 12)),
        );
        tab.addEventListener('click', () => this.show(p));
        tab.addEventListener('auxclick', (e) => {
          if (e.button === 1) this.closePage(p.id);
        });
        tab.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          popupMenu({ x: e.clientX, y: e.clientY }, [
            { label: t('shell', 'Close'), run: () => this.closePage(p.id) },
            { label: t('shell', 'Close the others'), run: () => this.pages.filter((x) => x !== p).forEach((x) => this.closePage(x.id)) },
            { label: t('shell', 'Close all'), run: () => [...this.pages].forEach((x) => this.closePage(x.id)) },
          ]);
        });
        return tab;
      }),
    );
    this.tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** With no tab open, a few ways to go on instead of a blank page. */
  private renderEmpty(): void {
    this.hostEl.querySelector(':scope > .empty-host')?.remove();
    if (this.pages.length) return;
    const config = this.session.config;
    const items: Node[] = [];
    if (!config.tables.length) {
      items.push(
        h('h2', null, t('shell', 'An empty application')),
        h('p', { class: 'muted' }, t('shell', 'Start with a table: a catalog of things, a document for events, a register for balances.')),
        h('div', { class: 'f-buttons', style: { justifyContent: 'center' } }, button(t('shell', 'New table…'), { icon: 'plus', class: 'primary', onClick: () => (this.setMode('design'), this.openDesigner({ kind: 'newTable' })) }), button(t('shell', 'Open the Designer'), { icon: 'wrench', class: 'outline', onClick: () => this.setMode('design') })),
      );
    } else {
      items.push(h('h2', null, config.app.name), h('p', { class: 'muted' }, t('shell', 'Choose something in the menu, or search with Ctrl+K.')));
      const first = findFirst(menuOf(config));
      if (first?.target) items.push(h('div', { class: 'f-buttons', style: { justifyContent: 'center' } }, button(first.title, { icon: first.icon ?? targetIcon(first.target), class: 'primary', onClick: () => this.openTarget(first.target!) })));
    }
    this.hostEl.appendChild(h('div', { class: 'empty-host', style: { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px' } }, ...items));
  }

  private rememberTabs(): void {
    if (!this.session) return;
    settings.tabs[this.session.workspace.id] = this.pages.map((p) => p.id).filter((id) => /^(view|report|dashboard|record):/.test(id) && !id.includes('{'));
    saveSettings();
  }

  private restoreTab(id: string): boolean {
    const [kind, name, recordId] = id.split(':') as [string, string, string?];
    const config = this.session.config;
    if (kind === 'view' && viewFor(config, name)) this.openTarget({ kind: 'view', name });
    else if (kind === 'report' && config.reports.some((r) => r.name === name)) this.openTarget({ kind: 'report', name });
    else if (kind === 'dashboard' && config.dashboards.some((d) => d.name === name)) this.openTarget({ kind: 'dashboard', name });
    else if (kind === 'record' && recordId && tableOf(config, name)) this.openRecord(name, recordId);
    else return false;
    return true;
  }

  /* ------------------------------ status ------------------------------ */

  status(text: string): void {
    if (this.statusText) this.statusText.textContent = text;
  }

  private renderStatus(): void {
    if (!this.statusEl || !this.session) return;
    const conns = [...this.session.connections.values()];
    const bad = conns.filter((c) => !c.remote);
    const dot = h('span', { class: `status-dot${bad.length ? ' error' : ''}` });
    const connText = h(
      'span',
      { style: { cursor: 'pointer' }, title: bad.map((b) => `${b.def.title ?? b.def.id}: ${b.error}`).join('\n') || t('shell', 'Connected'), onclick: () => this.openDesigner({ kind: 'connections' }) },
      dot,
      bad.length ? tn('shell', '{count} source unavailable', '{count} sources unavailable', bad.length) : `${this.session.workspace.plugin}${this.session.workspace.settings.name ? `: ${String(this.session.workspace.settings.name)}` : ''}`,
    );
    clear(
      this.statusEl,
      connText,
      this.session.dirty ? h('span', { style: { color: 'var(--warn)' } }, t('shell', 'Configuration not saved')) : null,
      this.statusText,
      h('span', { class: 'sep' }),
      h('span', null, icon('user', 12), ' ', settings.user),
      h('span', null, new Intl.DateTimeFormat(effectiveLanguage(), { dateStyle: 'medium' }).format(new Date())),
      h('span', null, this.session.mode === 'design' ? t('shell', 'Designer') : t('shell', 'Application')),
      this.update.kind === 'ready'
        ? h('button', { type: 'button', class: 'btn primary', style: { height: '20px', fontSize: '12px' }, onclick: () => void this.applyUpdate() }, t('shell', 'Update to {version}', { version: this.update.version ?? '' }))
        : h('span', null, `v${__APP_VERSION__}`),
    );
  }

  /* ------------------------------ actions ------------------------------ */

  actionUI(): ActionUI {
    return {
      ask: (title, fields) => this.askParams(title, fields),
      confirm: (text) =>
        dialog({ title: t('shell', 'Confirm'), body: h('p', { style: { margin: '0' } }, text), buttons: [{ label: t('dialog', 'Cancel'), value: false }, { label: t('dialog', 'OK'), value: true, primary: true }], cancel: false }),
      message: (text) => toast(text, 'info'),
      openRecord: (table, id) => this.openRecord(table, id),
      openNew: (table, row) => this.openRecord(table, null, row),
      open: (target, filter) => this.openTarget(target, filter ? { title: filter } : {}),
      print: (template, table, ids) => {
        const p = this.session.config.printTemplates.find((x) => x.name === template);
        const tb = tableOf(this.session.config, table);
        if (p && tb) printRecords(this, p, tb, ids.map((id) => ({ id })));
      },
      runPlugin: async (plugin, action, args) => {
        const worker = await this.registry.start(plugin);
        const result = await worker.request({ kind: 'action', action, args }, 120_000);
        if (result instanceof Blob) {
          const { download } = await import('./dom');
          download(result, `${action}.bin`);
        }
        return result;
      },
    };
  }

  private async askParams(title: string, fields: import('../core/config/types').FieldDef[]): Promise<Record<string, unknown> | null> {
    const values: Record<string, unknown> = {};
    const env = await this.data.scope({ key: 'params', name: 'params', kind: 'table', title: '', fields }, fields.map((f) => f.default ?? '').filter(Boolean));
    const { evaluate } = await import('../core/expr/index');
    const { parseCached } = await import('../core/data');
    const rows = fields.map((f) => {
      try {
        values[f.name] = f.default ? evaluate(parseCached(f.default), env({})) : null;
      } catch {
        values[f.name] = null;
      }
      const ed = editorFor(this, f, values[f.name], (v) => (values[f.name] = v));
      return h('div', { class: 'f-field' }, h('label', null, f.title ?? f.name, f.required ? h('span', { class: 'req' }, '*') : null), ed.el);
    });
    const ok = await dialog({
      title,
      body: h('div', { style: { minWidth: '380px' } }, rows),
      buttons: [
        { label: t('dialog', 'Cancel'), value: false },
        { label: t('dialog', 'OK'), value: true, primary: true, check: () => fields.every((f) => !f.required || (values[f.name] !== null && values[f.name] !== '')) },
      ],
      cancel: false,
    });
    return ok ? values : null;
  }

  async runAction(name: string, ctx: ActionContext): Promise<void> {
    const action = this.session.config.actions.find((a) => a.name === name);
    if (!action) return this.fail(new PluginError('not_found', t('shell', 'No action “{name}”', { name })));
    try {
      await runAction(this.data, action, ctx, this.actionUI());
    } catch (error) {
      this.fail(error, action.title);
    }
  }

  async exporters(): Promise<{ plugin: string; name: string; title: string; extension: string }[]> {
    const out = [];
    for (const plugin of this.registry.plugins.values()) {
      if (!plugin.enabled || !this.registry.trusted(plugin)) continue;
      try {
        const worker = await this.registry.start(plugin.id);
        for (const e of worker.description?.exporters ?? []) out.push({ plugin: plugin.id, ...e });
      } catch {
        // A broken plugin offers nothing here; the plugin manager shows why.
      }
    }
    return out;
  }

  async runExporter(plugin: string, name: string, input: { table: string; rows: Record<string, unknown>[]; columns: { field: string; title: string }[] }): Promise<void> {
    try {
      const worker = await this.registry.start(plugin);
      const result = await worker.request({ kind: 'export', exporter: name, input }, 120_000);
      if (!(result instanceof Blob)) throw new PluginError('internal', t('shell', 'The exporter returned no file'));
      const extension = worker.description?.exporters.find((e) => e.name === name)?.extension ?? 'bin';
      const { download } = await import('./dom');
      download(result, `${input.table}.${extension}`);
    } catch (error) {
      this.fail(error, name);
    }
  }

  /** A selection dialog over the table's list. */
  choose(tb: TableDef, opts: { multi?: boolean; filter?: Filter } = {}): Promise<Row[] | null> {
    return new Promise((resolve) => {
      let finish: (v: Row[] | null) => void = () => {};
      const view = viewFor(this.session.config, tb.name) ?? defaultView(this.session.config, tb);
      const list = new ListPage(this, { ...view, details: [] }, { select: { multi: opts.multi === true, done: (rows) => finish(rows) }, ...(opts.filter ? { filter: opts.filter } : {}) });
      void dialog<Row[] | null>({
        title: opts.multi ? t('shell', '{table}: choose several', { table: tb.title }) : t('shell', '{table}: choose one', { table: tb.title }),
        body: list.el,
        flush: true,
        wide: true,
        buttons: [],
        cancel: null,
        onOpen: (close) => {
          finish = (rows) => close(rows);
          setTimeout(() => list.focus(), 50);
        },
      }).then((rows) => {
        list.dispose();
        resolve(rows);
      });
    });
  }

  fail(error: unknown, what?: string): void {
    console.warn(error);
    let message = error instanceof Error ? error.message : String(error);
    if (error instanceof ValidationError) message = error.problems.map((p) => p.message).join('\n');
    if (error instanceof PluginError) {
      const prefix: Record<string, string> = {
        network: t('shell', 'The data source cannot be reached'),
        timeout: t('shell', 'The data source did not answer in time'),
        auth: t('shell', 'The data source refused the credentials'),
        forbidden: t('shell', 'Not allowed'),
        conflict: t('shell', 'Changed by someone else'),
        not_found: t('shell', 'Not found'),
        unsupported: t('shell', 'The data source cannot do this'),
      };
      if (prefix[error.code]) message = `${prefix[error.code]}: ${message}`;
    }
    const text = what ? `${what}: ${message}` : message;
    if (error instanceof ValidationError && error.problems.length > 1) void alertDialog(what ?? t('shell', 'Cannot be done'), message);
    else toast(text, 'error');
  }

  /* ------------------------------ keyboard and palette ------------------------------ */

  private key(e: KeyboardEvent): void {
    if (!this.session || !this.tabsEl?.isConnected) return;
    if (dialogOpen()) {
      // A record's form open as a window keeps its own shortcuts (Ctrl+S, Ctrl+Enter).
      const top = [...this.modals.keys()].pop();
      if (top?.onKey?.(e)) e.preventDefault();
      return;
    }
    if (modKey(e) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      closeMenu();
      this.palette();
      return;
    }
    if (e.key === 'F12') {
      e.preventDefault();
      this.setMode(this.session.mode === 'run' ? 'design' : 'run');
      return;
    }
    if (this.active?.onKey?.(e)) {
      e.preventDefault();
      return;
    }
    if (modKey(e) && e.key.toLowerCase() === 'z' && this.session.mode === 'design' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      void (e.shiftKey ? this.session.redo() : this.session.undo()).catch((err: unknown) => this.fail(err));
      return;
    }
    if (this.hotkey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'w' && e.altKey && this.active) {
      e.preventDefault();
      this.closePage(this.active.id);
    }
  }

  /**
   * The configuration's shortcuts: a menu item opens its target, an action of
   * no table runs, an action of a table runs in a list or card of it. A key
   * without Ctrl or Alt is left alone while the person types.
   */
  private hotkey(e: KeyboardEvent): boolean {
    const code = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit([0-9])$/.exec(e.code)?.[1] ?? (/^F([1-9]|1[0-2])$/.test(e.code) ? e.code : null);
    if (!code) return false;
    const ctrl = modKey(e);
    const target = e.target as HTMLElement | null;
    if (!ctrl && !e.altKey && target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return false;
    const combo = [ctrl ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', code].filter(Boolean).join('+');
    const config = this.session.config;
    const find = (nodes: MenuNode[]): MenuNode | undefined => {
      for (const n of nodes) {
        if (n.target && normalizeHotkey(n.hotkey) === combo) return n;
        const inside = n.children ? find(n.children) : undefined;
        if (inside) return inside;
      }
      return undefined;
    };
    const item = find(menuOf(config));
    if (item?.target) {
      this.openTarget(item.target, { title: item.title });
      return true;
    }
    for (const a of config.actions) {
      if (normalizeHotkey(a.hotkey) !== combo) continue;
      if (!a.table) {
        void this.runAction(a.name, {});
        return true;
      }
      if (this.active?.hotkeyAction?.(a)) return true;
    }
    return false;
  }

  palette(): void {
    if (!this.session) return;
    const config = this.session.config;
    type Entry = { label: string; hint: string; icon: string; run: () => void };
    const entries: Entry[] = [];
    const walk = (nodes: MenuNode[], path: string) => {
      for (const n of nodes) {
        if (n.children) walk(n.children, n.title);
        else if (n.target) entries.push({ label: n.title, hint: path, icon: n.icon ?? targetIcon(n.target), run: () => this.openTarget(n.target!, { title: n.title }) });
      }
    };
    walk(menuOf(config), '');
    for (const tb of config.tables) {
      entries.push({ label: tb.title, hint: t('shell', 'Table'), icon: tb.icon ?? 'table', run: () => this.openTarget({ kind: 'table', name: tb.name }) });
      if (tb.kind !== 'register') entries.push({ label: t('shell', 'New: {what}', { what: tb.itemTitle ?? tb.title }), hint: t('shell', 'Create'), icon: 'plus', run: () => this.openRecord(tb.name, null) });
    }
    if (constantsTable(config)) entries.push({ label: t('shell', 'Constants'), hint: t('shell', 'Application'), icon: 'settings', run: () => void this.openConstants() });
    for (const r of config.reports) entries.push({ label: r.title, hint: t('shell', 'Report'), icon: r.icon ?? 'chart', run: () => this.openTarget({ kind: 'report', name: r.name }) });
    for (const a of config.actions) if (!a.table) entries.push({ label: a.title, hint: t('shell', 'Action'), icon: a.icon ?? 'bolt', run: () => void this.runAction(a.name, {}) });
    entries.push(
      ...(designerShown() ? [{ label: this.session.mode === 'run' ? t('shell', 'Switch to the Designer') : t('shell', 'Switch to the Application'), hint: 'F12', icon: 'wrench', run: () => this.setMode(this.session.mode === 'run' ? 'design' : 'run') }] : []),
      { label: t('shell', 'Plugins'), hint: t('shell', 'Studio'), icon: 'puzzle', run: () => void pluginManager(this) },
      { label: t('shell', 'Schema diagram'), hint: t('shell', 'Studio'), icon: 'diagram', run: () => this.openDesigner({ kind: 'diagram' }) },
      { label: t('shell', 'New table…'), hint: t('shell', 'Designer'), icon: 'plus', run: () => this.openDesigner({ kind: 'newTable' }) },
      { label: t('shell', 'Settings'), hint: t('shell', 'Studio'), icon: 'settings', run: () => openSettings(this) },
      { label: t('shell', 'Close the application'), hint: t('shell', 'Studio'), icon: 'x', run: () => void this.closeWorkspace() },
    );
    for (const [code, name] of Object.entries(LANGUAGES)) entries.push({ label: `${t('shell', 'Language')}: ${name}`, hint: t('shell', 'Studio'), icon: 'globe', run: () => this.setLanguage(code as keyof typeof LANGUAGES) });
    const input = h('input', { placeholder: t('shell', 'Type a command, a table, a report…'), 'aria-label': t('shell', 'Search and commands') });
    const list = h('div', { class: 'palette-list', role: 'listbox' });
    const overlay = h('div', { class: 'palette' }, h('div', { class: 'palette-box' }, input, list));
    let shown: Entry[] = [];
    let active = 0;
    const render = () => {
      const q = input.value.trim().toLocaleLowerCase();
      shown = entries
        .map((e) => ({ e, score: fuzzy(`${e.label} ${e.hint}`.toLocaleLowerCase(), q) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map((x) => x.e);
      active = Math.min(active, Math.max(0, shown.length - 1));
      clear(
        list,
        ...shown.map((e, i) => {
          const row = h('div', { class: `popup-item${i === active ? ' active' : ''}`, role: 'option' }, icon(e.icon), h('span', null, e.label), h('span', { class: 'hint' }, e.hint));
          row.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            close();
            e.run();
          });
          return row;
        }),
      );
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };
    const close = () => overlay.remove();
    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') active = Math.min(shown.length - 1, active + 1);
      else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
      else if (e.key === 'Enter') {
        const entry = shown[active];
        close();
        entry?.run();
        return;
      } else if (e.key === 'Escape') {
        close();
        return;
      } else return;
      e.preventDefault();
      render();
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    render();
    input.focus();
  }

  setLanguage(code: keyof typeof LANGUAGES | 'system'): void {
    settings.language = code;
    saveSettings();
    setLanguage(effectiveLanguage());
    translatePage();
    if (this.session) this.renderFrame();
    else this.renderStart();
  }
}

type FilePickers = {
  showOpenFilePicker?(o?: object): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o?: object): Promise<FileSystemFileHandle>;
};

/** File System Access: files kept and written in place (Chrome and Edge on a computer). */
function fileAccess(): boolean {
  return typeof (window as unknown as FilePickers).showSaveFilePicker === 'function';
}

/** Asks for a .bap.json file to open or to create; null when the person cancels. */
async function pickDatabaseFile(create: boolean, suggestedName = 'application.bap.json'): Promise<FileSystemFileHandle | null> {
  const w = window as unknown as FilePickers;
  const types = [{ description: 'BAP Studio database', accept: { 'application/json': ['.json'] } }];
  try {
    if (create) return (await w.showSaveFilePicker?.({ suggestedName, types, id: 'bap-db' })) ?? null;
    return (await w.showOpenFilePicker?.({ types, id: 'bap-db' }))?.[0] ?? null;
  } catch {
    return null;
  }
}

function findFirst(nodes: MenuNode[]): MenuNode | null {
  for (const n of nodes) {
    if (n.target && !n.hidden) return n;
    if (n.children) {
      const f = findFirst(n.children);
      if (f) return f;
    }
  }
  return null;
}

export function targetIcon(target?: MenuTarget): string {
  switch (target?.kind) {
    case 'report':
      return 'chart';
    case 'dashboard':
      return 'dashboard';
    case 'action':
      return 'bolt';
    default:
      return 'table';
  }
}

/** A subsequence match, better for a match at a word's start and for shorter labels; -1 when no match. */
function fuzzy(text: string, q: string): number {
  if (!q) return 0;
  if (text.includes(q)) return 100 - text.indexOf(q) - text.length / 100;
  let at = 0;
  let score = 0;
  for (const c of q) {
    const found = text.indexOf(c, at);
    if (found < 0) return -1;
    score += found === at ? 2 : found > 0 && text[found - 1] === ' ' ? 3 : 1;
    at = found + 1;
  }
  return score - text.length / 100;
}
