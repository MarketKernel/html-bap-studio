#!/usr/bin/env node
/**
 * The reference server of the REST protocol (plugins/README.md → "REST
 * protocol"), for the `rest` data source: a small backend for working
 * together over the network, and the other end of the tests.
 *
 * It runs the very store the built-in `local` source runs (plugins/builtin/
 * local/store.ts), over memory saved to a JSON file — so both sources behave
 * the same by construction. No dependencies.
 *
 *   node tools/dev-server.mjs [--port 8787] [--file data/server.json] [--token secret]
 *                             [--delay 0] [--host 127.0.0.1]
 *
 * CORS is open (any Origin, also `null` of a page opened from a file), as a
 * page served from anywhere — or from disk — is the client. With --token,
 * every request must carry `Authorization: Bearer <token>`.
 *
 * As a module, start({ port, file, token }) returns { port, close, state,
 * setDown(bool), setDelay(ms) } for tests.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from './load.mjs';

const STATUS = { conflict: 409, not_found: 404, validation: 400, auth: 401, forbidden: 403, unsupported: 501, timeout: 504, network: 502, internal: 500 };

export async function start({ port = 8787, host = '127.0.0.1', file = null, token = null, delay = 0, quiet = false } = {}) {
  const { Store, memoryAdapter } = await load('../plugins/builtin/local/store');
  let state = { tables: {}, meta: {} };
  if (file) {
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // A new file.
    }
  }
  let saving = Promise.resolve();
  const persist = (next) => {
    if (!file) return;
    // Written to a temporary name and renamed: a crash never leaves half a file.
    saving = saving.then(async () => {
      await mkdir(dirname(resolve(file)), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(next));
      await rename(`${file}.tmp`, file);
    });
  };
  const adapter = memoryAdapter(state, persist);
  const store = new Store(adapter);
  let down = false;
  let wait = delay;

  const send = (res, status, body) => {
    res.statusCode = status;
    if (body === undefined) return res.end();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };
  const fail = (res, error) => {
    const code = typeof error?.code === 'string' && STATUS[error.code] ? error.code : 'internal';
    send(res, STATUS[code], { error: { code, message: error?.message ?? String(error), ...(error?.details ? { details: error.details } : {}) } });
  };
  const body = (req) =>
    new Promise((ok, no) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          ok(data ? JSON.parse(data) : null);
        } catch (e) {
          no(Object.assign(new Error(`Bad JSON: ${e.message}`), { code: 'validation' }));
        }
      });
      req.on('error', no);
    });

  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '600');
    if (req.method === 'OPTIONS') return send(res, 204);
    if (down) return req.socket.destroy();
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent);
    if (parts[0] === 'api') parts.shift();
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) throw Object.assign(new Error('A valid token is required'), { code: 'auth' });
      const [head, a, b] = parts;
      if (req.method === 'GET' && head === 'capabilities') return send(res, 200, store.capabilities());
      if (req.method === 'GET' && head === 'whoami') return send(res, 200, { user: token ? 'token-user' : 'anonymous' });
      if (req.method === 'POST' && head === 'query') return send(res, 200, await store.query(await body(req)));
      if (req.method === 'POST' && head === 'aggregate') return send(res, 200, await store.aggregate(await body(req)));
      if (req.method === 'POST' && head === 'batch') return send(res, 200, await store.batch((await body(req)).ops));
      if (req.method === 'POST' && head === 'schema') return send(res, 200, (await store.applySchema((await body(req)).changes)) ?? { ok: true });
      if (req.method === 'POST' && head === 'sequences' && a) return send(res, 200, { value: await store.nextNumber(a) });
      if (head === 'config') {
        if (req.method === 'GET') {
          const c = await store.loadConfig();
          return c ? send(res, 200, c) : fail(res, Object.assign(new Error('No configuration yet'), { code: 'not_found' }));
        }
        if (req.method === 'PUT') {
          const { doc, expectedRev } = await body(req);
          return send(res, 200, await store.saveConfig(doc, expectedRev ?? null));
        }
      }
      if (head === 'tables' && a) {
        if (req.method === 'GET' && b) {
          const row = await store.get(a, b);
          return row ? send(res, 200, row) : fail(res, Object.assign(new Error(`${a}: no record ${b}`), { code: 'not_found' }));
        }
        if (req.method === 'POST' && !b) return send(res, 201, await store.insert(a, await body(req)));
        if (req.method === 'PATCH' && b) {
          const { patch, expectedRev } = await body(req);
          return send(res, 200, await store.update(a, b, patch, expectedRev ?? undefined));
        }
        if (req.method === 'DELETE' && b) {
          await store.delete(a, b, url.searchParams.get('rev') ?? undefined);
          return send(res, 204);
        }
      }
      fail(res, Object.assign(new Error(`${req.method} ${url.pathname} is not part of the protocol`), { code: 'not_found' }));
    } catch (error) {
      fail(res, error);
    }
  });
  await new Promise((r) => server.listen(port, host, r));
  const actual = server.address().port;
  if (!quiet) console.log(`BAP dev server on http://${host}:${actual}/api${file ? ` — data in ${file}` : ' — in memory'}${token ? ' — token required' : ''}`);
  return {
    port: actual,
    url: `http://${host}:${actual}/api`,
    get state() {
      return adapter.state;
    },
    setDown: (v) => (down = v),
    setDelay: (ms) => (wait = ms),
    close: async () => {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await saving;
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : fallback;
  };
  await start({ port: Number(arg('port', 8787)), host: arg('host', '127.0.0.1'), file: arg('file', 'data/server.json'), token: arg('token', null), delay: Number(arg('delay', 0)) });
}
