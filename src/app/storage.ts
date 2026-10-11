/**
 * The page's own IndexedDB database, `bap`: installed plugins with their code
 * and the user's trust in them, secrets of connections, file and folder
 * handles. Settings that may be lost (theme, widths) stay in localStorage
 * (settings.ts); nothing important goes there.
 */

const STORES = ['plugins', 'secrets', 'handles', 'kv'] as const;
type StoreName = (typeof STORES)[number];

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('bap', 1);
    request.onupgradeneeded = () => {
      for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const request = work(database.transaction(store, mode).objectStore(store));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      }),
  );
}

export const idb = {
  get: <T>(store: StoreName, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key)),
  set: (store: StoreName, key: string, value: unknown) => run<void>(store, 'readwrite', (s) => s.put(value, key)),
  delete: (store: StoreName, key: string) => run<void>(store, 'readwrite', (s) => s.delete(key)),
  all: async <T>(store: StoreName): Promise<[string, T][]> => {
    const [keys, values] = await Promise.all([run<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()), run<T[]>(store, 'readonly', (s) => s.getAll())]);
    return keys.map((k, i) => [String(k), values[i] as T]);
  },
};

/** Asks the browser not to evict the data under storage pressure; quietly does nothing where it cannot. */
export function persistStorage(): void {
  void navigator.storage?.persist?.().catch(() => false);
}
