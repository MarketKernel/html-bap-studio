/**
 * Connections (Task.md 9.6): the data sources the application's tables live
 * in — each a plugin's data source with its settings — with their state,
 * reconnecting, settings built from what the plugin declares, importing the
 * tables of a source with its own schema, and copying every record of one
 * connection into another.
 *
 * Secret settings (tokens, passwords) never enter the configuration: they are
 * kept in IndexedDB under `conn:<workspace>:<connection>`, which is where
 * Session.connect() looks for them.
 */
import { t } from '../../core/i18n';
import { connectionOf, newKey, table as tableOf, IDENT } from '../../core/config/model';
import type { ConnectionDef, FieldDef, FieldType, MenuNode, TableDef } from '../../core/config/types';
import type { BatchOp, ExternalField, ExternalTable, SettingDef } from '../../core/plugin-protocol';
import type { Row } from '../../core/query/types';
import { button, clear, h, icon } from '../dom';
import { alertDialog, confirm, dialog, toast } from '../ui';
import { idb } from '../storage';
import type { RemoteConnection } from '../plugins/host';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { identFrom, uniqueName } from './index';

const CHUNK = 500;

interface SettingsForm {
  el: HTMLElement;
  /** The values typed; secrets left empty keep what is stored. */
  read(): { settings: Record<string, unknown>; secrets: Record<string, unknown> };
  /** A message when a required setting is missing. */
  check(): string | null;
}

/** A form for a data source's settings, as the plugin declares them. */
function settingsForm(defs: SettingDef[], values: Record<string, unknown>, stored: Record<string, unknown>, readOnly = false): SettingsForm {
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const rows = defs.map((def) => {
    const secret = def.secret === true || def.type === 'password';
    const value = values[def.key] ?? def.default;
    let control: HTMLInputElement | HTMLSelectElement;
    if (def.type === 'boolean') {
      control = h('input', { type: 'checkbox' });
      control.checked = value === true;
    } else if (def.type === 'select') {
      control = h('select', { class: 'input' }, def.required ? null : h('option', { value: '' }, '—'), (def.options ?? []).map((o) => h('option', { value: o.value }, o.title)));
      control.value = value === undefined || value === null ? '' : String(value);
    } else {
      const type = secret ? 'password' : def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : def.type === 'url' ? 'url' : 'text';
      control = h('input', { class: 'input', type, autocomplete: secret ? 'new-password' : 'off' });
      if (secret) control.placeholder = stored[def.key] !== undefined ? t('connections', '•••••• stored — leave empty to keep') : '';
      else control.value = value === undefined || value === null ? '' : String(value);
    }
    control.dataset.setting = def.key;
    control.disabled = readOnly;
    controls.set(def.key, control);
    return h(
      'div',
      { class: 'f-field' },
      h('label', null, def.title, def.required ? h('span', { class: 'req' }, '*') : null),
      h('div', { class: 'col cn-control' }, control, def.description ? h('div', { class: 'help' }, def.description) : null, secret ? h('div', { class: 'help' }, icon('lock', 12), ' ', t('connections', 'Kept in this browser only, never in the configuration')) : null),
    );
  });
  return {
    el: h('div', { class: 'cn-settings' }, rows.length ? rows : h('p', { class: 'muted' }, t('connections', 'This data source has no settings.'))),
    read() {
      const settings: Record<string, unknown> = {};
      const secrets: Record<string, unknown> = { ...stored };
      for (const def of defs) {
        const control = controls.get(def.key)!;
        const secret = def.secret === true || def.type === 'password';
        let value: unknown;
        if (control instanceof HTMLInputElement && control.type === 'checkbox') value = control.checked;
        else if (def.type === 'number') value = control.value === '' ? undefined : Number(control.value);
        else value = control.value === '' ? undefined : control.value;
        if (secret) {
          if (value !== undefined) secrets[def.key] = value;
        } else if (value !== undefined) settings[def.key] = value;
      }
      return { settings, secrets };
    },
    check() {
      for (const def of defs) {
        if (!def.required) continue;
        const control = controls.get(def.key)!;
        const secret = def.secret === true || def.type === 'password';
        if (control instanceof HTMLInputElement && control.type === 'checkbox') continue;
        if (!control.value && !(secret && stored[def.key] !== undefined)) return t('connections', '“{setting}” is required', { setting: def.title });
      }
      return null;
    },
  };
}

