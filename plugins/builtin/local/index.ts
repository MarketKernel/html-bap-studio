/**
 * `local`: the database in the browser's IndexedDB — the studio's default
 * source, offline and fine on file://. One object store holds every table's
 * records keyed by [table, id], so a new table or field needs no database
 * upgrade; another holds the configuration and the sequences.
 *
 * Tabs share the database: a write in one is announced on a BroadcastChannel,
 * and the others drop what they had read and tell the page (changes).
 */
import type { Change, DataSourceFactory, PluginManifest } from '../../../src/core/plugin-protocol';
import type { Row } from '../../../src/core/query/types';
import { Store, type Adapter, type Tx } from './store';

export const manifest: PluginManifest = {
  id: 'local',
  name: 'Browser database',
  version: '1.0.0',
  apiVersion: 1,
  author: 'BAP Studio',
  description: 'Keeps the data in this browser (IndexedDB). Works offline.',
  contributes: { dataSources: ['local'] },
  permissions: { hosts: [] },
};

interface Stored {
  t: string;
  id: string;
  row: Row;
}

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function open(name: string): Promise<IDBDatabase> {
  const request = indexedDB.open(`bap-local-${name}`, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('records', { keyPath: ['t', 'id'] }).createIndex('t', 't');
    db.createObjectStore('meta');
  };
  return done(request);
}

function idbAdapter(db: IDBDatabase): Adapter {
  return {
    transact<T>(write: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
      const transaction = db.transaction(['records', 'meta'], write ? 'readwrite' : 'readonly');
      const records = transaction.objectStore('records');
      const meta = transaction.objectStore('meta');
      const finished = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('aborted'));
      });
      // When `work` fails, its error is the one reported; the abort that follows is expected.
      finished.catch(() => {});
      // Only IndexedDB requests are awaited inside `work`, so the transaction stays alive.
      const tx: Tx = {
        all: async (table) => ((await done(records.index('t').getAll(IDBKeyRange.only(table)))) as Stored[]).map((s) => s.row),
        get: async (table, id) => ((await done(records.get([table, id]))) as Stored | undefined)?.row,
        put: async (table, row) => void (await done(records.put({ t: table, id: row.id, row } satisfies Stored))),
        remove: async (table, id) => void (await done(records.delete([table, id]))),
        tables: async () => [...new Set(((await done(records.index('t').getAllKeys())) as unknown as [string, string][]).map((k) => k[0]))],
        meta: (key) => done(meta.get(key)),
        setMeta: async (key, value) => void (await done(meta.put(value, key))),
      };
      return work(tx).then(
        async (result) => {
          await finished;
          return result;
        },
        (error: unknown) => {
          try {
            transaction.abort();
          } catch {
            // Already finished or aborted.
          }
          throw error;
        },
      );
    },
    async close() {
      db.close();
    },
  };
}

export const dataSources: Record<string, DataSourceFactory> = {
  local: {
    title: 'Browser database',
    description: 'IndexedDB of this browser. Each name is a separate database.',
    settings: [{ key: 'name', type: 'string', title: 'Database name', default: 'default' }],
    async connect(settings, host) {
      const name = String(settings.name || 'default');
      const db = await open(name);
      const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`bap-local-${name}`);
      const store = new Store(idbAdapter(db), (tables) => channel?.postMessage({ tables }));
      if (channel) {
        channel.onmessage = (event: MessageEvent<{ tables: string[] }>) => {
          store.invalidate(event.data.tables);
          host.emitChanges(event.data.tables.map((table): Change => ({ table, id: '*', op: 'update' })));
        };
      }
      const close = store.close.bind(store);
      store.close = async () => {
        channel?.close();
        await close();
      };
      // The capabilities say `changes` once another tab can tell us about its writes.
      const capabilities = store.capabilities.bind(store);
      store.capabilities = () => ({ ...capabilities(), changes: channel !== null });
      return store;
    },
  },
};
