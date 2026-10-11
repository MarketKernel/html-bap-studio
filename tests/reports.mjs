/**
 * Reports for what lies ahead: measures from expressions (each movement's
 * worth in the base currency) with conditions of their own, columns worked
 * out from a grouped row, the balance at the end of every day or month of a
 * period ahead (a forecast, planned movements in it), levels across the chart,
 * and reach() — the first day a measure meets a condition.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/data', 'core/expr/index', 'core/registers', 'core/reports', 'core/config/types', 'core/config/validate', '../plugins/builtin/local/store');
const { DataService, evaluate, parseCached, installPosting, runReport, periodRange, defaultPeriod, emptyConfig, validateConfig, Store, memoryAdapter } = M;

const f = (name, type, extra = {}) => ({ key: `f_${name}`, name, type, ...extra });
const config = emptyConfig('Ahead');
config.constants = [f('horizonYears', 'integer')];
config.tables = [
  { key: 't_cur', name: 'Currencies', kind: 'catalog', title: 'Currencies', fields: [f('code', 'string'), f('rate', 'decimal', { scale: 4 })] },
  { key: 't_acc', name: 'Accounts', kind: 'catalog', title: 'Accounts', fields: [f('name', 'string'), f('kind', 'string'), f('currency', 'ref', { ref: 'Currencies' }), f('fee', 'decimal')] },
  {
    key: 't_rec',
    name: 'Recurring',
    kind: 'catalog',
    title: 'Recurring',
    versioned: true,
    fields: [f('name', 'string'), f('account', 'ref', { ref: 'Accounts' }), f('amount', 'decimal'), f('income', 'boolean'), f('when', 'schedule')],
    posting: [
      { key: 'pi', register: 'Money', from: 'schedule', schedule: 'when', direction: 'in', when: 'income', set: { account: 'account', amount: 'amount' } },
      { key: 'po', register: 'Money', from: 'schedule', schedule: 'when', direction: 'out', when: 'not income', set: { account: 'account', amount: 'amount' } },
    ],
  },
  { key: 't_goal', name: 'Goals', kind: 'catalog', title: 'Goals', fields: [f('name', 'string'), f('price', 'decimal'), f('when', 'date', { computed: "reach('Forecast', 'personal', '>=', price)" })] },
  {
    key: 't_open',
    name: 'Openings',
    kind: 'document',
    title: 'Openings',
    fields: [f('account', 'ref', { ref: 'Accounts' }), f('amount', 'decimal')],
    posting: [{ key: 'p', register: 'Money', from: 'header', direction: 'in', set: { account: 'account', amount: 'amount' } }],
  },
  { key: 't_money', name: 'Money', kind: 'register', title: 'Money', registerKind: 'balance', fields: [f('account', 'ref', { ref: 'Accounts', role: 'dimension' }), f('amount', 'decimal', { role: 'resource' })] },
];
// What a movement is worth in the base currency, fee taken: a debt's makes it larger.
const worth = "amount * account.currency.rate * iif(account.kind = 'debt', 1 + coalesce(account.fee, 0) / 100, 1 - coalesce(account.fee, 0) / 100)";
config.reports = [
  {
    key: 'r_f',
    name: 'Forecast',
    title: 'Forecast',
    source: 'Money',
    mode: 'series',
    bucket: 'day',
    params: [{ name: 'period', type: 'period', default: "='next:' & $const.horizonYears & 'y'" }],
    groupBy: [],
    measures: [
      { name: 'personal', fn: 'sum', expr: worth },
      { name: 'assets', fn: 'sum', expr: worth, where: "account.kind <> 'debt'" },
    ],
    chart: { type: 'line', x: 'date:day', series: ['personal', 'assets'], refLines: [{ value: '0', title: 'zero' }, { from: 'Goals', value: 'price', title: 'name' }] },
  },
  {
    key: 'r_m',
    name: 'ByMonth',
    title: 'By month',
    source: 'Money',
    mode: 'series',
    bucket: 'month',
    groupBy: ['account'],
    measures: [{ name: 'amount', fn: 'sum', field: 'amount' }],
  },
  {
    key: 'r_t',
    name: 'Turnover',
    title: 'Turnover',
    source: 'Money',
    mode: 'turnover',
    groupBy: ['direction'],
    measures: [{ name: 'total', fn: 'sum', field: 'amount' }, { name: 'n', fn: 'count' }],
    columns: [{ name: 'average', title: 'Average', expr: 'round(total / n, 2)' }],
  },
];
check('the configuration has no problems', validateConfig(config), []);

let now = new Date(2026, 9, 8, 12, 0, 0);
const store = new Store(memoryAdapter());
const data = new DataService(config, { user: () => 'tester', now: () => now });
data.link('main', store, store.capabilities());
installPosting(data);
const T = (name) => data.table(name);
const save = (name, row, previous = null) => data.save(T(name), { id: '', ...row }, previous);

await data.save(T('_constants'), { id: 'constants', horizonYears: 1 }, null);
const uah = await save('Currencies', { code: 'UAH', rate: 1 });
const usd = await save('Currencies', { code: 'USD', rate: 41.5 });
const card = await save('Accounts', { name: 'Card', kind: 'asset', currency: uah.id, fee: 0 });
const cash = await save('Accounts', { name: 'Cash', kind: 'asset', currency: usd.id, fee: 1 });
const loan = await save('Accounts', { name: 'Loan', kind: 'debt', currency: usd.id, fee: 2 });
await save('Openings', { date: '2026-10-01T10:00:00', account: card.id, amount: 10000, posted: true });
await save('Openings', { date: '2026-10-01T10:00:00', account: cash.id, amount: 1000, posted: true });
await save('Openings', { date: '2026-10-01T10:00:00', account: loan.id, amount: -200, posted: true });
await save('Recurring', { name: 'Rent', account: card.id, amount: 6000, income: false, when: { every: 'month', day: 'last' }, validFrom: '2026-10-01T10:00:00' });
await save('Recurring', { name: 'Salary', account: card.id, amount: 5000, income: true, when: { every: 'month', day: 15 }, validFrom: '2026-10-01T10:00:00' });

// Cashflow's numbers: 1 000 USD with a 1 % fee at 41.5 is 41 085; a 200 USD debt with 2 % is 8 466 owed.
check('periods ahead', [periodRange({ kind: 'next:3m' }, now), periodRange({ kind: 'next:7d' }, now), periodRange({ kind: 'next:1y' }, now)], [{ from: '2026-10-08', to: '2027-01-08' }, { from: '2026-10-08', to: '2026-10-15' }, { from: '2026-10-08', to: '2027-10-08' }]);
check('a default period from an expression over the constants', await defaultPeriod(data, config.reports[0]), { kind: 'next:1y' });
const forecast = await runReport(data, config.reports[0], { period: { kind: 'next:1m' } }, now);
const day = (d) => forecast.rows.find((r) => r['date:day'] === d);
check('a series: one row a day, today to the end', [forecast.rows.length, forecast.rows[0]['date:day'], forecast.rows.at(-1)['date:day']], [32, '2026-10-08', '2026-11-08']);
check('personal money today: 10 000 + 41 085 − 8 466', day('2026-10-08').personal, 10000 + 41085 - 8466);
check('the money on the accounts leaves the debt out', day('2026-10-08').assets, 10000 + 41085);
check('the salary comes on the 15th', day('2026-10-15').personal - day('2026-10-14').personal, 5000);
check('the rent goes on the last day', day('2026-10-31').personal - day('2026-10-30').personal, -6000);
check('labels of the days', forecast.labels['date:day'].size, 32);
check('levels: zero, and each goal', forecast.refLines ?? [], [{ value: 0, title: 'zero' }]);

const months = await runReport(data, config.reports[1], { period: { kind: 'custom', from: '2026-10-01', to: '2026-12-31' } }, now);
check('a series by month and account: the balance at the end of each', months.rows.filter((r) => r.account === card.id).map((r) => [r['date:month'], r.amount]), [['2026-10', 9000], ['2026-11', 8000], ['2026-12', 7000]]);
check('…an account with no movements later keeps its balance', months.rows.filter((r) => r.account === cash.id).map((r) => r.amount), [1000, 1000, 1000]);

const turnover = await runReport(data, config.reports[2], { period: { kind: 'custom', from: '2026-10-01', to: '2026-10-31' } }, now);
check('a column worked out from the grouped row', turnover.rows.map((r) => [r.direction, r.total, r.n, r.average]).sort(), [['in', 15800, 4, 3950], ['out', 6000, 1, 6000]]);

// reach(): when a goal can be bought, when money runs out.
await save('Goals', { name: 'Bike', price: 45000 });
await save('Goals', { name: 'Car', price: 5000000 });
const goals = await data.compute(T('Goals'), await data.all('Goals'));
check('reach(): the first day the forecast meets the price', goals.map((g) => [g.name, g.when]), [['Bike', '2026-10-15'], ['Car', null]]);
const env = await data.scope(T('Goals'), ["reach('Forecast', 'assets', '<=', 0, 'period', 'next:5y')"]);
const zero = evaluate(parseCached("reach('Forecast', 'assets', '<=', 0, 'period', 'next:5y')"), env({}));
// The card ends month k at 10 000 − 1 000k; with the 41 085 in cash that is ≤ 0 from k = 52: January 2031, after the rent.
check('reach(): when the money on the accounts runs out', zero, '2031-01-31');
const withGoals = await runReport(data, config.reports[0], { period: { kind: 'next:1m' } }, now);
check('levels from a table: one per goal', (withGoals.refLines ?? []).map((l) => l.title), ['zero', 'Bike', 'Car']);
void now;

done('reports');