/** An external source's type in the configuration's terms; text when unsure. */
function fieldType(f: ExternalField, known: Set<string>): { type: FieldType; scale?: number; ref?: string } {
  const raw = f.type.toLowerCase();
  if ((raw === 'ref' || f.ref) && f.ref && known.has(f.ref)) return { type: 'ref', ref: f.ref };
  if (['string', 'varchar', 'char', 'nvarchar', 'uuid', 'ref'].includes(raw)) return { type: 'string' };
  if (['text', 'clob', 'longtext'].includes(raw)) return { type: 'text' };
  if (['integer', 'int', 'bigint', 'smallint', 'int32', 'int64', 'long'].includes(raw)) return { type: 'integer' };
  if (['number', 'decimal', 'numeric', 'float', 'double', 'real', 'money', 'currency'].includes(raw)) return { type: 'decimal', scale: f.scale ?? (raw === 'float' || raw === 'double' || raw === 'real' ? 4 : 2) };
  if (['boolean', 'bool', 'bit'].includes(raw)) return { type: 'boolean' };
  if (raw === 'date') return { type: 'date' };
  if (['datetime', 'timestamp', 'datetime2'].includes(raw)) return { type: 'datetime' };
  if (raw === 'time') return { type: 'time' };
  const own: FieldType[] = ['enum', 'file', 'image', 'color', 'email', 'phone', 'url', 'json'];
  if ((own as string[]).includes(raw)) return { type: raw as FieldType };
  return { type: 'string' };
}

export class ConnectionsPage implements Page {
  readonly id = 'design:connections';
  title = t('connections', 'Connections');
  icon = 'plug';
  readonly el: HTMLElement;
  private main: HTMLElement;
  private toolbar: HTMLElement;
  private unsubscribe: () => void;
  private busy = new Set<string>();

  constructor(private readonly shell: Shell) {
    this.toolbar = h('div', { class: 'toolbar' });
    this.main = h('div', { class: 'cn-main' });
    this.el = h('div', { class: 'page' }, this.toolbar, this.main);
    this.unsubscribe = shell.session.on('connections', () => this.render());
    this.render();
  }

  configChanged(): void {
    this.render();
  }

  dispose(): void {
    this.unsubscribe();
  }

  private wsKey(id: string): string {
    return `conn:${this.shell.session.workspace.id}:${id}`;
  }

  private tablesOf(id: string): TableDef[] {
    const config = this.shell.session.config;
    return config.tables.filter((tb) => connectionOf(config, tb) === id);
  }

  private remote(id: string): RemoteConnection | null {
    return this.shell.session.connections.get(id)?.remote ?? null;
  }

  private render(): void {
    const config = this.shell.session.config;
    clear(
      this.toolbar,
      icon('plug'),
      h('span', { class: 'page-title' }, t('connections', 'Connections')),
      h('span', { class: 'spacer' }),
      button(t('connections', 'Add connection'), { icon: 'plus', class: 'primary', onClick: () => void this.add() }),
    );
    clear(
      this.main,
      h('p', { class: 'muted cn-intro' }, t('connections', 'Each table keeps its records in a connection: the main one unless the table names another. References between tables of different connections work by id; a change spanning connections is not one transaction.')),
      h('div', { class: 'cn-list' }, config.connections.map((def) => this.card(def))),
    );
  }

