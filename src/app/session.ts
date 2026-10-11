/**
 * The open workspace: its configuration, its connections and the DataService
 * over them, and the configuration's history for undo and redo.
 *
 * A workspace is where a configuration lives: a data source (a plugin's, with
 * settings). Its connection is the configuration's first one, `main`; the
 * configuration may name more (each table picks its own, Task.md 9.6).
 */
import { t } from '../core/i18n';
import { cloneConfig } from '../core/config/model';
import { migrate, validateConfig } from '../core/config/validate';
import { schemaDiff } from '../core/config/diff';
import { FORMAT_VERSION, type Config, type ConnectionDef } from '../core/config/types';
import { DataService } from '../core/data';
import { installPosting } from '../core/registers';
import { installTriggers } from '../core/actions';
import { PluginError } from '../core/plugin-protocol';
import { PluginRegistry, type RemoteConnection } from './plugins/host';
import { idb } from './storage';
import { settings, saveSettings, type Workspace } from './settings';
import { answerData } from './plugins/data';

type Event = 'config' | 'connections' | 'mode' | 'dirty';

type PermissionHandle = FileSystemHandle & { queryPermission?(d: { mode: string }): Promise<string>; requestPermission?(d: { mode: string }): Promise<string> };

/**
 * Settings that are not JSON — the file handle of a `json-file` workspace —
 * cannot live in localStorage with the rest; they are kept in IndexedDB.
 */
export async function saveHandles(workspaceId: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const plain: Record<string, unknown> = {};
  const handles: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) (typeof FileSystemHandle !== 'undefined' && v instanceof FileSystemHandle ? handles : plain)[k] = v;
  if (Object.keys(handles).length) await idb.set('handles', `ws:${workspaceId}`, handles);
  return plain;
}

