/**
 * Data in time: when a schedule comes round (the vectors of Cashflow's
 * tests/schedule.mjs, in local calendar terms), versioned records (an edit
 * opens a version from now, a delete closes it), and the movements schedules
 * plan into a register — counted as made once their moment has passed, the
 * future ones a forecast; a closed version keeps the past as it was.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/schedule', 'core/data', 'core/expr/index', 'core/registers', 'core/reports', 'core/config/types', 'core/config/validate', '../plugins/builtin/local/store');
const S = M;
const { DataService, evaluate, parseCached, installPosting, runReport, emptyConfig, validateConfig, Store, memoryAdapter } = M;

const at = (y, m, d, h = 0, min = 0) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
const days = (list) => list.map((t) => `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}`);
const clock = (list) => [...new Set(list.map((t) => t.slice(11, 16)))];

// From Cashflow: daily at 09:00, from 1 Oct 10:00 to 8 Oct 10:00.
const daily = { every: 'day', time: '09:00' };
check('daily 09:00, 1 Oct 10:00 … 8 Oct 10:00: 2 … 8 October', days(S.occurrences(daily, at(2026, 10, 1, 10), at(2026, 10, 8, 10))), ['02.10.2026', '03.10.2026', '04.10.2026', '05.10.2026', '06.10.2026', '07.10.2026', '08.10.2026']);
check('the week of the change to winter time: 7 times at 09:00', [S.occurrences(daily, at(2026, 10, 22), at(2026, 10, 29)).length, clock(S.occurrences(daily, at(2026, 10, 22), at(2026, 10, 29)))], [7, ['09:00']]);
check('the week of the change to summer time: 7 times at 09:00', [S.occurrences(daily, at(2027, 3, 25), at(2027, 4, 1)).length, clock(S.occurrences(daily, at(2027, 3, 25), at(2027, 4, 1)))], [7, ['09:00']]);
check('monthly on the 31st, 1 Jan – 1 May 2027', days(S.occurrences({ every: 'month', day: 31 }, at(2027, 1, 1), at(2027, 5, 1))), ['31.01.2027', '28.02.2027', '31.03.2027', '30.04.2027']);
check('the last day: 28, 29, 30, 31', days(S.occurrences({ every: 'month', day: 'last' }, at(2028, 1, 15), at(2028, 5, 1))), ['31.01.2028', '29.02.2028', '31.03.2028', '30.04.2028']);
check('yearly on 29 February, 2027 – 2029', days(S.occurrences({ every: 'year', month: 2, day: 29 }, at(2027, 1, 1), at(2029, 12, 31))), ['28.02.2027', '29.02.2028', '28.02.2029']);
const weekly = { every: 'week', time: '18:30', weekday: 5 };
check('weekly on Fridays at 18:30', [days(S.occurrences(weekly, at(2026, 10, 1), at(2026, 10, 31))), clock(S.occurrences(weekly, at(2026, 10, 1), at(2026, 10, 31)))], [['02.10.2026', '09.10.2026', '16.10.2026', '23.10.2026', '30.10.2026'], ['18:30']]);
check('(after, to]: the moment `after` itself is out', S.occurrences(daily, at(2026, 10, 2, 9), at(2026, 10, 3, 9)).length, 1);
check('…unless inclusive: the start of a version', S.occurrences(daily, at(2026, 10, 2, 9), at(2026, 10, 3, 9), 100, true).length, 2);
check('nothing in an empty interval', S.occurrences(daily, at(2026, 10, 5), at(2026, 10, 5)), []);
check('within its own from and until', days(S.occurrences({ every: 'day', from: '2026-10-03', until: '2026-10-05' }, at(2026, 10, 1), at(2026, 10, 9))), ['03.10.2026', '04.10.2026', '05.10.2026']);
const started = performance.now();
check('five years of a daily operation: 1 826', S.occurrences(daily, at(2026, 10, 7), at(2031, 10, 7)).length, 1826);
check('…quickly', performance.now() - started < 50, true);
check('a month of a daily and of a weekly one', [S.perMonth({ every: 'day' }).toFixed(2), S.perMonth({ every: 'week' }).toFixed(3)], ['30.44', '4.348']);
check('the next one', S.nextOccurrence({ every: 'month', day: 15, time: '09:00' }, at(2026, 10, 15, 9)), at(2026, 11, 15, 9));
check('a stored schedule read, a broken one refused', [S.readSchedule('{"every":"week","weekday":9}'), S.readSchedule({ every: 'hourly' })], [{ every: 'week', weekday: 7 }, null]);

// The expression functions.
const ev = (source) => evaluate(parseCached(source), { resolve: () => null, now: () => new Date(2026, 9, 8, 12) });
check('schedule() and nextOccurrence()', ev("nextOccurrence(schedule('month', '09:00', 'last'), '2026-10-08')"), '2026-10-31T09:00:00');
check('occurrences() counted', ev("count(occurrences(schedule('week', '10:00', 1), '2026-10-01', '2026-10-31'))"), 4);
check('perMonth()', ev("round(perMonth(schedule('day')), 2)"), 30.44);

// Versioned records and the movements their schedules plan.
const f = (name, type, extra = {}) => ({ key: `f_${name}`, name, type, ...extra });
const config = emptyConfig('Time');
config.tables = [
  { key: 't_acc', name: 'Accounts', kind: 'catalog', title: 'Accounts', fields: [f('name', 'string'), f('balance', 'decimal', { computed: "balance('Money', 'amount', 'account', id)" })] },
  {
    key: 't_rec',
    name: 'Recurring',
    kind: 'catalog',
    title: 'Recurring',
    versioned: true,
    fields: [f('name', 'string'), f('type', 'string'), f('account', 'ref', { ref: 'Accounts' }), f('amount', 'decimal'), f('when', 'schedule'), f('next', 'datetime', { computed: 'nextOccurrence(when, now())' })],
    posting: [
      { key: 'po_in', register: 'Money', from: 'schedule', schedule: 'when', direction: 'in', when: "type = 'income'", set: { account: 'account', amount: 'amount' } },
      { key: 'po_out', register: 'Money', from: 'schedule', schedule: 'when', direction: 'out', when: "type = 'expense'", set: { account: 'account', amount: 'amount' } },
    ],
  },
  { key: 't_money', name: 'Money', kind: 'register', title: 'Money', registerKind: 'balance', fields: [f('account', 'ref', { ref: 'Accounts', role: 'dimension' }), f('amount', 'decimal', { role: 'resource' })] },
];
config.reports = [{ key: 'r', name: 'Ahead', title: 'Ahead', source: 'Money', mode: 'balance', groupBy: ['account'], measures: [{ name: 'amount', fn: 'sum', field: 'amount' }], params: [{ name: 'period', type: 'period' }] }];
check('the configuration has no problems', validateConfig(config), []);

let now = new Date(2026, 9, 1, 8, 0, 0);
const store = new Store(memoryAdapter());
const data = new DataService(config, { user: () => 'tester', now: () => now });
data.link('main', store, store.capabilities());
installPosting(data);
const T = (name) => data.table(name);
const save = (name, row, previous = null) => data.save(T(name), { id: '', ...row }, previous);
const balanceAt = async (account, date) => evaluate(parseCached(`balanceAt('Money', 'amount', '${date}', 'account', $this.id)`), (await data.scope(T('Accounts'), [`balanceAt('Money', 'amount', '${date}', 'account', $this.id)`]))(account));
const card = await save('Accounts', { name: 'Card' });

// A salary on the 15th and coffee every morning, from 1 October 08:00.
const salary = await save('Recurring', { name: 'Salary', type: 'income', account: card.id, amount: 1000, when: { every: 'month', day: 15, time: '09:00' } });
const coffee = await save('Recurring', { name: 'Coffee', type: 'expense', account: card.id, amount: 3, when: { every: 'day', time: '09:00' } });
check('a new version: its own series, in force from now', [coffee.seriesId === coffee.id, coffee.validFrom, coffee.validTo], [true, '2026-10-01T08:00:00', null]);
check('a computed field over the schedule', salary.next, '2026-10-15T09:00:00');
check('nothing planned is stored', (await data.all('Money')).length, 0);

now = new Date(2026, 9, 8, 12, 0, 0);
const after8 = (await data.compute(T('Accounts'), [await data.get('Accounts', card.id)]))[0].balance;
check('a week of coffee has been drunk by now: 8 × 3', after8, -24);
check('a forecast is a balance at a later date', await balanceAt(card, '2026-10-31'), 1000 - 31 * 3);
check('…the coffee of the 31st itself is in', await balanceAt(card, '2026-10-31') - (await balanceAt(card, '2026-10-30')), -3);
check('the register’s movements with the planned ones up to now', (await data.movements('Money')).filter((m) => m.planned).length, 8);
check('…or up to a date', (await data.movements('Money', '2026-10-15T09:00:00')).filter((m) => m.recorder === salary.id).map((m) => [m.direction, m.amount, m.date]), [['in', 1000, '2026-10-15T09:00:00']]);

// An edit opens a new version from now: the past is planned by the old one.
const coffee2 = await save('Recurring', { ...coffee, amount: 4 }, coffee);
check('an edit opens a new version', [coffee2.id !== coffee.id, coffee2.seriesId, coffee2.validFrom, coffee2.amount], [true, coffee.id, '2026-10-08T12:00:00', 4]);
check('…and closes the old one', (await data.get('Recurring', coffee.id)).validTo, '2026-10-08T12:00:00');
check('the past is the same', (await data.compute(T('Accounts'), [await data.get('Accounts', card.id)]))[0].balance, -24);
check('the future follows the new version', await balanceAt(card, '2026-10-10'), -24 - 2 * 4);
check('asOf: a version as it was', evaluate(parseCached("asOf('Recurring', $this.seriesId, '2026-10-05', 'amount')"), (await data.scope(T('Recurring'), ["asOf('Recurring', $this.seriesId, '2026-10-05', 'amount')"]))(coffee2)), 3);
const same = await save('Recurring', { ...coffee2 }, coffee2);
check('a save that changes nothing makes no new version', same.id, coffee2.id);
try {
  await save('Recurring', { ...coffee, amount: 9 }, await data.get('Recurring', coffee.id));
  check('a closed version is history', 'saved', 'refused');
} catch (error) {
  check('a closed version is history', /closed/.test(error.message), true);
}

// A delete closes the version: the coffee drunk stays drunk.
now = new Date(2026, 9, 10, 12, 0, 0);
await data.remove(T('Recurring'), await data.get('Recurring', coffee2.id));
check('a delete closes the version', (await data.get('Recurring', coffee2.id))?.validTo, '2026-10-10T12:00:00');
check('what it planned until then stays', await balanceAt(card, '2026-10-10'), -32);
check('nothing after', await balanceAt(card, '2026-10-31'), -32 + 1000);
check('aggregates see the versions in force', evaluate(parseCached("countOf('Recurring')"), (await data.scope(T('Accounts'), ["countOf('Recurring')"]))({})), 1);

// A report of balances at the end of a period ahead: a forecast.
const report = await runReport(data, config.reports[0], { period: { kind: 'custom', to: '2026-12-31' } }, now);
check('a report over a period ahead takes in the planned movements', report.rows.map((r) => r.amount), [-32 + 3000]);

// The designer's checks.
const wrong = structuredClone(config);
wrong.tables[1].posting[0].schedule = 'name';
wrong.tables[2].versioned = true;
const problems = validateConfig(wrong).map((p) => p.message);
check('a rule by a schedule needs a schedule field', problems.some((m) => /“name” is not one/.test(m)), true);
check('a register is not versioned', problems.some((m) => /cannot be versioned/.test(m)), true);

done('time');
