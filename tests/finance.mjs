/**
 * The "Personal finances" template against Cashflow (Task_next.md 6): the
 * same accounts, operations and reconciliations kept by the configuration
 * and by Cashflow's own core, and the same numbers out of both — the worth of
 * the accounts with their fees, the unaccounted money, its pace, and the day
 * the money runs out. Cashflow's core is read from the repository beside this
 * one; without it, only this side's fixed numbers are checked.
 *
 * In Europe/Kyiv, where 25 October 2026 has 25 hours.
 */
process.env.TZ = 'Europe/Kyiv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checker, load, root } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/data', 'core/registers', 'core/actions', 'core/reports', 'core/config/validate', '../plugins/builtin/local/store', 'app/templates');
const { DataService, ValidationError, installPosting, installTriggers, validateConfig, runAction, evaluator, Store, memoryAdapter, TEMPLATES } = M;
const cashflowAt = join(root, '..', 'cashflow', 'src', 'core', 'forecast.ts');
const C = existsSync(cashflowAt) ? await load('../../cashflow/src/core/state', '../../cashflow/src/core/reconcile', '../../cashflow/src/core/forecast') : null;
if (!C) console.log('  (no ../cashflow beside this repository: Cashflow’s own numbers are not compared)');

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const ms = (d) => d.getTime();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
const dayOf = (t) => (t === null || t === undefined ? null : iso(new Date(t)).slice(0, 10));
const near = (a, b) => Math.abs(a - b) < 0.01;

const tpl = TEMPLATES.find((x) => x.id === 'finance-empty');
const config = tpl.config();
check('the template has no problems', validateConfig(config), []);

let now = at(2026, 10, 1, 9);
const store = new Store(memoryAdapter());
const data = new DataService(config, { user: () => 'tester', now: () => now });
data.link('main', store, store.capabilities());
installPosting(data);
installTriggers(data);
const T = (name) => data.table(name);
const save = (name, row, previous = null) => data.save(T(name), { id: '', ...row }, previous);
const ev = async (source) => (await evaluator(data, [source]))(source);
const refused = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof ValidationError ? error.problems.map((p) => p.message).join('; ') : `other: ${error.message}`;
  }
};

// Cashflow's accounts (its tests/fixture.mjs): base UAH, USD 41.5, EUR 45.
const uah = await save('Currencies', { code: 'UAH', rate: 1 });
const usd = await save('Currencies', { code: 'USD', rate: 41.5 });
const eur = await save('Currencies', { code: 'EUR', rate: 45 });
await data.save(T('_constants'), { id: 'constants', base: uah.id, horizonYears: 5, windowDays: 90 }, null);
const account = (name, kind, currency, fee, opening) => save('Accounts', { name, kind, currency: currency.id, fee, opening, openedOn: '2026-10-01' });
const mono = await account('Monobank', 'asset', uah, 0, 20000);
const wise = await account('Wise', 'asset', usd, 1, 1000);
await account('Cash', 'asset', eur, 0, 500);
await account('Card', 'debt', uah, 0, 15000);
await account('Friend', 'debt', usd, 2, 200);
const accounts = Object.fromEntries((await data.compute(T('Accounts'), await data.all('Accounts'))).map((a) => [a.name, [a.shown, a.value]]));
check('1 000 USD with a 1 % fee is 41 085 UAH', accounts.Wise, [1000, 41085]);
check('a 200 USD debt with a 2 % fee is 8 466 owed', accounts.Friend, [200, -8466]);
check('personal money: the accounts minus the debts', await ev("sumOf('Money', 'worth')"), 20000 + 41085 + 22500 - 15000 - 8466);
check('on the accounts', await ev("sumOf('Money', 'worth', \"coalesce(account.kind, 'asset') <> 'debt'\")"), 83585);

