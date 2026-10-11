/**
 * Runs inside a plugin's worker, before and around the plugin (Task.md 5.3).
 *
 * The build bundles this file into a string; the page starts a classic worker
 * from a blob: URL of it. On 'init' it locks the network down to the hosts the
 * user approved, turns the plugin's source into a blob: URL of its own and
 * imports it — on file:// a blob made by the page cannot be imported here, nor
 * can a module worker be started at all (docs/notes/platform.md).
 *
 * The lock is a guard against mistakes, not against a plugin set on harm: the
 * user trusts a plugin's code when they install it, as with a browser extension.
 */
import {
  checkManifest,
  hostAllowed,
  PluginError,
  toWireError,
  type ActionContribution,
  type Change,
  type Connection,
  type DataSourceFactory,
  type ExporterContribution,
  type FromWorker,
  type PluginDescription,
  type PluginHost,
  type PluginData,
  type PluginManifest,
  type ReportContribution,
  type ToWorker,
} from '../core/plugin-protocol';

interface PluginModule {
  manifest?: PluginManifest;
  dataSources?: Record<string, DataSourceFactory>;
  actions?: Record<string, ActionContribution>;
  exporters?: Record<string, ExporterContribution>;
  reports?: Record<string, ReportContribution>;
}

const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  fetch: typeof fetch;
};

const post = (message: FromWorker) => scope.postMessage(message);
const realFetch = scope.fetch.bind(scope);
let hosts: readonly string[] = [];
let pluginId = '';
let plugin: PluginModule = {};
const connections = new Map<string, Connection>();
/** Whether the person let this plugin read the application's data. */
let dataAllowed = false;
let dataSeq = 0;
const dataWaiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

/** Read-only access to the application's data, asked of the page and answered by it. */
const data: PluginData = Object.freeze<PluginData>({
  query: (q) => ask('query', [q]) as ReturnType<PluginData['query']>,
  movements: (register, to = null, from = null) => ask('movements', [register, to, from]) as ReturnType<PluginData['movements']>,
  config: () => ask('config', []),
  evaluate: (expression) => ask('evaluate', [expression]),
});

function ask(method: string, args: unknown[]): Promise<unknown> {
  if (!dataAllowed) return Promise.reject(new PluginError('forbidden', 'This plugin was not allowed to read the application’s data (manifest.permissions.data)'));
  const id = ++dataSeq;
  return new Promise((resolve, reject) => {
    dataWaiting.set(id, { resolve, reject });
    post({ kind: 'data', id, method, args });
  });
}