/** A workspace's file handles, with permission to write — asked for when not granted yet (needs a click). */
async function workspaceHandles(workspaceId: string): Promise<Record<string, unknown>> {
  const handles = (await idb.get<Record<string, unknown>>('handles', `ws:${workspaceId}`).catch(() => undefined)) ?? {};
  for (const [name, value] of Object.entries(handles)) {
    const handle = value as PermissionHandle;
    let state = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
    if (state !== 'granted') state = (await handle.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied')) ?? 'denied';
    if (state !== 'granted') throw new PluginError('forbidden', t('session', 'Allow access to the file “{name}” to open it', { name: handle.name ?? name }));
  }
  return handles;
}

export class Session {
  data: DataService;
  config: Config;
  rev: string | null = null;
  mode: 'run' | 'design' = 'run';
  readonly connections = new Map<string, { def: ConnectionDef; remote: RemoteConnection | null; error: string | null }>();
  private undoStack: Config[] = [];
  private redoStack: Config[] = [];
  private listeners = new Map<Event, Set<() => void>>();
  /** The configuration differs from the saved revision. */
  dirty = false;

  constructor(
    readonly registry: PluginRegistry,
    readonly workspace: Workspace,
    config: Config,
  ) {
    this.config = config;
    this.data = new DataService(config, { user: () => settings.user, now: () => new Date() });
    installPosting(this.data);
    installTriggers(this.data);
    registry.onChanges = (connection, changes) => {
      if (this.connections.has(connection)) this.data.changed([...new Set(changes.map((c) => c.table))]);
    };
    // Plugins that compute reports, and read the data to do it.
    this.data.pluginReport = (plugin, report, params) => registry.report(plugin, report, params);
    registry.onData = (_plugin, method, args) => answerData(this.data, method, args);
  }

  on(event: Event, fn: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(event: Event): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  /** Opens a workspace: its connection, its configuration, then every other connection. */
  static async open(registry: PluginRegistry, workspace: Workspace): Promise<Session> {
    const secrets = (await idb.get<Record<string, unknown>>('secrets', `ws:${workspace.id}`).catch(() => undefined)) ?? {};
    const handles = await workspaceHandles(workspace.id);
    const main = await registry.connect('main', workspace.plugin, workspace.source, { ...workspace.settings, ...secrets, ...handles });
    const stored = await main.loadConfig().catch((error: unknown) => {
      if (error instanceof PluginError && error.code === 'unsupported') return null;
      throw error;
    });
    if (!stored) throw new PluginError('not_found', t('session', 'There is no application in this data source yet'));
    const config = migrate(stored.doc);
    const session = new Session(registry, workspace, config);
    session.rev = stored.rev;
    session.attach('main', main, config.connections.find((c) => c.id === 'main') ?? { id: 'main', plugin: workspace.plugin, source: workspace.source, settings: {} });
    await session.connectOthers();
    workspace.openedAt = new Date().toISOString();
    settings.lastWorkspace = workspace.id;
    saveSettings();
    return session;
  }

  /** Creates a workspace in a data source and stores `config` there. */
  static async create(registry: PluginRegistry, workspace: Workspace, config: Config): Promise<Session> {
    const handles = await workspaceHandles(workspace.id);
    const main = await registry.connect('main', workspace.plugin, workspace.source, { ...workspace.settings, ...handles });
    const existing = await main.loadConfig().catch(() => null);
    config.connections = [{ id: 'main', title: t('session', 'Main'), plugin: workspace.plugin, source: workspace.source, settings: {} }, ...config.connections.filter((c) => c.id !== 'main')];
    const { rev } = await main.saveConfig(config, existing?.rev ?? null);
    const session = new Session(registry, workspace, config);
    session.rev = rev;
    session.attach('main', main, config.connections[0]!);
    await session.connectOthers();
    settings.workspaces = [workspace, ...settings.workspaces.filter((w) => w.id !== workspace.id)];
    settings.lastWorkspace = workspace.id;
    saveSettings();
    return session;
  }

  private attach(id: string, remote: RemoteConnection, def: ConnectionDef) {
    this.connections.set(id, { def, remote, error: null });
    this.data.link(id, remote, remote.caps);
  }

  async connectOthers(): Promise<void> {
    for (const def of this.config.connections) {
      if (def.id === 'main' || this.connections.get(def.id)?.remote) continue;
      await this.connect(def);
    }
    this.emit('connections');
  }

  async connect(def: ConnectionDef): Promise<void> {
    try {
      const secrets = (await idb.get<Record<string, unknown>>('secrets', `conn:${this.workspace.id}:${def.id}`).catch(() => undefined)) ?? {};
      const remote = await this.registry.connect(`${def.id}`, def.plugin, def.source, { ...def.settings, ...secrets });
      this.attach(def.id, remote, def);
    } catch (error) {
      this.connections.set(def.id, { def, remote: null, error: error instanceof Error ? error.message : String(error) });
      this.data.unlink(def.id);
    }
    this.emit('connections');
  }

  async reconnect(id: string): Promise<void> {
    const entry = this.connections.get(id);
    if (!entry) return;
    if (id === 'main') {
      const secrets = (await idb.get<Record<string, unknown>>('secrets', `ws:${this.workspace.id}`).catch(() => undefined)) ?? {};
      // Connecting again replaces the old connection inside the worker; other connections to the
      // same plugin keep theirs. A crashed worker is restarted by the registry.
      const handles = await workspaceHandles(this.workspace.id);
      const remote = await this.registry.connect('main', this.workspace.plugin, this.workspace.source, { ...this.workspace.settings, ...secrets, ...handles });
      this.attach('main', remote, entry.def);
    } else await this.connect(entry.def);
    this.data.changed(this.config.tables.map((tb) => tb.name));
    this.emit('connections');
  }

  /* ---------------------------------------------------------------- *
   * The configuration
   * ---------------------------------------------------------------- */

  /**
   * Applies a change to the configuration: it is checked, the schema change it
   * makes is applied to the managed sources, and it is saved as a new revision.
   * `change` gets a copy; the session's config is replaced only on success.
   */
  async change(change: (draft: Config) => void, opts: { save?: boolean } = {}): Promise<Config> {
    const before = this.config;
    const draft = cloneConfig(before);
    change(draft);
    draft.formatVersion = FORMAT_VERSION;
    await this.replace(draft, before, opts.save !== false);
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    return draft;
  }

  private async replace(next: Config, before: Config, save: boolean): Promise<void> {
    const changes = schemaDiff(before, next);
    if (changes.length) {
      for (const [id, entry] of this.connections) {
        if (!entry.remote || entry.remote.caps.schema !== 'managed') continue;
        const mine = changes.filter((c) => {
          const tableName = 'table' in c ? c.table : c.op === 'renameTable' ? c.to : '';
          const tb = next.tables.find((x) => x.name === tableName) ?? before.tables.find((x) => x.name === tableName || (c.op === 'renameTable' && x.name === c.from));
          return (tb?.connection ?? 'main') === id || (!tb?.connection && id === 'main');
        });
        if (mine.length) await entry.remote.applySchema(mine).catch((error: unknown) => {
          if (!(error instanceof PluginError && error.code === 'unsupported')) throw error;
        });
      }
    }
    this.config = next;
    this.data.setConfig(next);
    if (save) await this.save();
    else {
      this.dirty = true;
      this.emit('dirty');
    }
    this.emit('config');
  }

  async save(): Promise<void> {
    const main = this.connections.get('main')?.remote;
    if (!main) throw new PluginError('network', t('session', 'The main data source is not connected'));
    const { rev } = await main.saveConfig(this.config, this.rev);
    this.rev = rev;
    this.config.rev = rev;
    this.dirty = false;
    this.emit('dirty');
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  async undo(): Promise<void> {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.config);
    await this.replace(cloneConfig(previous), this.config, true);
  }

  async redo(): Promise<void> {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.config);
    await this.replace(cloneConfig(next), this.config, true);
  }

  problems() {
    return validateConfig(this.config);
  }

  async close(): Promise<void> {
    for (const entry of this.connections.values()) await entry.remote?.close().catch(() => {});
    this.connections.clear();
  }
}