const cf = C ? C.emptyState('UAH', ms(now)) : null;
if (cf) {
  cf.currencies.push({ code: 'USD', rate: 41.5, decimals: 2, updatedAt: ms(now) }, { code: 'EUR', rate: 45, decimals: 2, updatedAt: ms(now) });
  const acc = (id, name, kind, currency, fee, opening, order) => ({ id, name, kind, currency, fee, opening, createdAt: ms(now), order });
  cf.accounts.push(acc('mono', 'Monobank', 'asset', 'UAH', 0, 2000000, 0), acc('wise', 'Wise', 'asset', 'USD', 1, 100000, 1), acc('cash', 'Cash', 'asset', 'EUR', 0, 50000, 2), acc('card', 'Card', 'debt', 'UAH', 0, 1500000, 3), acc('friend', 'Friend', 'debt', 'USD', 2, 20000, 4));
}

// The first reconciliation: the balances as they are; nothing is unaccounted.
now = at(2026, 10, 1, 10);
const reconcile = async (change = {}) => {
  const r = await data.newRecord(T('Reconciliations'));
  const lines = r.lines.map((l) => (change[l.account] !== undefined ? { ...l, actual: change[l.account] } : l));
  return save('Reconciliations', { ...r, lines, posted: true });
};
const first = await reconcile();
check('the first reconciliation: every account, as expected', [first.lines.length, first.unaccounted], [5, 0]);
if (cf) cf.reconciliations.push(C.reconcile(cf, new Map(cf.accounts.map((a) => [a.id, a.opening])), ms(now), 'r1'));

// Recurring from now: a salary on the 15th, rent on the last day, coffee every morning.
const recurring = async (name, type, amount, when) => {
  const r = await save('Recurring', { name, type, account: mono.id, amount, when });
  if (cf) cf.recurring.push({ id: r.id, seriesId: r.id, type, name, amount: amount * 100, accountId: 'mono', currency: 'UAH', schedule: { time: '00:00', ...when }, validFrom: ms(now) });
  return r;
};
await recurring('Salary', 'income', 30000, { every: 'month', day: 15, time: '09:00' });
await recurring('Rent', 'expense', 28000, { every: 'month', day: 'last', time: '18:00' });
const coffee = await recurring('Coffee', 'expense', 200, { every: 'day', time: '09:30' });

// A week later, 1 500 less on Monobank than the records say; the euro has risen meanwhile.
now = at(2026, 10, 8, 10);
await save('Currencies', { ...eur, rate: 46 }, eur);
if (cf) cf.currencies.find((c) => c.code === 'EUR').rate = 46;
check('a week of coffee: expected on Monobank', (await data.newRecord(T('Reconciliations'))).lines.find((l) => l.account === mono.id).expected, 20000 - 7 * 200);
const second = await reconcile({ [mono.id]: 20000 - 7 * 200 - 1500 });
check('−1 500 unaccounted: a change of the rate is not an expense', second.unaccounted, -1500);
if (cf) {
  const entered = new Map(cf.accounts.map((a) => [a.id, a.id === 'mono' ? (20000 - 7 * 200 - 1500) * 100 : a.opening]));
  cf.reconciliations.push(C.reconcile(cf, entered, ms(now), 'r2'));
  check('Cashflow finds the same', near(C.unaccounted(cf.reconciliations[1]), -1500), true);
}
// The pace as the dashboard works it out: the window up to the last reconciliation, after spending was last planned.
const pace = config.dashboards[0].widgets.find((w) => w.key === 'w_pace').value;
check('the pace: −1 500 over 7 days', near(await ev(pace), -1500 / 7), true);
if (cf) check('…as Cashflow learns it', near(C.unaccountedRate(cf, ms(now)).perDay, -1500 / 7), true);