  private card(def: ConnectionDef): HTMLElement {
    const entry = this.shell.session.connections.get(def.id);
    const remote = entry?.remote ?? null;
    const caps = remote?.caps;
    const busy = this.busy.has(def.id);
    const state = busy ? 'busy' : remote ? 'ok' : entry?.error ? 'error' : 'busy';
    const stateText = busy ? t('connections', 'Working…') : remote ? t('connections', 'Connected') : entry?.error ? t('connections', 'Error') : t('connections', 'Not connected');
    const tables = this.tablesOf(def.id);
    const plugin = this.shell.registry.plugins.get(def.plugin);
    const others = this.shell.session.config.connections.filter((c) => c.id !== def.id && this.remote(c.id)?.caps.write);
    const tags: string[] = [];
    if (caps) {
      tags.push(caps.schema === 'external' ? t('connections', 'own schema') : t('connections', 'managed schema'));
      if (!caps.write) tags.push(t('connections', 'read only'));
      if (caps.batch) tags.push(t('connections', 'transactions'));
      if (caps.changes) tags.push(t('connections', 'live changes'));
    }
    return h(
      'div',
      { class: 'cn-card', 'data-connection': def.id },
      h(
        'div',
        { class: 'cn-head' },
        h('span', { class: `status-dot${state === 'ok' ? '' : ` ${state}`}`, title: stateText }),
        h('span', { class: 'cn-title' }, def.title ?? def.id),
        h('span', { class: 'mono muted' }, def.id),
        h('span', { class: 'cn-state' }, stateText),
        h('span', { class: 'spacer' }),
        h('span', { class: 'cn-plugin muted', title: plugin?.name ?? def.plugin }, icon('puzzle', 13), ` ${def.plugin} / ${def.source}`),
      ),
      entry?.error && !remote ? h('div', { class: 'cn-error' }, icon('warning', 14), ' ', entry.error) : null,
      tags.length ? h('div', { class: 'cn-tags' }, tags.map((tag) => h('span', { class: 'cn-tag' }, tag))) : null,
      h(
        'div',
        { class: 'cn-tables' },
        h('span', { class: 'muted' }, t('connections', 'Tables:')),
        tables.length ? tables.map((tb) => h('span', { class: 'cn-chip', title: tb.name }, icon(tb.icon ?? 'table', 12), tb.title)) : h('span', { class: 'muted' }, t('connections', 'none')),
      ),
      h(
        'div',
        { class: 'f-buttons cn-buttons' },
        button(t('connections', 'Reconnect'), { icon: 'refresh', disabled: busy, onClick: () => void this.reconnect(def.id) }),
        button(t('connections', 'Settings'), { icon: 'settings', onClick: () => void this.settings(def) }),
        caps?.schema === 'external' ? button(t('connections', 'Import tables…'), { icon: 'download', disabled: busy, onClick: () => void this.importTables(def) }) : null,
        button(t('connections', 'Copy all data to…'), { icon: 'copy', disabled: busy || !remote || !tables.length || !others.length, title: !others.length ? t('connections', 'Add another writable connection first') : '', onClick: () => void this.copyData(def) }),
        def.id === 'main' ? null : button(t('connections', 'Delete'), { icon: 'trash', class: 'danger', onClick: () => void this.remove(def) }),
      ),
    );
  }

  private async reconnect(id: string): Promise<void> {
    this.busy.add(id);
    this.render();
    try {
      await this.shell.session.reconnect(id);
      const entry = this.shell.session.connections.get(id);
      if (entry?.remote) toast(t('connections', 'Connected'), 'ok');
      else toast(entry?.error ?? t('connections', 'Could not connect'), 'error');
    } catch (error) {
      this.shell.fail(error);
    } finally {
      this.busy.delete(id);
      this.render();
    }
  }

  /** The settings a plugin declares for one of its data sources. */
  private async sourceSettings(plugin: string, source: string): Promise<SettingDef[]> {
    const worker = await this.shell.registry.start(plugin);
    const ds = worker.description?.dataSources.find((s) => s.name === source);
    if (!ds) throw new Error(t('connections', 'Plugin “{plugin}” has no data source “{source}”', { plugin, source }));
    return ds.settings ?? [];
  }

  /** Connects with the given settings under a scratch name, and disconnects again. */
  private async check(plugin: string, source: string, settings: Record<string, unknown>, out: HTMLElement): Promise<void> {
    clear(out, h('span', { class: 'muted' }, t('connections', 'Connecting…')));
    try {
      const probe = await this.shell.registry.connect(`check-${newKey('c')}`, plugin, source, settings);
      await probe.close();
      clear(out, h('span', { class: 'cn-ok' }, icon('check', 14), ' ', t('connections', 'The connection works')));
    } catch (error) {
      clear(out, h('span', { class: 'field-error' }, error instanceof Error ? error.message : String(error)));
    }
  }

