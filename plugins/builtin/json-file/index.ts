/**
 * `json-file`: the whole database — configuration and records — in one
 * `.bap.json` file on disk, like an .mdb: easy to copy, mail, back up. It is
 * the same store as `local` over memory; every write is saved to the file a
 * moment later (writes close together are saved once).
 *
 * The file comes as a FileSystemFileHandle the page got from the user's pick
 * (File System Access: Chrome and Edge). A handle crosses into the worker as
 * it is; writing through it needs the permission the page asked for.
 *
 * The file's format is the backup format of the designer: { bap: 'backup',
 * version, config, data: { table: rows[] } } — a backup opens as a database
 * and a database is a backup.
 */
import { PluginError, type DataSourceFactory, type PluginManifest } from '../../../src/core/plugin-protocol';
import type { Row } from '../../../src/core/query/types';
import { memoryAdapter, Store, type MemoryState } from '../local/store';

export const manifest: PluginManifest = {
  id: 'json-file',
  name: 'File on disk',
  version: '1.0.0',
  apiVersion: 1,
  author: 'BAP Studio',
  description: 'The whole database in one .bap.json file on your disk (Chrome, Edge).',
  contributes: { dataSources: ['file'] },
  permissions: { hosts: [] },
};

interface FileFormat {
  bap: 'backup';
  version: 1;
  config?: unknown;
  configRev?: string;
  data: Record<string, Row[]>;
  meta?: Record<string, unknown>;
}

function toState(text: string): MemoryState {
  if (!text.trim()) return { tables: {}, meta: {} };
  const raw = JSON.parse(text) as Partial<FileFormat>;
  const tables: MemoryState['tables'] = {};
  for (const [name, rows] of Object.entries(raw.data ?? {})) {
    tables[name] = {};
    for (const row of rows) tables[name]![row.id] = { ...row, _rev: row._rev ?? '1' };
  }
  const meta: Record<string, unknown> = { ...(raw.meta ?? {}) };
  if (raw.config) meta.config = { doc: raw.config, rev: raw.configRev ?? '1' };
  return { tables, meta };
}

function toFile(state: MemoryState): string {
  const { config, ...meta } = state.meta as { config?: { doc: unknown; rev: string } };
  const out: FileFormat = {
    bap: 'backup',
    version: 1,
    ...(config ? { config: config.doc, configRev: config.rev } : {}),
    data: Object.fromEntries(Object.entries(state.tables).map(([name, rows]) => [name, Object.values(rows)])),
    meta,
  };
  return JSON.stringify(out, null, 1);
}

export const dataSources: Record<string, DataSourceFactory> = {
  file: {
    title: 'File on disk (.bap.json)',
    description: 'Everything in one file you choose. Chrome and Edge only.',
    settings: [{ key: 'file', type: 'file', title: 'File', required: true }],
    async connect(settings, host) {
      const handle = settings.file as (FileSystemFileHandle & { createWritable?(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> }) | undefined;
      if (!handle || typeof handle.getFile !== 'function') throw new PluginError('validation', 'Choose the file of the database');
      let text: string;
      try {
        text = await (await handle.getFile()).text();
      } catch (error) {
        throw new PluginError('forbidden', `The file cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      let state: MemoryState;
      try {
        state = toState(text);
      } catch (error) {
        throw new PluginError('validation', `Not a BAP database file: ${error instanceof Error ? error.message : String(error)}`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let latest: MemoryState = state;
      let writing = Promise.resolve();
      const flush = () => {
        writing = writing.then(async () => {
          if (!handle.createWritable) throw new PluginError('unsupported', 'This browser cannot write the file');
          const out = await handle.createWritable();
          await out.write(toFile(latest));
          await out.close();
        }).catch((error: unknown) => host.log('error', `Saving the file failed: ${error instanceof Error ? error.message : String(error)}`));
        return writing;
      };
      const adapter = memoryAdapter(state, (next) => {
        latest = next;
        clearTimeout(timer);
        // Writes close together (a document and its movements, a pasted list) are saved once.
        timer = setTimeout(() => void flush(), 120);
      });
      const store = new Store(adapter);
      const close = store.close.bind(store);
      store.close = async () => {
        clearTimeout(timer);
        await flush();
        await close();
      };
      host.log('info', `${Object.values(state.tables).reduce((n, rows) => n + Object.keys(rows).length, 0)} records read from ${handle.name}`);
      return store;
    },
  },
};
