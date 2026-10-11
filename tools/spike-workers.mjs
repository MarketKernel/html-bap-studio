/** Stage 0 probe (docs/notes/platform.md): which way of running plugin code survives file:// and the CSP. `node tools/spike-workers.mjs` */
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const tmp = await mkdtemp(join(tmpdir(), 'bap-spike-'));
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { launch } from './chrome.mjs';
const server = createServer((req, res) => { res.setHeader('access-control-allow-origin', '*'); res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok: true, origin: req.headers.origin ?? null })); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const script = `
window.results = {};
const plugin = "export const manifest = { id: 'x' }; export async function run(url) { const r = await fetch(url); return await r.json(); }";
const runtime = "self.onmessage = async (e) => { const { mode, code, url, pluginUrl } = e.data; try { let src = pluginUrl; if (mode === 'inner') src = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); const m = await import(src); const out = await m.run(url); postMessage({ ok: true, out, id: m.manifest.id }); } catch (err) { postMessage({ ok: false, err: String(err) }); } };";
async function trial(name, mode, url) {
  return new Promise((resolve) => {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([runtime], { type: 'text/javascript' })), { type: window.__wtype });
      w.onmessage = (e) => { window.results[name] = e.data; resolve(); };
      w.onerror = (e) => { window.results[name] = { ok: false, err: 'onerror ' + (e.message || '') }; resolve(); };
      w.postMessage({ mode, code: plugin, url, pluginUrl: URL.createObjectURL(new Blob([plugin], { type: 'text/javascript' })) });
      setTimeout(() => { window.results[name] ??= { ok: false, err: 'timeout' }; resolve(); }, 8000);
    } catch (err) { window.results[name] = { ok: false, err: String(err) }; resolve(); }
  });
}
(async () => {
  window.__wtype = 'classic';
  await trial('classic_outer_local', 'outer', 'http://127.0.0.1:${port}/x');
  await trial('classic_inner_local', 'inner', 'http://127.0.0.1:${port}/x');
  await trial('classic_nbu', 'inner', 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json');
  window.__wtype = 'module';
  await trial('outerBlob_local', 'outer', 'http://127.0.0.1:${port}/x');
  await trial('innerBlob_local', 'inner', 'http://127.0.0.1:${port}/x');
  await trial('nbu', 'outer', 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json');
  await new Promise((resolve) => { const code = "self.plugin = { run: async (u) => (await fetch(u)).json() };"; const rt = "self.onmessage = async (e) => { try { importScripts(e.data.u); postMessage({ ok: true, out: await self.plugin.run(e.data.url) }); } catch (err) { postMessage({ ok: false, err: String(err) }); } };"; const w = new Worker(URL.createObjectURL(new Blob([rt], { type: 'text/javascript' }))); w.onmessage = (e) => { window.results.importScripts = e.data; resolve(); }; w.onerror = (e) => { window.results.importScripts = { ok: false, err: 'onerror' }; resolve(); }; w.postMessage({ u: URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), url: 'http://127.0.0.1:${port}/y' }); });
  try { indexedDB.open('t'); window.results.idb = { ok: true }; } catch (e) { window.results.idb = { ok: false, err: String(e) }; }
  window.results.fsa = typeof showDirectoryPicker;
  try { eval('1'); window.results.eval = 'allowed'; } catch { window.results.eval = 'blocked'; }
  window.done = true;
})();`;
const hash = createHash('sha256').update(script).digest('base64');
const csp = `default-src 'none'; script-src 'sha256-${hash}' blob:; worker-src blob:; connect-src https: http://127.0.0.1:*; style-src 'unsafe-inline'; img-src data: blob:`;
await writeFile(tmp + '/spike.html', `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${script}</script>`);
const c = await launch();
await c.navigate('file://' + tmp + '/spike.html');
await c.until('window.done', 30000);
console.log(JSON.stringify(await c.evaluate('window.results'), null, 1));
console.log('errors', c.errors);
await c.close(); server.close();