  private async settings(def: ConnectionDef): Promise<void> {
    let defs: SettingDef[];
    try {
      defs = await this.sourceSettings(def.plugin, def.source);
    } catch (error) {
      return this.shell.fail(error);
    }
    // The main connection is where the application itself is stored: its settings are the workspace's.
    if (def.id === 'main') {
      const form = settingsForm(defs, this.shell.session.workspace.settings, {}, true);
      await dialog({
        title: t('connections', 'Settings of “{name}”', { name: def.title ?? def.id }),
        body: h('div', { class: 'cn-dialog' }, h('p', { class: 'muted' }, t('connections', 'The main connection holds the application itself; its settings belong to the workspace and are chosen when it is opened.')), form.el),
        buttons: [{ label: t('dialog', 'OK'), value: undefined, primary: true }],
        cancel: undefined,
      });
      return;
    }
    const stored = (await idb.get<Record<string, unknown>>('secrets', this.wsKey(def.id)).catch(() => undefined)) ?? {};
    const form = settingsForm(defs, def.settings, stored);
    const title = h('input', { class: 'input', value: def.title ?? '', placeholder: def.id });
    const error = h('div', { class: 'field-error' });
    const result = h('div', { class: 'cn-check' });
    const settingsNow = () => {
      const r = form.read();
      return { ...r.settings, ...r.secrets };
    };
    const ok = await dialog<boolean>({
      title: t('connections', 'Settings of “{name}”', { name: def.title ?? def.id }),
      body: h('div', { class: 'cn-dialog' }, h('div', { class: 'f-field' }, h('label', null, t('connections', 'Title')), title), form.el, result, error),
      buttons: [
        // Checking keeps the dialog open: its answer is shown inside.
        { label: t('connections', 'Check'), value: false, left: true, check: async () => (await this.check(def.plugin, def.source, settingsNow(), result), false) },
        { label: t('dialog', 'Cancel'), value: false },
        { label: t('connections', 'Save and reconnect'), value: true, primary: true, check: () => ((error.textContent = form.check() ?? ''), !error.textContent) },
      ],
      cancel: false,
    });
    if (ok !== true) return;
    const { settings, secrets } = form.read();
    try {
      await idb.set('secrets', this.wsKey(def.id), secrets);
      await this.shell.session.change((c) => {
        const target = c.connections.find((x) => x.id === def.id);
        if (!target) return;
        target.settings = settings;
        if (title.value.trim()) target.title = title.value.trim();
        else delete target.title;
      });
      const next = this.shell.session.config.connections.find((x) => x.id === def.id);
      if (next) await this.connectAndRefresh(next);
    } catch (e) {
      this.shell.fail(e);
    }
  }

  private async connectAndRefresh(def: ConnectionDef): Promise<void> {
    this.busy.add(def.id);
    this.render();
    try {
      await this.shell.session.connect(def);
      this.shell.data.changed(this.tablesOf(def.id).map((tb) => tb.name));
      const entry = this.shell.session.connections.get(def.id);
      if (entry?.remote) toast(t('connections', '“{name}” is connected', { name: def.title ?? def.id }), 'ok');
      else toast(t('connections', '“{name}” did not connect: {error}', { name: def.title ?? def.id, error: entry?.error ?? '' }), 'error');
    } finally {
      this.busy.delete(def.id);
      this.render();
    }
  }