function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // The request is made once, from what fetch itself would make of the arguments, and that very
  // request is checked and sent: an object whose url getter or toString says one thing and does
  // another cannot slip past.
  let request: Request;
  try {
    request = new Request(input, init);
  } catch (error) {
    return Promise.reject(new PluginError('validation', `Not a request: ${error instanceof Error ? error.message : String(error)}`));
  }
  const url = request.url;
  if (!hostAllowed(url, hosts)) {
    const message = `Blocked a request to ${url}: the plugin may only reach ${hosts.length ? hosts.join(', ') : 'no hosts'}`;
    post({ kind: 'log', level: 'error', message });
    return Promise.reject(new PluginError('forbidden', message));
  }
  return realFetch(request).catch((error: unknown) => {
    throw new PluginError('network', `${url}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Replaces every way out of the worker. fetch lives on the global scope's
 * prototype too: deleting the own property would bring the real one back.
 */
function lockNetwork(): void {
  const blocked = (name: string) =>
    function blockedApi(): never {
      throw new PluginError('forbidden', `${name} is not available to plugins; use fetch`);
    };
  const replace = (target: object, name: string, value: unknown) => {
    try {
      Object.defineProperty(target, name, { value, writable: false, configurable: false });
    } catch {
      // Not configurable in this browser: the CSP still applies.
    }
  };
  const proto = Object.getPrototypeOf(self) as object;
  for (const target of [self, proto, Object.getPrototypeOf(proto) as object]) {
    if (target && 'fetch' in target) replace(target, 'fetch', guardedFetch);
  }
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport', 'caches']) {
    replace(self, name, blocked(name));
  }
}

/* A small key-value store per plugin, in IndexedDB. */
let storeDb: Promise<IDBDatabase> | null = null;
function openStore(): Promise<IDBDatabase> {
  storeDb ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(`bap-plugin-${pluginId}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return storeDb;
}
async function kv<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const request = run(db.transaction('kv', mode).objectStore('kv'));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

function hostFor(connection: string, settings: Record<string, unknown>): PluginHost {
  return {
    data,
    fetch: guardedFetch,
    settings,
    storage: {
      get: (key) => kv('readonly', (s) => s.get(key)),
      set: async (key, value) => void (await kv('readwrite', (s) => s.put(value, key))),
      delete: async (key) => void (await kv('readwrite', (s) => s.delete(key))),
    },
    log: (level, message) => post({ kind: 'log', level, message: String(message) }),
    progress: (fraction, text) => post(text === undefined ? { kind: 'progress', fraction } : { kind: 'progress', fraction, text }),
    emitChanges: (changes: Change[]) => post({ kind: 'changes', connection, changes }),
  };
}

function describe(module: PluginModule): PluginDescription {
  const manifest = module.manifest as PluginManifest;
  return {
    manifest: JSON.parse(JSON.stringify(manifest)) as PluginManifest,
    dataSources: Object.entries(module.dataSources ?? {}).map(([name, f]) => ({
      name,
      title: String(f.title ?? name),
      ...(f.description ? { description: String(f.description) } : {}),
      settings: JSON.parse(JSON.stringify(f.settings ?? [])),
    })),
    actions: Object.entries(module.actions ?? {}).map(([name, a]) => ({ name, title: String(a.title ?? name) })),
    exporters: Object.entries(module.exporters ?? {}).map(([name, e]) => ({ name, title: String(e.title ?? name), extension: String(e.extension ?? 'bin') })),
    reports: Object.entries(module.reports ?? {}).map(([name, r]) => ({ name, title: String(r.title ?? name) })),
  };
}

async function handle(message: ToWorker): Promise<unknown> {
  switch (message.kind) {
    case 'init': {
      pluginId = message.pluginId;
      hosts = Object.freeze([...(message.hosts ?? [])]);
      lockNetwork();
      const url = URL.createObjectURL(new Blob([message.code], { type: 'text/javascript' }));
      try {
        plugin = (await import(/* @vite-ignore */ url)) as PluginModule;
      } finally {
        URL.revokeObjectURL(url);
      }
      const problems = checkManifest(plugin.manifest);
      if (problems.length) throw new PluginError('validation', problems.join('; '));
      if (message.hosts === null) hosts = Object.freeze([...(plugin.manifest?.permissions?.hosts ?? [])]);
      // Asked for in the manifest and allowed by the person: both, or no data.
      dataAllowed = message.data === true && plugin.manifest?.permissions?.data === 'read';
      return describe(plugin);
    }
    case 'connect': {
      const factory = plugin.dataSources?.[message.source];
      if (!factory) throw new PluginError('not_found', `The plugin has no data source “${message.source}”`);
      const previous = connections.get(message.connection);
      if (previous?.close) await previous.close().catch(() => {});
      const connection = await factory.connect(message.settings, hostFor(message.connection, message.settings));
      connections.set(message.connection, connection);
      return true;
    }
    case 'call': {
      const connection = connections.get(message.connection);
      if (!connection) throw new PluginError('not_found', 'Not connected');
      const method = (connection as unknown as Record<string, unknown>)[message.method];
      if (typeof method !== 'function') throw new PluginError('unsupported', `The data source does not implement ${message.method}()`);
      return await (method as (...args: unknown[]) => unknown).apply(connection, message.args);
    }
    case 'disconnect': {
      const connection = connections.get(message.connection);
      connections.delete(message.connection);
      if (connection?.close) await connection.close();
      return true;
    }
    case 'action': {
      const action = plugin.actions?.[message.action];
      if (!action) throw new PluginError('not_found', `The plugin has no action “${message.action}”`);
      return await action.run(message.args, hostFor('', {}));
    }
    case 'report': {
      const report = plugin.reports?.[message.report];
      if (!report) throw new PluginError('not_found', `The plugin has no report “${message.report}”`);
      return await report.run(message.params, hostFor('', {}));
    }
    case 'dataResult': {
      const w = dataWaiting.get(message.id);
      dataWaiting.delete(message.id);
      if (w) {
        if (message.error) w.reject(new PluginError(message.error.code, message.error.message));
        else w.resolve(message.value);
      }
      return NO_ANSWER;
    }
    case 'export': {
      const exporter = plugin.exporters?.[message.exporter];
      if (!exporter) throw new PluginError('not_found', `The plugin has no exporter “${message.exporter}”`);
      return await exporter.export(message.input as Parameters<ExporterContribution['export']>[0], hostFor('', {}));
    }
  }
}

/** What handle() returns for a message that is itself an answer: nothing goes back. */
const NO_ANSWER = Symbol('no answer');

scope.onmessage = (event) => {
  const message = event.data;
  handle(message).then(
    (value) => {
      if (value === NO_ANSWER) return;
      try {
        post({ kind: 'result', id: message.id, value: value === undefined ? null : value });
      } catch (error) {
        // A value that cannot be cloned (a function, a class instance) is the plugin's bug.
        post({ kind: 'error', id: message.id, error: { code: 'internal', message: `The plugin returned what cannot be sent to the page: ${String(error)}` } });
      }
    },
    (error: unknown) => post({ kind: 'error', id: message.id, error: toWireError(error) }),
  );
};
