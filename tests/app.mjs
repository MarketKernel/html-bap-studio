/**
 * The built bap.html in headless Chrome, opened from file:// as a user would:
 * the scenario of Task.md 15 — create the demo, browse, filter, group, create
 * records with parts edited in cells, post, see stock move, be refused when
 * selling what is not there, design a field from the running list, print,
 * install a plugin from a file and see its host lock, work against the REST
 * dev server, and the conflict of two edits.
 *
 * Needs `npm run build` first and a local Chrome (or CHROME=…); skips without one.
 * `--shots DIR` saves screenshots of the main screens.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checker, root } from '../tools/load.mjs';
import { launch, sleep, MOD } from '../tools/chrome.mjs';
import { start } from '../tools/dev-server.mjs';

const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const { check, done } = checker();
const c = await launch();
if (!c) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the browser tests.');
  process.exit(0);
}
const APP = pathToFileURL(join(root, 'build', 'bap.html')).href;
const PAGE = '.page-host > .page:not(.hidden-page)';
const shot = async (name) => SHOTS && c.screenshot(join(SHOTS, `${name}.png`));
const q = (s) => JSON.stringify(s);
const count = (sel) => c.evaluate(`document.querySelectorAll(${q(sel)}).length`);
const text = (sel) => c.evaluate(`document.querySelector(${q(sel)})?.textContent ?? null`);
const step = (name) => console.log(`· ${name}`);
const server = await start({ port: 0, quiet: true });
const tmp = await mkdtemp(join(tmpdir(), 'bap-app-'));

try {
  step('start screen and demo');
  await c.navigate(APP);
  check('start screen', await c.until(`document.querySelector('[data-template="warehouse"]')`, 10000), true);
  await shot('01-start');
  await c.click('[data-template="warehouse"]');
  check('demo created', await c.until(`document.querySelector('.shell') && !document.querySelector('.overlay')`, 90000), true);
  check('dashboard opened', await c.until(`document.querySelectorAll('.widget .kpi').length === 4`, 10000), true);
  await sleep(500);
  await shot('02-dashboard');

  step('list, filter, group');
  await c.click('[data-nav="m_products"]');
  check('products list', await c.until(`document.querySelector(${q(PAGE)}) && document.querySelectorAll(${q(`${PAGE} .grid-body .grid-row`)}).length > 3`, 10000), true);
  // Hierarchical: the group tree is there; "everything" shows the products without groups.
  check('group tree', (await count(`${PAGE} .side-tree .tree-item`)) >= 6, true);
  await c.evaluate(`document.querySelector(${q(`${PAGE} .side-tree .tree-item`)}).click()`);
  await sleep(300);
  const all = await count(`${PAGE} .grid-body .grid-row`);
  check('all products shown', all >= 20, true);
  await c.click(`${PAGE} input[data-filter="name"]`);
  await c.type('oil');
  check('auto-filter', await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-body .grid-row[data-id]`)}).length === 2`, 3000), true);
  await c.evaluate(`(() => { const i = document.querySelector(${q(`${PAGE} input[data-filter="name"]`)}); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-body .grid-row`)}).length > 10`, 3000);
  await c.click(`${PAGE} input[data-filter="price"]`);
  await c.type('>100');
  check('number filter', await c.until(`[...document.querySelectorAll(${q(`${PAGE} .grid-body .grid-row .cell[data-col="price"]`)})].every((n) => Number(n.textContent.replace(/[^0-9.]/g, '')) > 100)`, 3000), true);
  await c.evaluate(`(() => { const i = document.querySelector(${q(`${PAGE} input[data-filter="price"]`)}); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  // Conditional formatting: the never-delivered item is red (filtered to it: the grid draws only rows in view).
  await c.click(`${PAGE} input[data-filter="name"]`);
  await c.type('Truffle');
  check('out-of-stock rule', await c.until(`[...document.querySelectorAll(${q(`${PAGE} .grid-body .grid-row[data-id]`)})].some((r) => r.textContent.includes('Truffle') && r.querySelector('.cell[data-col="stock"]')?.style.color)`, 3000), true);
  await c.evaluate(`(() => { const i = document.querySelector(${q(`${PAGE} input[data-filter="name"]`)}); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await shot('03-products');
  await c.click('[data-nav="m_sales"]');
  await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-body .grid-row`)}).length > 10`, 10000);
  // Grouping by status through the column menu.
  await c.evaluate(`document.querySelector(${q(`${PAGE} .grid-head .cell[data-col="status"]`)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 200 }))`);
  await c.evaluate(`[...document.querySelectorAll('.popup-item')].find((n) => n.textContent.includes('Group by'))?.click()`);
  check('grouped by status', await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-body .group-row`)}).length >= 2`, 3000), true);
  await shot('04-sales-grouped');
  await c.evaluate(`document.querySelector(${q(`${PAGE} .grid-group-bar .chip button`)}).click()`);
  check('ungrouped', await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-body .group-row`)}).length === 0`, 3000), true);

  step('a receipt with lines edited in cells, posted');
  await c.evaluate(`bap.openRecord('Receipts', null)`);
  await c.until(`document.querySelector(${q(`${PAGE} [data-field="supplier"]`)})`, 5000);
  await c.click(`${PAGE} input[data-field="supplier"]`);
  await c.type('Fresh');
  await c.until(`document.querySelector('.popup .popup-item')`, 3000);
  await c.press('Enter');
  await c.click(`${PAGE} input[data-field="warehouse"]`);
  await c.type('Shop');
  await c.until(`document.querySelector('.popup .popup-item')`, 3000);
  await c.press('Enter');
  await c.evaluate(`[...document.querySelectorAll(${q(`${PAGE} .f-part .toolbar .btn`)})].find((b) => b.textContent.includes('Add')).click()`);
  check('line editor opened', await c.until(`document.activeElement?.closest('.f-part')`, 3000), true);
  await c.type('Truffle');
  await c.until(`document.querySelector('.popup .popup-item:not(.disabled)')`, 3000);
  await c.press('Enter');
  check('qty editor next', await c.until(`document.activeElement?.closest('.cell[data-col="qty"]')`, 3000), true);
  await c.evaluate(`document.activeElement.select()`);
  await c.type('7');
  await c.press('Enter');
  await sleep(300);
  await c.press('Escape');
  check('line amount computed', await c.until(`document.querySelector(${q(`${PAGE} .f-part .grid-body .cell[data-col="amount"]`)})?.textContent.replace(/[^0-9.]/g, '') === '6300.00'`, 3000), true);
  check('total computed', await c.evaluate(`document.querySelector(${q(`${PAGE} input[data-field="total"]`)}).value.replace(/[^0-9.]/g, '')`), '6300.00');
  await shot('05-receipt');
  await c.evaluate(`[...document.querySelectorAll(${q(`${PAGE} .toolbar .btn`)})].find((b) => b.textContent.includes('Post and close')).click()`);
  check('receipt saved and closed', await c.until(`![...document.querySelectorAll('.tab .label')].some((n) => n.textContent.includes('(new)'))`, 5000), true);
  const truffle = await c.evaluate(`(async () => { const rows = await bap.data.all('Products'); const p = rows.find((r) => r.sku === 'G-099'); await bap.data.compute(bap.data.table('Products'), [p]); return p.stock; })()`);
  check('stock of the truffle oil', truffle, 7);

  step('selling more than there is');
  const refused = await c.evaluate(`(async () => {
    const d = bap.data, P = (await d.all('Products')).find((r) => r.sku === 'G-099');
    const shop = (await d.all('Warehouses')).find((w) => w.name === 'Shop'), cust = (await d.all('Counterparties')).find((x) => x.kind === 'customer');
    try { await d.save(d.table('Sales'), { id: '', customer: cust.id, warehouse: shop.id, posted: true, status: 'new', discount: 0, date: '2026-10-08T12:00:00', lines: [{ product: P.id, qty: 8, price: 1 }] }, null); return 'saved'; }
    catch (e) { return e.message; }
  })()`);
  check('oversell refused', /Not enough/.test(refused), true);

  step('designer: a field added from the running list');
  await c.evaluate(`bap.setMode('design')`);
  check('designer overview', await c.until(`document.querySelector('[data-design="overview"]')`, 3000), true);
  await c.evaluate(`bap.session.change((c) => { c.tables.find((t) => t.name === 'Warehouses').fields.push({ key: 'f_test_phone', name: 'phone', title: 'Phone', type: 'phone' }); })`);
  await c.evaluate(`bap.openTarget({ kind: 'table', name: 'Warehouses' })`);
  check('new field is a column at once', await c.until(`document.querySelector(${q(`${PAGE} .grid-head .cell[data-col="phone"]`)})`, 5000), true);
  await c.evaluate(`bap.openDesigner({ kind: 'table', name: 'Warehouses' })`);
  check('table designer shows the field', await c.until(`document.querySelector(${q(`${PAGE} tr[data-field="phone"]`)})`, 5000), true);
  await shot('06-designer');
  await c.press('z', MOD);
  check('undo removed it', await c.until(`!bap.session.config.tables.find((t) => t.name === 'Warehouses').fields.some((f) => f.name === 'phone')`, 5000), true);
  // Constants: designed as fields, their one record edited in the application, read as $const.
  await c.evaluate(`bap.session.change((c) => { c.constants = [{ key: 'k_vat', name: 'vat', title: 'VAT', type: 'decimal', scale: 1, default: '20' }]; })`);
  await c.evaluate(`bap.openDesigner({ kind: 'constants' })`);
  check('constants designed as fields', await c.until(`document.querySelector(${q(`${PAGE} tr[data-field="vat"]`)})`, 5000), true);
  await c.evaluate(`bap.setMode('run')`);
  await c.evaluate(`bap.openConstants()`);
  check('the constants record opens with its default', await c.until(`document.querySelector(${q(`${PAGE} input[data-field="vat"]`)})?.value === '20'`, 5000), true);
  await c.evaluate(`[...document.querySelectorAll(${q(`${PAGE} .toolbar .btn`)})].find((b) => b.textContent.includes('Save and close')).click()`);
  check('a constant read in an expression', await c.until(`(async () => { const env = await bap.data.scope(bap.data.table('Products'), ['$const.vat']); return env({}).resolve(['$const', 'vat']) === 20; })()`, 5000), true);
  await c.evaluate(`bap.session.change((c) => { delete c.constants; })`);

  step('quick entry: a shortcut, a form for typing, a sum, records in an order');
  await c.evaluate(`bap.session.change((c) => {
    const find = (nodes) => nodes.flatMap((n) => [n, ...find(n.children ?? [])]);
    find(c.menu).find((n) => n.key === 'm_wh').hotkey = 'Shift+W';
    const wh = c.tables.find((t) => t.name === 'Warehouses');
    wh.orderable = true;
    wh.fields.push({ key: 'f_test_area', name: 'area', title: 'Area', type: 'decimal', scale: 1 });
    c.forms.push({ key: 'fo_quick', name: 'QuickWarehouse', table: 'Warehouses', focus: 'area', enterSaves: true, layout: { type: 'group', key: 'r', children: [{ type: 'field', key: 'n1', field: 'name' }, { type: 'field', key: 'n2', field: 'area' }, { type: 'field', key: 'n3', field: 'address' }] } });
  })`);
  await c.evaluate(`document.activeElement?.blur()`);
  await c.press('W', 8);
  check('a menu shortcut opens its list', await c.until(`document.querySelector('.tab.active')?.textContent.includes('Warehouses')`, 5000), true);
  await c.evaluate(`bap.openRecord('Warehouses', null)`);
  check('the cursor in the field the form names', await c.until(`document.activeElement?.dataset.field === 'area'`, 5000), true);
  await c.type('100+20*2,5');
  await c.press('Enter');
  check('a sum typed in becomes its result', await c.evaluate(`document.querySelector(${q(`${PAGE} input[data-field="area"]`)}).value.replace(/[^0-9.,]/g, '')`), '150');
  check('Enter moves to the next field', await c.evaluate(`document.activeElement?.dataset.field`), 'address');
  await c.evaluate(`document.querySelector(${q(`${PAGE} input[data-field="name"]`)}).focus()`);
  await c.type('Garage');
  await c.press('Enter');
  await c.press('Enter');
  await c.press('Enter');
  check('Enter in the last field saves and closes', await c.until(`(async () => (await bap.data.all('Warehouses')).some((w) => w.name === 'Garage' && w.area === 150))()`, 5000), true);
  check('…and closes the form', await c.until(`!document.querySelector(${q(`${PAGE} input[data-field="area"]`)})`, 5000), true);
  const order = () => c.evaluate(`(async () => (await bap.data.all('Warehouses')).sort((a, b) => a._order - b._order).map((w) => w.name).join(','))()`);
  check('a new record of an ordered table comes last', (await order()).endsWith('Garage'), true);
  await c.evaluate(`bap.openTarget({ kind: 'table', name: 'Warehouses' })`);
  await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-body .grid-row[data-id]`)}).length >= 3`, 5000);
  await c.evaluate(`[...document.querySelectorAll(${q(`${PAGE} .grid-body .grid-row[data-id]`)})].find((r) => r.textContent.includes('Garage')).click()`);
  await c.press('ArrowUp', 1);
  check('Alt+↑ moves it up', await c.until(`(async () => (await bap.data.all('Warehouses')).sort((a, b) => a._order - b._order).map((w) => w.name).at(-2) === 'Garage')()`, 5000), true);
  await c.evaluate(`bap.session.change((c) => {
    const find = (nodes) => nodes.flatMap((n) => [n, ...find(n.children ?? [])]);
    delete find(c.menu).find((n) => n.key === 'm_wh').hotkey;
    const wh = c.tables.find((t) => t.name === 'Warehouses');
    delete wh.orderable;
    wh.fields = wh.fields.filter((f) => f.name !== 'area');
    c.forms = c.forms.filter((f) => f.name !== 'QuickWarehouse');
  })`);

  step('report and print');
  await c.evaluate(`bap.openTarget({ kind: 'report', name: 'SalesByProduct' })`);
  check('report chart', await c.until(`document.querySelector(${q(`${PAGE} .chart-svg`)})`, 10000), true);
  await shot('07-report');
  await c.evaluate(`(async () => { const s = (await bap.data.all('Sales')).find((x) => x.posted); bap.openRecord('Sales', s.id); })()`);
  await c.until(`[...document.querySelectorAll(${q(`${PAGE} .toolbar .btn`)})].some((b) => b.textContent.includes('Print'))`, 5000);
  await c.evaluate(`[...document.querySelectorAll(${q(`${PAGE} .toolbar .btn`)})].find((b) => b.textContent.includes('Print')).click()`);
  await c.evaluate(`[...document.querySelectorAll('.popup-item')].find((n) => n.textContent.includes('Invoice'))?.click()`);
  check('print preview', await c.until(`document.querySelector(${q(`${PAGE} iframe.print-frame`)})?.contentDocument?.querySelector('table tbody tr')`, 8000), true);
  check('print frame runs no scripts', await c.evaluate(`document.querySelector(${q(`${PAGE} iframe.print-frame`)}).getAttribute('sandbox').includes('allow-scripts')`), false);
  await shot('08-print');

  step('a plugin from a file, with its host lock');
  const plugin = `export const manifest = { id: 'test-source', name: 'Test source', version: '1.0.0', apiVersion: 1, contributes: { dataSources: ['items'] }, permissions: { hosts: ['http://127.0.0.1:${server.port}'] } };
export const dataSources = { items: { title: 'Test items', settings: [], async connect(settings, host) {
  return {
    capabilities: () => ({ write: false, schema: 'external' }),
    async describe() { return { tables: [{ name: 'Items', fields: [{ name: 'name', type: 'string' }] }] }; },
    async query() {
      let blocked = 'no';
      try { await fetch('https://example.com/'); } catch (e) { blocked = e.code || e.message; }
      const r = await host.fetch('http://127.0.0.1:${server.port}/api/capabilities');
      return { rows: [{ id: '1', name: 'write=' + (await r.json()).write + ' blocked=' + blocked }] };
    },
  };
} } };`;
  const installed = await c.evaluate(`(async () => {
    const code = ${q(plugin)};
    const d = await bap.registry.inspect(code);
    await bap.registry.install(code, d, 'file', 'test.js');
    return d.manifest.id;
  })()`);
  check('plugin installed', installed, 'test-source');
  const viaPlugin = await c.evaluate(`(async () => {
    const conn = await bap.registry.connect('t1', 'test-source', 'items', {});
    return (await conn.query({ table: 'Items' })).rows[0].name;
  })()`);
  check('plugin reached its host, not another', viaPlugin, 'write=true blocked=forbidden');
  const changed = await c.evaluate(`(async () => {
    const p = bap.registry.plugins.get('test-source');
    p.hash = 'other'; bap.registry.stop('test-source');
    try { await bap.registry.start('test-source'); return 'started'; } catch (e) { return e.code; }
  })()`);
  check('changed plugin needs approval', changed, 'forbidden');

  step('REST source on the dev server');
  const restOk = await c.evaluate(`(async () => {
    const conn = await bap.registry.connect('r1', 'rest', 'rest', { url: ${q(server.url)} });
    const row = await conn.insert('Notes', { id: '', text: 'from the page' });
    const a = await conn.update('Notes', row.id, { text: 'first' }, row._rev);
    try { await conn.update('Notes', row.id, { text: 'second' }, row._rev); return 'no conflict'; }
    catch (e) { return [a.text, e.code].join(','); }
  })()`);
  check('rest from the page: write and conflict', restOk, 'first,conflict');
  server.setDown(true);
  const down = await c.evaluate(`(async () => { const conn = await bap.registry.connect('r2', 'rest', 'rest', { url: ${q(server.url)} }).catch((e) => e); return conn.code ?? 'connected'; })()`);
  check('server down → network error', down, 'network');
  server.setDown(false);

  step('the local source passes the contract in the browser');
  const contract = await c.evaluate(`(async () => {
    const conn = await bap.registry.connect('contract', 'local', 'local', { name: 'contract-' + Date.now() });
    const r = await bapTools.runContract(conn, () => {}, { config: true });
    return r.lines.filter((l) => !l.ok).map((l) => l.name + ': ' + l.message);
  })()`);
  check('local contract in the browser', contract, []);

  step('conflict of two edits');
  const conflict = await c.evaluate(`(async () => {
    const d = bap.data, tb = d.table('Warehouses');
    const w = (await d.all('Warehouses'))[0];
    await d.save(tb, { ...w, address: 'A' }, w);
    try { await d.save(tb, { ...w, address: 'B' }, w); return 'saved'; } catch (e) { return e.code; }
  })()`);
  check('stale save refused', conflict, 'conflict');

  step('phone layout and dark theme');
  await c.viewport(390, 780, true);
  await c.evaluate(`bap.openTarget({ kind: 'view', name: 'SalesList' })`);
  await sleep(600);
  await shot('09-phone');
  await c.viewport(1440, 900);
  await c.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await c.evaluate(`bap.openTarget({ kind: 'dashboard', name: 'Home' })`);
  await sleep(800);
  await shot('10-dark');

  step('reload restores the workspace and its tabs');
  await c.reload();
  check('reopened', await c.until(`document.querySelector('.shell') && document.querySelectorAll('.tab').length >= 3`, 15000), true);

  check('no page errors', c.errors, []);

  step('PWA: installed worker, offline');
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { extname } = await import('node:path');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  let offline = false;
  const pages = createServer(async (req, res) => {
    if (offline) return req.socket.destroy();
    const name = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '') || 'index.html';
    try {
      const body = await readFile(join(root, 'build', 'pages', name));
      res.setHeader('content-type', TYPES[extname(name)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  await c.navigate(`http://127.0.0.1:${pages.address().port}/`);
  check('worker controls the page', await c.until(`!!navigator.serviceWorker.controller`, 15000), true);
  check('start screen from the PWA', await c.until(`document.querySelector('.tile, .shell')`, 10000), true);

  step('json-file: the database in a file (OPFS stands in for the file picker)');
  const fileResult = await c.evaluate(`(async () => {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle('test.bap.json', { create: true });
    const conn = await bap.registry.connect('jf', 'json-file', 'file', { file: handle });
    await conn.saveConfig({ app: { name: 'In a file' } }, null);
    const row = await conn.insert('Items', { id: '', name: 'Ёлка' });
    await conn.update('Items', row.id, { qty: 2 }, row._rev);
    await conn.close();
    let text = '';
    for (let i = 0; i < 40 && !text.includes('qty'); i++) { await new Promise((r) => setTimeout(r, 100)); text = await (await handle.getFile()).text(); }
    const saved = JSON.parse(text);
    const again = await bap.registry.connect('jf2', 'json-file', 'file', { file: handle });
    const rows = (await again.query({ table: 'Items' })).rows;
    const config = await again.loadConfig();
    return [saved.bap, saved.data.Items.length, rows[0].name, rows[0].qty, config.doc.app.name];
  })()`);
  check('json-file round trip', fileResult, ['backup', 1, 'Ёлка', 2, 'In a file']);
  offline = true;
  await c.reload();
  check('opens offline', await c.until(`document.querySelector('.tile, .shell')`, 10000), true);
  pages.close();
  pages.closeAllConnections?.();
} finally {
  await c.close();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
}
await writeFile(join(tmp, '.done'), '').catch(() => {});
done('app');