  private async add(): Promise<void> {
    let sources: Awaited<ReturnType<Shell['registry']['dataSources']>>;
    try {
      sources = await this.shell.registry.dataSources();
    } catch (error) {
      return this.shell.fail(error);
    }
    if (!sources.length) return alertDialog(t('connections', 'Add connection'), t('connections', 'No plugin offers a data source. Install or switch on one in the plugin manager.'));
    const config = this.shell.session.config;
    const taken = config.connections.map((c) => c.id);
    const sourceSel = h('select', { class: 'input', 'data-new': 'source' }, sources.map((s, i) => h('option', { value: String(i) }, `${s.title} (${s.plugin.id})`)));
    const idInput = h('input', { class: 'input mono', 'data-new': 'id' });
    const titleInput = h('input', { class: 'input', 'data-new': 'title' });
    const help = h('div', { class: 'help' });
    const host = h('div');
    const result = h('div', { class: 'cn-check' });
    const error = h('div', { class: 'field-error' });
    let form = settingsForm([], {}, {});
    let touched = false;
    const pick = () => {
      const s = sources[Number(sourceSel.value)]!;
      form = settingsForm(s.settings ?? [], {}, {});
      clear(host, form.el);
      clear(result);
      help.textContent = s.description ?? '';
      if (!touched) {
        idInput.value = uniqueName(taken, identFrom(s.name, false));
        titleInput.value = s.title;
      }
    };
    idInput.addEventListener('input', () => (touched = true));
    sourceSel.addEventListener('change', pick);
    pick();
    const settingsNow = () => {
      const r = form.read();
      return { ...r.settings, ...r.secrets };
    };
    const ok = await dialog({
      title: t('connections', 'Add connection'),
      body: h(
        'div',
        { class: 'cn-dialog' },
        h('div', { class: 'f-field' }, h('label', null, t('connections', 'Data source')), h('div', { class: 'col cn-control' }, sourceSel, help)),
        h('div', { class: 'f-field' }, h('label', null, t('connections', 'Id')), h('div', { class: 'col cn-control' }, idInput, h('div', { class: 'help' }, t('connections', 'Tables name their connection by it; it cannot be changed later')))),
        h('div', { class: 'f-field' }, h('label', null, t('connections', 'Title')), titleInput),
        host,
        result,
        error,
      ),
      buttons: [
        { label: t('connections', 'Check'), value: false, left: true, check: async () => (await this.check(sources[Number(sourceSel.value)]!.plugin.id, sources[Number(sourceSel.value)]!.name, settingsNow(), result), false) },
        { label: t('dialog', 'Cancel'), value: false },
        {
          label: t('connections', 'Add'),
          value: true,
          primary: true,
          check: () => {
            const id = idInput.value.trim();
            if (!IDENT.test(id)) error.textContent = t('connections', 'The id must be a Latin identifier: letters, digits, _');
            else if (taken.includes(id)) error.textContent = t('connections', 'There is already a connection “{id}”', { id });
            else error.textContent = form.check() ?? '';
            return !error.textContent;
          },
        },
      ],
      cancel: false,
    });
    if (!ok) return;
    const s = sources[Number(sourceSel.value)]!;
    const { settings, secrets } = form.read();
    const def: ConnectionDef = { id: idInput.value.trim(), plugin: s.plugin.id, source: s.name, settings, ...(titleInput.value.trim() ? { title: titleInput.value.trim() } : {}) };
    try {
      if (Object.keys(secrets).length) await idb.set('secrets', this.wsKey(def.id), secrets);
      await this.shell.session.change((c) => c.connections.push(def));
      await this.connectAndRefresh(def);
    } catch (e) {
      this.shell.fail(e);
    }
  }

  private async remove(def: ConnectionDef): Promise<void> {
    const users = this.shell.session.config.tables.filter((tb) => tb.connection === def.id);
    if (users.length) return alertDialog(t('connections', 'Cannot delete'), t('connections', '“{name}” holds the tables: {tables}. Move them to another connection or delete them first.', { name: def.title ?? def.id, tables: users.map((tb) => tb.title).join(', ') }));
    if (!(await confirm(t('connections', 'Delete the connection'), t('connections', 'Delete “{name}”? The data stays in the source; only the connection is forgotten.', { name: def.title ?? def.id }), t('connections', 'Delete'), true))) return;
    try {
      await this.shell.session.change((c) => (c.connections = c.connections.filter((x) => x.id !== def.id)));
      const entry = this.shell.session.connections.get(def.id);
      await entry?.remote?.close().catch(() => {});
      this.shell.session.connections.delete(def.id);
      this.shell.data.unlink(def.id);
      await idb.delete('secrets', this.wsKey(def.id)).catch(() => {});
      this.shell.session.emit('connections');
    } catch (e) {
      this.shell.fail(e);
    }
  }

