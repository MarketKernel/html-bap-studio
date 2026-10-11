/**
 * Plugins on the page's side (Task.md 5.2–5.3): the registry of what is
 * installed and trusted, a worker per running plugin, and connections that
 * forward every call to their worker.
 *
 * A plugin from a file is first started with no network at all to read its
 * manifest; only once the user approves it — and exactly the hosts it asked
 * for — is it started for real. A plugin whose code changed (another SHA-256)
 * is not started again until approved again.
 */
import { t } from '../../core/i18n';
import {
  checkManifest,
  fromWireError,
  normalizeCapabilities,
  PluginError,
  type BatchOp,
  type BatchResult,
  type Capabilities,
  type Change,
  type Connection,
  type ExternalTable,
  type FileRef,
  type FromWorker,
  type PluginDescription,
  type PluginReportResult,
  type SchemaChange,
  type ToWorker,
  toWireError,
} from '../../core/plugin-protocol';
import type { AggregateQuery, Query, QueryResult, Row } from '../../core/query/types';
import { idb } from '../storage';

export interface InstalledPlugin {
  id: string;
  origin: 'builtin' | 'file' | 'folder';
  code: string;
  hash: string;
  fileName?: string;
  /** The hash the user approved; a builtin is approved by being built in. */
  trustedHash?: string;
  /** The hosts as approved. */
  hosts: string[];
  /** Approved to read the application's data (manifest.permissions.data). */
  data?: boolean;
  enabled: boolean;
  name?: string;
  version?: string;
  installedAt?: string;
}

export interface LogLine {
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const DEFAULT_TIMEOUT = 30_000;
const LONG_TIMEOUT = 120_000;

let runtimeUrl: string | null = null;

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One running plugin. */
export class PluginWorker {
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  crashed: string | null = null;
  description: PluginDescription | null = null;
  readonly log: LogLine[] = [];
  onChanges: ((connection: string, changes: Change[]) => void) | null = null;
  onLog: ((line: LogLine) => void) | null = null;
  onProgress: ((fraction: number | null, text?: string) => void) | null = null;
  /** Answers the plugin's requests for the application's data. */
  onData: ((method: string, args: unknown[]) => Promise<unknown>) | null = null;

  constructor(readonly id: string) {
    runtimeUrl ??= URL.createObjectURL(new Blob([__WORKER_RUNTIME__], { type: 'text/javascript' }));
    this.worker = new Worker(runtimeUrl, { name: `plugin:${id}` });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(event.message || 'The plugin worker failed');
    };
    this.worker.onmessageerror = () => this.fail('A message from the plugin could not be read');
  }

  private push(level: LogLine['level'], message: string) {
    const line = { time: new Date().toISOString(), level, message };
    this.log.push(line);
    if (this.log.length > 500) this.log.shift();
    this.onLog?.(line);
  }

