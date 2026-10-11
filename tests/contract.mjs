/**
 * The data source contract (Task.md 5.7) against the sources that run in
 * Node: the store behind `local` over memory, and the `rest` plugin talking
 * to tools/dev-server.mjs over HTTP — the same scenarios the plugin manager
 * runs in the browser. `local` itself (IndexedDB) is checked in tests/app.mjs.
 */
import { checker, load } from '../tools/load.mjs';
import { start } from '../tools/dev-server.mjs';

const { check, done } = checker();
const { runContract } = await load('core/contract');
const { Store, memoryAdapter } = await load('../plugins/builtin/local/store');
const rest = await load('../plugins/builtin/rest/index');
const { hostAllowed } = await load('core/plugin-protocol');

const report = (label, r) => {
  for (const line of r.lines) if (!line.ok) console.error(`  ${label}: ✗ ${line.name} — ${line.message}`);
  check(`${label}: no failures`, r.failed, 0);
  console.log(`contract ${label}: ${r.passed} passed, ${r.skipped} skipped`);
};

// Memory: everything, configuration included (a scratch store).
report('memory', await runContract(new Store(memoryAdapter()), () => {}, { config: true }));

// REST against the reference server, through the plugin as the studio would run it.
const server = await start({ port: 0, quiet: true, token: 'secret' });
const host = (hosts) => ({
  fetch: (url, init) => (hostAllowed(String(url), hosts) ? fetch(url, init) : Promise.reject(Object.assign(new Error('blocked'), { code: 'forbidden' }))),
  settings: {},
  storage: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  log: () => {},
  progress: () => {},
  emitChanges: () => {},
});
const hosts = rest.manifest.permissions.hosts;
const conn = await rest.dataSources.rest.connect({ url: server.url, token: 'secret' }, host(hosts));
report('rest', await runContract(conn, () => {}, { config: true }));

// A wrong token is refused with "auth".
try {
  await rest.dataSources.rest.connect({ url: server.url, token: 'wrong' }, host(hosts)).then((c) => c.query({ table: 'x' }));
  check('rest: wrong token refused', 'no error', 'auth');
} catch (error) {
  check('rest: wrong token refused', error.code, 'auth');
}
// A server that is down is a network error, not a crash.
server.setDown(true);
try {
  await conn.query({ table: 'x' });
  check('rest: server down', 'no error', 'network');
} catch (error) {
  check('rest: server down', ['network', 'internal'].includes(error.code), true);
}
server.setDown(false);
check('rest: back up', (await conn.query({ table: 'nothing' })).rows, []);
// The plugin may not leave its hosts.
try {
  await rest.dataSources.rest.connect({ url: 'http://example.org/api' }, host(hosts));
  check('rest: foreign http host blocked', 'connected', 'forbidden');
} catch (error) {
  check('rest: foreign http host blocked', error.code, 'forbidden');
}
await server.close();
done('contract');