  /* ------------------------------ importing an external schema ------------------------------ */

  private async importTables(def: ConnectionDef): Promise<void> {
    const remote = this.remote(def.id);
    if (!remote) return;
    let tables: ExternalTable[];
    try {
      tables = (await remote.describe()).tables;
    } catch (error) {
      return this.shell.fail(error, def.title ?? def.id);
    }
    const config = this.shell.session.config;
    if (!tables.length) return alertDialog(t('connections', 'Import tables'), t('connections', 'The source describes no tables.'));
    const boxes = new Map<string, HTMLInputElement>();
    const rows = tables.map((et) => {
      const exists = !!tableOf(config, et.name);
      const bad = !IDENT.test(et.name);
      const box = h('input', { type: 'checkbox', 'data-import': et.name });
      box.checked = !exists && !bad;
      box.disabled = exists || bad;
      boxes.set(et.name, box);
      return h(
        'label',
        { class: `cn-import-row${box.disabled ? ' disabled' : ''}` },
        box,
        h('span', null, et.title ?? et.name),
        h('span', { class: 'mono muted' }, et.name),
        h('span', { class: 'muted' }, t('connections', '{n} fields', { n: et.fields.length })),
        exists ? h('span', { class: 'cn-tag' }, t('connections', 'already there')) : bad ? h('span', { class: 'cn-tag' }, t('connections', 'name is not an identifier')) : null,
      );
    });
    const menuBox = h('input', { type: 'checkbox' });
    menuBox.checked = true;
    const ok = await dialog({
      title: t('connections', 'Import tables from “{name}”', { name: def.title ?? def.id }),
      body: h(
        'div',
        { class: 'cn-dialog' },
        h('p', { class: 'muted' }, remote.caps.write ? t('connections', 'The ticked tables are added to the configuration; their records stay in the source.') : t('connections', 'The ticked tables are added read-only: this source does not accept writes.')),
        h('div', { class: 'cn-import' }, rows),
        config.menu.length ? h('label', { class: 'row', style: { marginTop: '8px' } }, menuBox, t('connections', 'Add them to the menu')) : null,
      ),
      buttons: [
        { label: t('dialog', 'Cancel'), value: false },
        { label: t('connections', 'Import'), value: true, primary: true },
      ],
      cancel: false,
    });
    if (!ok) return;
    const chosen = tables.filter((et) => boxes.get(et.name)?.checked);
    if (!chosen.length) return;
    const known = new Set([...config.tables.map((tb) => tb.name), ...chosen.map((et) => et.name)]);
    const defs: TableDef[] = chosen.map((et) => {
      const fields: FieldDef[] = et.fields
        .filter((f) => IDENT.test(f.name) && f.name !== 'id' && f.name !== '_rev')
        .map((f) => {
          const mapped = fieldType(f, known);
          return { key: newKey('f'), name: f.name, ...(f.title ? { title: f.title } : {}), type: mapped.type, ...(mapped.scale !== undefined ? { scale: mapped.scale } : {}), ...(mapped.ref ? { ref: mapped.ref } : {}) };
        });
      return {
        key: newKey('t'),
        name: et.name,
        kind: 'table',
        title: et.title ?? et.name,
        icon: 'table',
        connection: def.id,
        fields,
        ...(et.key && et.key !== 'id' ? { sourceKey: et.key } : {}),
        ...(remote.caps.write ? {} : { readOnly: true }),
      };
    });
    try {
      await this.shell.session.change((c) => {
        c.tables.push(...defs);
        if (menuBox.checked && c.menu.length) {
          const section: MenuNode = { key: newKey('m'), title: def.title ?? def.id, icon: 'database', children: defs.map((tb) => ({ key: newKey('m'), title: tb.title, icon: 'table', target: { kind: 'table', name: tb.name } })) };
          c.menu.push(section);
        }
      });
      toast(t('connections', '{n} tables imported', { n: defs.length }), 'ok');
    } catch (e) {
      this.shell.fail(e);
    }
  }