  private fail(message: string) {
    this.crashed = message;
    this.push('error', message);
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new PluginError('internal', message));
    }
    this.waiting.clear();
  }

  private receive(message: FromWorker) {
    if (message.kind === 'result' || message.kind === 'error') {
      const w = this.waiting.get(message.id);
      if (!w) return;
      this.waiting.delete(message.id);
      clearTimeout(w.timer);
      if (message.kind === 'result') w.resolve(message.value);
      else w.reject(fromWireError(message.error));
    } else if (message.kind === 'log') this.push(message.level, message.message);
    else if (message.kind === 'progress') this.onProgress?.(message.fraction, message.text);
    else if (message.kind === 'changes') this.onChanges?.(message.connection, message.changes);
    else if (message.kind === 'data') {
      const answer = this.onData ? this.onData(message.method, message.args) : Promise.reject(new PluginError('forbidden', 'No data here'));
      answer.then(
        (value) => this.worker.postMessage({ kind: 'dataResult', id: message.id, value } as ToWorker),
        (error: unknown) => this.worker.postMessage({ kind: 'dataResult', id: message.id, error: toWireError(error) } as ToWorker),
      );
    }
  }

  request(message: DistributiveOmit<ToWorker, 'id'>, timeout = DEFAULT_TIMEOUT): Promise<unknown> {
    if (this.crashed) return Promise.reject(new PluginError('internal', this.crashed));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        this.push('warn', `No answer in ${timeout / 1000} s to ${message.kind}${message.kind === 'call' ? ` ${message.method}` : ''}`);
        reject(new PluginError('timeout', t('plugins', 'The plugin did not answer in time')));
      }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...message, id } as ToWorker);
    });
  }

  async init(code: string, hosts: string[] | null, data = false): Promise<PluginDescription> {
    this.description = (await this.request({ kind: 'init', code, hosts, pluginId: this.id, data }, LONG_TIMEOUT)) as PluginDescription;
    return this.description;
  }

  terminate() {
    this.worker.terminate();
    this.fail('Stopped');
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** A data source connection that lives in a plugin's worker. */
export class RemoteConnection implements Connection {
  caps: Capabilities;
  constructor(
    private readonly worker: PluginWorker,
    readonly name: string,
    caps: Capabilities,
  ) {
    this.caps = caps;
  }
  private call<T>(method: string, args: unknown[], timeout = DEFAULT_TIMEOUT): Promise<T> {
    return this.worker.request({ kind: 'call', connection: this.name, method, args }, timeout) as Promise<T>;
  }
  capabilities(): Capabilities {
    return this.caps;
  }
  describe() {
    return this.call<{ tables: ExternalTable[] }>('describe', []);
  }
  applySchema(changes: SchemaChange[]) {
    return this.call<void>('applySchema', [changes], LONG_TIMEOUT);
  }
  loadConfig() {
    return this.call<{ doc: unknown; rev: string } | null>('loadConfig', []);
  }
  saveConfig(doc: unknown, expectedRev: string | null) {
    return this.call<{ rev: string }>('saveConfig', [doc, expectedRev]);
  }
  query(q: Query) {
    return this.call<QueryResult>('query', [q], LONG_TIMEOUT);
  }
  get(table: string, id: string) {
    return this.call<Row | null>('get', [table, id]);
  }
  insert(table: string, row: Row) {
    return this.call<Row>('insert', [table, row]);
  }
  update(table: string, id: string, patch: Record<string, unknown>, expectedRev?: string) {
    return this.call<Row>('update', [table, id, patch, expectedRev]);
  }
  delete(table: string, id: string, expectedRev?: string) {
    return this.call<void>('delete', [table, id, expectedRev]);
  }
  batch(ops: BatchOp[]) {
    return this.call<BatchResult>('batch', [ops], LONG_TIMEOUT);
  }
  aggregate(q: AggregateQuery) {
    return this.call<{ rows: Record<string, unknown>[] }>('aggregate', [q], LONG_TIMEOUT);
  }
  nextNumber(sequence: string) {
    return this.call<number>('nextNumber', [sequence]);
  }
  putFile(blob: Blob, meta: { name: string; type: string }) {
    return this.call<FileRef>('putFile', [blob, meta], LONG_TIMEOUT);
  }
  getFile(ref: FileRef) {
    return this.call<Blob>('getFile', [ref], LONG_TIMEOUT);
  }
  async close() {
    await this.worker.request({ kind: 'disconnect', connection: this.name }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

export class PluginRegistry {
  readonly plugins = new Map<string, InstalledPlugin>();
  private workers = new Map<string, Promise<PluginWorker>>();
  readonly running = new Map<string, PluginWorker>();
  /** Every log line of every plugin, for the manager and the status bar. */
  onLog: ((plugin: string, line: LogLine) => void) | null = null;
  onChanges: ((connection: string, changes: Change[]) => void) | null = null;
  onProgress: ((fraction: number | null, text?: string) => void) | null = null;
  /** The application's data, for the plugins approved to read it. */
  onData: ((plugin: string, method: string, args: unknown[]) => Promise<unknown>) | null = null;

  async load(): Promise<void> {
    for (const { id, code } of __BUILTIN_PLUGINS__) {
      const hash = await sha256(code);
      this.plugins.set(id, { id, origin: 'builtin', code, hash, trustedHash: hash, hosts: [], enabled: true });
    }
    for (const [id, plugin] of await idb.all<InstalledPlugin>('plugins').catch(() => [] as [string, InstalledPlugin][])) {
      // A builtin can be switched off, not replaced.
      const builtin = this.plugins.get(id);
      if (builtin) builtin.enabled = plugin.enabled;
      else this.plugins.set(id, plugin);
    }
  }

  private persist(plugin: InstalledPlugin) {
    if (plugin.origin === 'builtin') return idb.set('plugins', plugin.id, { id: plugin.id, origin: 'builtin', enabled: plugin.enabled });
    return idb.set('plugins', plugin.id, plugin);
  }

  trusted(plugin: InstalledPlugin): boolean {
    return plugin.trustedHash === plugin.hash;
  }

  /** Starts (once) and returns the plugin's worker. */
  start(id: string): Promise<PluginWorker> {
    const plugin = this.plugins.get(id);
    if (!plugin) return Promise.reject(new PluginError('not_found', t('plugins', 'Plugin “{id}” is not installed', { id })));
    if (!plugin.enabled) return Promise.reject(new PluginError('forbidden', t('plugins', 'Plugin “{id}” is switched off', { id })));
    if (!this.trusted(plugin)) return Promise.reject(new PluginError('forbidden', t('plugins', 'Plugin “{id}” changed and must be approved again', { id })));
    let started = this.workers.get(id);
    if (started && this.running.get(id)?.crashed) {
      this.stop(id);
      started = undefined;
    }
    if (!started) {
      started = (async () => {
        const worker = new PluginWorker(id);
        worker.onLog = (line) => this.onLog?.(id, line);
        worker.onChanges = (connection, changes) => this.onChanges?.(connection, changes);
        worker.onProgress = (f, text) => this.onProgress?.(f, text);
        worker.onData = (method, args) => (this.onData ? this.onData(id, method, args) : Promise.reject(new PluginError('forbidden', 'No data here')));
        try {
          // A built-in plugin is trusted with what its manifest asks for; another, with what the person approved.
          const data = plugin.origin === 'builtin' ? true : plugin.data === true;
          const description = await worker.init(plugin.code, plugin.origin === 'builtin' ? null : plugin.hosts, data);
          plugin.name = description.manifest.name;
          plugin.version = description.manifest.version;
          if (plugin.origin === 'builtin') plugin.hosts = [...(description.manifest.permissions?.hosts ?? [])];
        } catch (error) {
          worker.terminate();
          this.workers.delete(id);
          throw error;
        }
        this.running.set(id, worker);
        return worker;
      })();
      this.workers.set(id, started);
    }
    return started;
  }

  stop(id: string): void {
    this.running.get(id)?.terminate();
    this.running.delete(id);
    this.workers.delete(id);
  }

  async connect(name: string, pluginId: string, source: string, settings: Record<string, unknown>): Promise<RemoteConnection> {
    const worker = await this.start(pluginId);
    await worker.request({ kind: 'connect', connection: name, source, settings }, LONG_TIMEOUT);
    const caps = normalizeCapabilities(await worker.request({ kind: 'call', connection: name, method: 'capabilities', args: [] }));
    return new RemoteConnection(worker, name, caps);
  }

  /**
   * Reads a plugin's manifest without letting it reach anything: a worker
   * with no hosts, stopped right after.
   */
  async inspect(code: string): Promise<PluginDescription> {
    const worker = new PluginWorker('inspect');
    try {
      const description = await worker.init(code, []);
      const problems = checkManifest(description.manifest);
      if (problems.length) throw new PluginError('validation', problems.join('; '));
      return description;
    } finally {
      worker.terminate();
    }
  }

  /** Installs or updates a plugin the user has approved after inspect(). */
  async install(code: string, description: PluginDescription, origin: 'file' | 'folder', fileName?: string): Promise<InstalledPlugin> {
    const id = description.manifest.id;
    const existing = this.plugins.get(id);
    if (existing?.origin === 'builtin') throw new PluginError('validation', t('plugins', 'A built-in plugin has the id “{id}”', { id }));
    const hash = await sha256(code);
    const plugin: InstalledPlugin = {
      id,
      origin,
      code,
      hash,
      trustedHash: hash,
      hosts: [...(description.manifest.permissions?.hosts ?? [])],
      ...(description.manifest.permissions?.data === 'read' ? { data: true } : {}),
      enabled: true,
      name: description.manifest.name,
      version: description.manifest.version,
      installedAt: new Date().toISOString(),
      ...(fileName ? { fileName } : {}),
    };
    this.stop(id);
    this.plugins.set(id, plugin);
    await this.persist(plugin);
    return plugin;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    plugin.enabled = enabled;
    if (!enabled) this.stop(id);
    await this.persist(plugin);
  }

  async remove(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin || plugin.origin === 'builtin') return;
    this.stop(id);
    this.plugins.delete(id);
    await idb.delete('plugins', id);
  }

  /** Runs a plugin's report. */
  async report(pluginId: string, report: string, params: Record<string, unknown>): Promise<PluginReportResult> {
    const worker = await this.start(pluginId);
    return (await worker.request({ kind: 'report', report, params }, LONG_TIMEOUT)) as PluginReportResult;
  }

  /** The reports of every enabled, trusted plugin: for the report designer. */
  async reports(): Promise<{ plugin: string; pluginName: string; name: string; title: string }[]> {
    const out = [];
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled || !this.trusted(plugin)) continue;
      try {
        const worker = await this.start(plugin.id);
        for (const r of worker.description?.reports ?? []) out.push({ plugin: plugin.id, pluginName: plugin.name ?? plugin.id, ...r });
      } catch {
        // A broken plugin offers nothing here.
      }
    }
    return out;
  }

  /** Data sources of every enabled plugin, for the connection dialog; starts trusted plugins to learn them. */
  async dataSources(): Promise<{ plugin: InstalledPlugin; name: string; title: string; description?: string; settings: PluginDescription['dataSources'][number]['settings'] }[]> {
    const out = [];
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled || !this.trusted(plugin)) continue;
      try {
        const worker = await this.start(plugin.id);
        for (const ds of worker.description?.dataSources ?? []) out.push({ plugin, ...ds });
      } catch {
        // A broken plugin is shown as such in the manager; here it simply offers nothing.
      }
    }
    return out;
  }
}
