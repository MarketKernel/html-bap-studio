/**
 * "Personal finances" in headless Chrome, as a person uses it: the demo from
 * the start screen, the overview's numbers, R for a reconciliation with every
 * account in it, a difference typed in and posted, N for a quick operation
 * with a sum typed into its amount, the goals and the forecast.
 *
 * Needs `npm run build` first and a local Chrome; skips without one.
 * `--shots DIR` saves screenshots of the main screens, light and dark.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checker, root } from '../tools/load.mjs';
import { launch, sleep } from '../tools/chrome.mjs';

const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const { check, done } = checker();
const c = await launch();
if (!c) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the browser tests.');
  process.exit(0);
}
const PAGE = '.page-host > .page:not(.hidden-page)';
const q = (s) => JSON.stringify(s);
const shot = async (name) => SHOTS && c.screenshot(join(SHOTS, `finance-${name}.png`));
const step = (name) => console.log(`· ${name}`);
const number = (sel) => c.evaluate(`Number((document.querySelector(${q(sel)})?.textContent ?? '').replace(/[^0-9.,-]/g, '').replace(/,/g, ''))`);

try {
  step('the demo from the start screen');
  await c.navigate(pathToFileURL(join(root, 'build', 'bap.html')).href);
  check('the template is offered', await c.until(`document.querySelector('[data-template="finance"]')`, 10000), true);
  await c.click('[data-template="finance"]');
  check('demo created', await c.until(`document.querySelector('.shell') && !document.querySelector('.overlay')`, 90000), true);
  check('the overview: personal money', await c.until(`document.querySelector('[data-kpi="w_personal"]')?.textContent.match(/\\d/)`, 15000), true);
  await sleep(800);
  const personal = await number('[data-kpi="w_personal"]');
  const expected = await c.evaluate(`(async () => { const rows = await bap.data.movements('Money'); await bap.data.compute(bap.data.table('Money'), rows); return Math.round(rows.reduce((s, r) => s + (r.worth || 0), 0) * 100) / 100; })()`);
  check('…is the worth of every movement up to now', personal, expected);
  check('the forecast is drawn', await c.until(`document.querySelector(${q(`${PAGE} [data-widget="w_chart"] svg path`)})`, 10000), true);
  check('the goals are listed', await c.until(`document.querySelectorAll(${q(`${PAGE} [data-widget="w_goals"] .grid-row[data-id]`)}).length === 3`, 10000), true);
  check('the pace of unaccounted money: spending', (await number('[data-kpi="w_pace"]')) < 0, true);
  await shot('overview');

  step('R: a reconciliation with every account');
  await c.evaluate(`document.activeElement?.blur()`);
  await c.press('R');
  check('it opens with a line for each active account', await c.until(`document.querySelectorAll(${q(`${PAGE} .f-part .grid-row[data-id]`)}).length === 5`, 10000), true);
  // 700 less in cash than the records say.
  const cash = await c.evaluate(`(async () => (await bap.data.all('Accounts')).find((a) => a.name === 'Cash').id)()`);
  await c.evaluate(`(async () => {
    const card = bap.pages.find((p) => p.id === bap.active.id);
    const line = card.row.lines.find((l) => l.account === ${q(cash)});
    line.actual = line.expected - 700;
    await card.recompute();
  })()`);
  check('the difference is worked out', await c.until(`document.querySelector(${q(`${PAGE} input[data-field="unaccounted"]`)})?.value.replace(/[^0-9.-]/g, '') === '-700.00'`, 5000), true);
  await shot('reconciliation');
  await c.evaluate(`[...document.querySelectorAll(${q(`${PAGE} .toolbar .btn`)})].find((b) => b.textContent.includes('Post and close')).click()`);
  check('posted: the last reconciliation found −700', await c.until(`(async () => { const r = await bap.data.compute(bap.data.table('Reconciliations'), await bap.data.all('Reconciliations')); const last = r.sort((a, b) => b.date.localeCompare(a.date))[0]; return last.posted && last.unaccounted === -700; })()`, 10000), true);
  check('cash now holds what was typed in', await c.evaluate(`(async () => { const [a] = await bap.data.compute(bap.data.table('Accounts'), [await bap.data.get('Accounts', ${q(cash)})]); return a.balance; })()`), await c.evaluate(`(async () => { const r = await bap.data.compute(bap.data.table('Reconciliations'), await bap.data.all('Reconciliations')); const last = r.sort((a, b) => b.date.localeCompare(a.date))[0]; return last.lines.find((l) => l.account === ${q(cash)}).actual; })()`));

  step('N: a quick operation, a sum typed in, Enter to the end');
  // An operation counts when it is after the last reconciliation, to the second: a person is never this quick.
  await sleep(1100);
  await c.evaluate(`bap.openTarget({ kind: 'dashboard', name: 'Overview' })`);
  await c.evaluate(`document.activeElement?.blur()`);
  await c.press('N');
  check('the quick form opens with the cursor in the amount', await c.until(`document.activeElement?.dataset.field === 'amount'`, 8000), true);
  await c.type('120+35*2');
  for (let i = 0; i < 6 && (await c.evaluate(`!!document.querySelector('.dialog input[data-field="amount"]')`)); i++) {
    await c.press('Enter');
    await sleep(250);
  }
  check('saved and counted at once', await c.until(`(async () => (await bap.data.all('Operations')).some((o) => o.amount === 190 && o.posted))()`, 8000), true);
  await shot('after-operation');

  step('the screens');
  await c.evaluate(`bap.openTarget({ kind: 'view', name: 'AccountsList' })`);
  check('accounts grouped by kind and currency', await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-body .group-row`)}).length >= 4`, 8000), true);
  await shot('accounts');
  await c.evaluate(`bap.openTarget({ kind: 'view', name: 'RecurringList' })`);
  check('schedules in words', await c.until(`[...document.querySelectorAll(${q(`${PAGE} .cell[data-col="when"]`)})].some((n) => /Every month/.test(n.textContent))`, 8000), true);
  await shot('recurring');
  await c.evaluate(`bap.openTarget({ kind: 'report', name: 'Horizon' })`);
  check('the forecast to the horizon: five years by days', await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-row[data-id]`)}).length > 0 && document.querySelector(${q(`${PAGE} select[data-param="period"]`)})?.value === 'next:5y'`, 15000), true);
  await shot('horizon');
  step('a plugin reads the data and computes a report: when the money runs out, to the moment');
  const code = readFileSync(join(root, 'plugins', 'examples', 'forecast-exact.js'), 'utf8');
  check('installed, asking to read the data', await c.evaluate(`(async () => { const code = ${q(code)}; const d = await bap.registry.inspect(code); await bap.registry.install(code, d, 'file', 'forecast-exact.js'); return [d.reports.map((r) => r.name), bap.registry.plugins.get('forecast-exact').data]; })()`), [['lastsUntil'], true]);
  // A mortgage the salary cannot carry: the money runs out within the horizon.
  await c.evaluate(`(async () => { const d = bap.data; const card = (await d.all('Accounts')).find((a) => a.name === 'Salary card'); await d.save(d.table('Recurring'), { id: '', name: 'Mortgage', type: 'expense', account: card.id, amount: 90000, when: { every: 'month', day: 1, time: '09:00' } }, null); })()`);
  await c.evaluate(`bap.session.change((c) => { c.reports.push({ key: 'r_exact', name: 'Exact', title: 'Exact', source: '', plugin: { plugin: 'forecast-exact', report: 'lastsUntil' }, groupBy: [], measures: [] }); })`);
  const exact = await c.evaluate(`(async () => (await bap.data.pluginReport('forecast-exact', 'lastsUntil', {})).rows)()`);
  const byDay = await c.evaluate(`(async () => { const src = "reach('Horizon', 'assets', '<=', 0)"; const env = (await bap.data.scope(bap.data.table('Goals'), [src]))({}); return env.call('reach', ['Horizon', 'assets', '<=', 0], env); })()`);
  check('the plugin’s moment falls on the day reach() finds', [typeof exact[0].when, exact[0].when?.slice(0, 10)], ['string', byDay]);
  await c.evaluate(`bap.openTarget({ kind: 'report', name: 'Exact' })`);
  check('its report on screen like any other', await c.until(`document.querySelectorAll(${q(`${PAGE} .grid-row[data-id]`)}).length === 2`, 10000), true);
  await shot('plugin-report');
  check('a plugin not allowed to read is refused', await c.evaluate(`(async () => {
    const code = ${q(code.replace("permissions: { data: 'read' }", 'permissions: {}').replace("id: 'forecast-exact'", "id: 'forecast-blind'"))};
    const d = await bap.registry.inspect(code);
    await bap.registry.install(code, d, 'file', 'blind.js');
    try { await bap.data.pluginReport('forecast-blind', 'lastsUntil', {}); return 'read'; } catch (e) { return e.code; }
  })()`), 'forbidden');

  await c.evaluate(`document.documentElement.dataset.theme = 'dark'; bap.openTarget({ kind: 'dashboard', name: 'Overview' })`);
  await sleep(1200);
  await shot('overview-dark');
  await c.viewport(390, 844, true);
  await sleep(800);
  await shot('overview-phone');
  await c.viewport(1440, 900);

  step('build/finance.html: one application, the designer hidden');
  await c.navigate(pathToFileURL(join(root, 'build', 'finance.html')).href);
  // The same browser storage: it opens the Personal finances made above, and nothing else.
  check('opens the application made from its template', await c.until(`document.querySelector('[data-kpi="w_personal"]')`, 20000), true);
  check('no designer switch, its own title', await c.evaluate(`[!!document.querySelector('.mode-switch'), document.title]`), [false, 'Personal finances']);
  await c.press('F12');
  await sleep(300);
  check('F12 does not open the designer', await c.evaluate(`bap.session.mode`), 'run');
  await c.evaluate(`bap.closeWorkspace()`);
  check('its start screen offers only its own templates', await c.until(`document.querySelectorAll('[data-template]').length === 2 && !!document.querySelector('[data-template="finance-empty"]')`, 8000), true);
  check('…and only its own databases', await c.evaluate(`document.querySelectorAll('[data-workspace]').length`), 1);
  await shot('distribution-start');
  await c.evaluate(`document.querySelector('[data-workspace]').click()`);
  await c.until(`document.querySelector('[data-kpi="w_personal"]')`, 20000);
  await c.evaluate(`(() => { const s = JSON.parse(localStorage.getItem('bap.settings')); s.designer = true; localStorage.setItem('bap.settings', JSON.stringify(s)); })()`);
  await c.reload();
  check('shown when asked for in the settings', await c.until(`!!document.querySelector('.mode-switch [data-mode="design"]')`, 20000), true);
} finally {
  await c.close();
}
done('app-finance');
