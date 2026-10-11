/**
 * `rest`: a data source over HTTPS that speaks the REST protocol of
 * plugins/README.md — the one tools/dev-server.mjs implements. Any backend
 * that answers these few endpoints becomes a data source for the studio.
 *
 * The plugin reaches only the hosts the user approved (manifest: any https
 * host, plus localhost for development); the server URL is a setting, the
 * token a secret one.
 */
import { PluginError, type Capabilities, type Connection, type DataSourceFactory, type ErrorCode, type PluginManifest } from '../../../src/core/plugin-protocol';
import type { AggregateQuery, Query, QueryResult, Row } from '../../../src/core/query/types';

export const manifest: PluginManifest = {
  id: 'rest',
  name: 'REST server',
  version: '1.0.0',
  apiVersion: 1,
  author: 'BAP Studio',
  description: 'Data on a server that speaks the BAP REST protocol (see plugins/README.md), e.g. tools/dev-server.mjs.',
  contributes: { dataSources: ['rest'] },
  // The server is chosen by the user: any https host, and a local one for development.
  permissions: { hosts: ['https://*', 'http://localhost', 'http://127.0.0.1'] },
};

const CODES: Record<number, ErrorCode> = { 400: 'validation', 401: 'auth', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 501: 'unsupported', 504: 'timeout' };

export const dataSources: Record<string, DataSourceFactory> = {
  rest: {
    title: 'REST server',
    description: 'A server of the BAP REST protocol. Several people can work with the same data.',
    settings: [
      { key: 'url', type: 'url', title: 'Server address', required: true, default: 'http://127.0.0.1:8787/api' },
      { key: 'token', type: 'password', title: 'Access token', secret: true },
      { key: 'timeout', type: 'number', title: 'Timeout, seconds', default: 30 },
    ],
    async connect(settings, host) {
      const base = String(settings.url ?? '').replace(/\/+$/, '');
      if (!/^https?:\/\//.test(base)) throw new PluginError('validation', 'The server address must start with https:// (or http:// for a local server)');
      const timeout = (Number(settings.timeout) || 30) * 1000;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (settings.token) headers.authorization = `Bearer ${String(settings.token)}`;
      const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        let res: Response;
        try {
          res = await host.fetch(`${base}${path}`, { method, headers, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        } catch (error) {
          if (controller.signal.aborted) throw new PluginError('timeout', `${base}: no answer in ${timeout / 1000} s`);
          if (error instanceof PluginError || (error as { code?: unknown }).code) throw error;
          throw new PluginError('network', `${base}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        let data: unknown = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        if (!res.ok) {
          const e = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
          const code = (e?.code as ErrorCode | undefined) ?? CODES[res.status] ?? (res.status >= 500 ? 'internal' : 'validation');
          throw new PluginError(code, e?.message ?? `${res.status} ${res.statusText}`, e?.details);
        }
        return data as T;
      };
      // The server says what it can; an older or simpler server that has no /capabilities gets the core's help.
      let caps: Capabilities;
      try {
        caps = await call<Capabilities>('GET', '/capabilities');
      } catch (error) {
        const code = (error as PluginError).code;
        if (code !== 'not_found' && code !== 'unsupported') throw error;
        caps = { write: true, schema: 'managed', query: { where: false, orderBy: false, paging: false, count: false, aggregate: false }, batch: false, config: true, files: false, sequences: false, changes: false };
      }
      const t = (name: string) => encodeURIComponent(name);
      const connection: Connection = {
        capabilities: () => caps,
        applySchema: (changes) => call('POST', '/schema', { changes }),
        loadConfig: async () => {
          try {
            return await call<{ doc: unknown; rev: string }>('GET', '/config');
          } catch (error) {
            if ((error as PluginError).code === 'not_found') return null;
            throw error;
          }
        },
        saveConfig: (doc, expectedRev) => call('PUT', '/config', { doc, expectedRev }),
        query: (q: Query) => call<QueryResult>('POST', '/query', q),
        aggregate: (q: AggregateQuery) => call<{ rows: Record<string, unknown>[] }>('POST', '/aggregate', q),
        get: async (table, id) => {
          try {
            return await call<Row>('GET', `/tables/${t(table)}/${t(id)}`);
          } catch (error) {
            if ((error as PluginError).code === 'not_found') return null;
            throw error;
          }
        },
        insert: (table, row) => call<Row>('POST', `/tables/${t(table)}`, row),
        update: (table, id, patch, expectedRev) => call<Row>('PATCH', `/tables/${t(table)}/${t(id)}`, { patch, expectedRev: expectedRev ?? null }),
        delete: (table, id, expectedRev) => call<void>('DELETE', `/tables/${t(table)}/${t(id)}${expectedRev ? `?rev=${t(expectedRev)}` : ''}`),
        batch: (ops) => call('POST', '/batch', { ops }),
        nextNumber: async (sequence) => (await call<{ value: number }>('POST', `/sequences/${t(sequence)}`)).value,
        close: async () => {},
      };
      return connection;
    },
  },
};
