/**
 * Performance (Task.md 15), not part of `npm run check`: 100 000 records in
 * the browser database — the list's first paint, an auto-filter, scrolling.
 * `node tests/perf.mjs` (needs a build and Chrome).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../tools/load.mjs';
import { launch, sleep } from '../tools/chrome.mjs';

const N = 100_000;
const c = await launch();
if (!c) process.exit(0);
const PAGE = '.page-host > .page:not(.hidden-page)';
await c.navigate(pathToFileURL(join(root, 'build', 'bap.html')).href);
await c.until(`document.querySelector('[data-template="blank"]')`, 10000);
await c.click('[data-template="blank"]');
await c.until(`document.querySelector('.shell') && !document.querySelector('.overlay')`, 30000);
const seeded = await c.evaluate(`(async () => {
  await bap.session.change((c) => c.tables.push({ key: 'tbig', name: 'Big', kind: 'catalog', title: 'Big', fields: [
    { key: 'f1', name: 'name', type: 'string', title: 'Name' }, { key: 'f2', name: 'qty', type: 'decimal', scale: 2, title: 'Qty' },
    { key: 'f3', name: 'day', type: 'date', title: 'Day' }, { key: 'f4', name: 'kind', type: 'enum', options: [{ value: 'a', title: 'Alpha' }, { value: 'b', title: 'Beta' }], title: 'Kind' } ] }));
  const conn = bap.session.connections.get('main').remote;
  const t0 = performance.now();
  for (let i = 0; i < ${N}; i += 5000) {
    const ops = [];
    for (let k = i; k < i + 5000; k++) ops.push({ op: 'insert', table: 'Big', row: { id: 'r' + k, name: 'Item ' + k, qty: (k * 7) % 1000, day: '2026-' + String(1 + (k % 12)).padStart(2, '0') + '-15', kind: k % 3 ? 'a' : 'b' } });
    await conn.batch(ops);
  }
  return Math.round(performance.now() - t0);
})()`);
console.log(`seed ${N} rows: ${seeded} ms`);
const t0 = Date.now();
await c.evaluate(`bap.openTarget({ kind: 'table', name: 'Big' })`);
await c.until(`document.querySelector(${JSON.stringify(`${PAGE} .grid-foot`)})?.textContent.includes('100')`, 60000);
console.log(`first paint of the list: ${Date.now() - t0} ms`);
const t1 = Date.now();
await c.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(`${PAGE} input[data-filter="name"]`)}); i.value = '99'; i.dispatchEvent(new Event('input')); })()`);
await c.until(`!document.querySelector(${JSON.stringify(`${PAGE} .grid-foot`)}).textContent.startsWith('100')`, 10000);
console.log(`auto-filter "contains 99": ${Date.now() - t1 - 220} ms (after the 220 ms typing pause)`);
const frames = await c.evaluate(`(async () => {
  const s = document.querySelector(${JSON.stringify(`${PAGE} .grid-scroll`)});
  const i = document.querySelector(${JSON.stringify(`${PAGE} input[data-filter="name"]`)}); i.value = ''; i.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 1500));
  let n = 0, worst = 0, last = performance.now();
  const done = performance.now() + 2000;
  while (performance.now() < done) {
    s.scrollTop += 900;
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now(); worst = Math.max(worst, now - last); last = now; n++;
  }
  return { frames: n, worst: Math.round(worst) };
})()`);
console.log(`scrolling 2 s: ${frames.frames} frames, the longest ${frames.worst} ms`);
await sleep(100);
console.log('errors', c.errors);
await c.close();