  /* ------------------------------ copying data ------------------------------ */

  private async copyData(def: ConnectionDef): Promise<void> {
    const config = this.shell.session.config;
    const targets = config.connections.filter((c) => c.id !== def.id && this.remote(c.id)?.caps.write);
    const tables = this.tablesOf(def.id);
    if (!targets.length || !tables.length) return;
    const targetSel = h('select', { class: 'input', 'data-copy': 'target' }, targets.map((c) => h('option', { value: c.id }, `${c.title ?? c.id} (${c.id})`)));
    const boxes = tables.map((tb) => {
      const box = h('input', { type: 'checkbox', 'data-copy-table': tb.name });
      box.checked = true;
      return { tb, box };
    });
    const switchBox = h('input', { type: 'checkbox', 'data-copy': 'switch' });
    const ok = await dialog({
      title: t('connections', 'Copy the data of “{name}”', { name: def.title ?? def.id }),
      body: h(
        'div',
        { class: 'cn-dialog' },
        h('div', { class: 'f-field' }, h('label', null, t('connections', 'Into')), targetSel),
        h('div', { class: 'cn-import' }, boxes.map(({ tb, box }) => h('label', { class: 'cn-import-row' }, box, icon(tb.icon ?? 'table', 14), h('span', null, tb.title), h('span', { class: 'mono muted' }, tb.name)))),
        h('label', { class: 'row', style: { marginTop: '8px' } }, switchBox, t('connections', 'Then keep these tables in the target connection')),
        h('p', { class: 'muted' }, t('connections', 'Records already in the target (the same id) are skipped. Nothing is deleted from either side.')),
      ),
      buttons: [
        { label: t('dialog', 'Cancel'), value: false },
        { label: t('connections', 'Copy'), value: true, primary: true },
      ],
      cancel: false,
    });
    if (!ok) return;
    const targetId = targetSel.value;
    const target = this.remote(targetId);
    const chosen = boxes.filter((b) => b.box.checked).map((b) => b.tb);
    if (!target || !chosen.length) return;
    this.busy.add(def.id);
    this.render();
    let copied = 0;
    let skipped = 0;
    try {
      for (const tb of chosen) {
        this.shell.status(t('connections', 'Copying {table}…', { table: tb.title }));
        if (target.caps.schema === 'managed') await target.applySchema([{ op: 'createTable', table: tb.name }]).catch(() => {});
        const rows = await this.shell.data.all(tb.name);
        const existing = new Set((await target.query({ table: tb.name, select: ['id'] }).catch(() => ({ rows: [] as Row[] }))).rows.map((r) => r.id));
        const ops: BatchOp[] = [];
        for (const r of rows) {
          if (existing.has(r.id)) {
            skipped++;
            continue;
          }
          const { _rev, ...row } = r;
          void _rev;
          ops.push({ op: 'insert', table: tb.name, row: row as Row });
        }
        for (let i = 0; i < ops.length; i += CHUNK) {
          const chunk = ops.slice(i, i + CHUNK);
          if (target.caps.batch) await target.batch(chunk);
          else for (const op of chunk) if (op.op === 'insert') await target.insert(op.table, op.row);
          copied += chunk.length;
          this.shell.status(t('connections', 'Copying {table}: {done} of {total}', { table: tb.title, done: Math.min(i + CHUNK, ops.length), total: ops.length }));
        }
      }
      if (switchBox.checked) {
        await this.shell.session.change((c) => {
          for (const tb of c.tables) if (chosen.some((x) => x.key === tb.key)) tb.connection = targetId;
        });
        this.shell.data.changed(chosen.map((tb) => tb.name));
      }
      this.shell.status('');
      toast(t('connections', '{n} records copied, {m} already there', { n: copied, m: skipped }), 'ok');
    } catch (error) {
      this.shell.status('');
      this.shell.fail(error, t('connections', 'Copying stopped after {n} records', { n: copied }));
    } finally {
      this.busy.delete(def.id);
      this.render();
    }
  }
}