/** The day the money on the accounts, and personal money, reach zero — here and in Cashflow. */
const lasts = async () => [await ev("reach('Horizon', 'assets', '<=', 0)"), await ev("reach('Horizon', 'personal', '<=', 0)")];
const cashflowLasts = () => {
  const f = C.forecast(cf, ms(now));
  return [dayOf(f.assetsZero), dayOf(f.personalZero)];
};
const ours1 = await lasts();
check('the money runs out within the horizon', ours1.every((d) => typeof d === 'string'), true);
if (cf) check('…on the days Cashflow says', ours1, cashflowLasts());

// Planning the unaccounted spending: a daily expense outside the accounts, and the forecast counts on it.
await runAction(data, config.actions.find((a) => a.name === 'PlanUnaccounted'), { vars: { widget: { value: -1500 / 7 } } }, null);
const planned = (await data.all('Recurring')).find((r) => !r.account);
check('planned: the pace starts afresh', await ev(pace), null);
check('planned: a daily expense outside the accounts, in the base currency', [planned?.type, planned?.amount, planned?.currency === uah.id, planned?.when?.every], ['expense', 214.29, true, 'day']);
if (cf) cf.recurring.push({ id: planned.id, seriesId: planned.id, type: 'expense', name: 'Unrecorded', amount: 21429, currency: 'UAH', schedule: { every: 'day', time: '21:00' }, validFrom: ms(now) });
const ours2 = await lasts();
check('the money runs out sooner', ours2[0] < ours1[0], true);
if (cf) check('…on the day Cashflow says', ours2, cashflowLasts());

// Deleting a recurring operation closes it: the past stays as it was.
now = at(2026, 10, 9, 12);
const before = await ev(`balanceAt('Money', 'amount', '${iso(at(2026, 10, 8, 10))}', 'account', '${mono.id}')`);
await data.remove(T('Recurring'), await data.get('Recurring', coffee.id));
if (cf) cf.recurring.find((r) => r.id === coffee.id).validTo = ms(now);
check('the balance on the last reconciliation is the same', await ev(`balanceAt('Money', 'amount', '${iso(at(2026, 10, 8, 10))}', 'account', '${mono.id}')`), before);
check('the reconciliation is the same', (await data.compute(T('Reconciliations'), [await data.get('Reconciliations', second.id)]))[0].unaccounted, -1500);
const ours3 = await lasts();
check('without the coffee it lasts longer', ours3[0] > ours2[0], true);
if (cf) check('…as Cashflow says', ours3, cashflowLasts());

// A one-off dated before the last reconciliation: that money is counted already. It stays a note.
const late = { type: 'expense', account: mono.id, amount: 300, date: iso(at(2026, 10, 7, 12)) };
const note = await save('Operations', { ...late, posted: true });
check('saved as a note: not posted, no movements', [note.posted, (await data.all('Money')).some((m) => m.recorder === note.id)], [false, false]);
const fresh = await save('Operations', { ...late, date: iso(at(2026, 10, 9, 10)) });
check('one dated after it counts at once', fresh.posted, true);
await data.remove(T('Operations'), fresh);
const after = await save('Operations', { type: 'transfer', account: mono.id, toAccount: wise.id, amount: 4150, amountTo: 100, date: iso(at(2026, 10, 9, 11)), posted: true });
check('a transfer between currencies after it: out of one, the amount credited into the other', (await data.all('Money')).filter((m) => m.recorder === after.id).map((m) => [m.direction, m.amount]), [['out', 4150], ['in', 100]]);

// Only the last reconciliation can be deleted.
check('the first one stays: history', /history/.test(await refused(() => data.remove(T('Reconciliations'), first))), true);
check('the last one goes', await refused(() => data.remove(T('Reconciliations'), second)), null);

// The goals: a threshold in the base currency at the bare rate, a date from the forecast.
const goal = await save('Goals', { name: 'Laptop', price: 1000, currency: usd.id, rule: 'margin', margin: 0 });
const [g] = await data.compute(T('Goals'), [goal]);
check('a goal in dollars at the bare rate', g.threshold, 41500);
check('affordable now: today', g.affordable, '2026-10-09');

done('finance');
