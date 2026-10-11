/**
 * Posting and the rules around it: conditional rules (one document is an
 * income, an expense or a transfer), movements of catalog records (an opening
 * balance), the date of a movement, a closed period, a trigger that refuses a
 * delete, and checks that only warn.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/data', 'core/registers', 'core/actions', 'core/config/types', 'core/config/validate', '../plugins/builtin/local/store');
const { DataService, ValidationError, installPosting, installTriggers, emptyConfig, validateConfig, Store, memoryAdapter } = M;

const f = (name, type, extra = {}) => ({ key: `f_${name}`, name, type, ...extra });
const config = emptyConfig('Posting');
config.tables = [
  {
    key: 't_acc',
    name: 'Accounts',
    kind: 'catalog',
    title: 'Accounts',
    fields: [f('name', 'string'), f('currency', 'string'), f('opening', 'decimal'), f('balance', 'decimal', { computed: "balance('Money', 'amount', 'account', id)" })],
    posting: [{ key: 'po_open', register: 'Money', from: 'header', direction: 'in', when: 'opening <> 0', set: { account: 'id', currency: 'currency', amount: 'opening' } }],
  },
  {
    key: 't_ops',
    name: 'Ops',
    kind: 'document',
    title: 'Ops',
    fields: [f('type', 'string'), f('account', 'ref', { ref: 'Accounts' }), f('toAccount', 'ref', { ref: 'Accounts' }), f('amount', 'decimal'), f('amountTo', 'decimal'), f('note', 'string')],
    posting: [
      { key: 'po_in', register: 'Money', from: 'header', direction: 'in', when: "type = 'income'", set: { account: 'account', currency: 'account.currency', amount: 'amount' } },
      { key: 'po_out', register: 'Money', from: 'header', direction: 'out', when: "type in ('expense', 'transfer')", set: { account: 'account', currency: 'account.currency', amount: 'amount' } },
      { key: 'po_to', register: 'Money', from: 'header', direction: 'in', when: "type = 'transfer'", set: { account: 'toAccount', currency: 'toAccount.currency', amount: 'coalesce(amountTo, amount)' } },
    ],
    lockedWhen: "date <= maxOf('Closings', 'date', 'posted')",
    validations: [{ when: 'amount > 10000', message: 'A large amount: check it', level: 'warning' }],
  },
  {
    key: 't_close',
    name: 'Closings',
    kind: 'document',
    title: 'Closings',
    fields: [f('note', 'string')],
  },
  {
    key: 't_money',
    name: 'Money',
    kind: 'register',
    title: 'Money',
    registerKind: 'balance',
    fields: [f('account', 'ref', { ref: 'Accounts', role: 'dimension' }), f('currency', 'string', { role: 'dimension' }), f('amount', 'decimal', { role: 'resource' })],
  },
];
config.triggers = [
  {
    key: 'tr_last',
    table: 'Closings',
    event: 'beforeDelete',
    steps: [{ type: 'if', when: "date < maxOf('Closings', 'date')", steps: [{ type: 'stop', text: 'Only the last closing can be deleted' }] }],
  },
];
check('the configuration has no problems', validateConfig(config), []);

let now = new Date(2026, 9, 8, 12, 0, 0);
const store = new Store(memoryAdapter());
const data = new DataService(config, { user: () => 'tester', now: () => now });
data.link('main', store, store.capabilities());
installPosting(data);
installTriggers(data);
const notices = [];
data.onNotice = (messages) => notices.push(...messages);
const T = (name) => data.table(name);
const save = (name, row, previous = null) => data.save(T(name), { id: '', ...row }, previous);
const refused = async (what, fn) => {
  try {
    await fn();
    return 'saved';
  } catch (error) {
    return error instanceof ValidationError ? error.problems.map((p) => p.message).join('; ') : `other: ${error.message}`;
  }
};
const moves = async (recorder) => (await data.all('Money')).filter((m) => m.recorder === recorder).map((m) => [m.direction, m.currency, m.amount]);
const balances = async () => Object.fromEntries((await data.compute(T('Accounts'), await data.all('Accounts'))).map((a) => [a.name, a.balance]));

// A catalog record posts its opening balance when it is created, dated then.
const card = await save('Accounts', { name: 'Card', currency: 'UAH', opening: 1000 });
const cash = await save('Accounts', { name: 'Cash', currency: 'USD', opening: 0 });
check('an opening balance is a movement of the record', await moves(card.id), [['in', 'UAH', 1000]]);
check('a rule with a condition that does not hold makes none', await moves(cash.id), []);
check('the movement is dated when the record was created', (await data.all('Money')).find((m) => m.recorder === card.id).date, '2026-10-08T12:00:00');
const card2 = await save('Accounts', { ...card, opening: 1200 }, card);
check('a changed opening balance rewrites the movement', await moves(card.id), [['in', 'UAH', 1200]]);

// One document, three kinds of operation.
const income = await save('Ops', { date: '2026-10-01T09:00:00', type: 'income', account: card.id, amount: 500, posted: true });
const expense = await save('Ops', { date: '2026-10-02T09:00:00', type: 'expense', account: card.id, amount: 200, posted: true });
const transfer = await save('Ops', { date: '2026-10-03T09:00:00', type: 'transfer', account: card.id, toAccount: cash.id, amount: 415, amountTo: 10, posted: true });
check('an income goes in', await moves(income.id), [['in', 'UAH', 500]]);
check('an expense goes out', await moves(expense.id), [['out', 'UAH', 200]]);
check('a transfer between currencies: out of one, the amount credited into the other', await moves(transfer.id), [['out', 'UAH', 415], ['in', 'USD', 10]]);
check('balances', await balances(), { Card: 1085, Cash: 10 });

// The date of a movement from an expression.
const dated = structuredClone(config);
dated.tables[1].posting[0].date = "addDays(date, 1)";
data.setConfig(dated);
const late = await save('Ops', { date: '2026-10-04T09:00:00', type: 'income', account: cash.id, amount: 1, posted: true });
check('a movement dated by its rule', (await data.all('Money')).find((m) => m.recorder === late.id).date, '2026-10-05T09:00:00');
await data.remove(T('Ops'), late);
data.setConfig(config);

// Warnings do not stop the save, and are told.
const big = await save('Ops', { date: '2026-10-04T10:00:00', type: 'income', account: card.id, amount: 20000, posted: true });
check('a warning: saved all the same', !!big.id, true);
check('a warning: told', notices, ['A large amount: check it']);
await data.remove(T('Ops'), big);

// A closed period: posted records in it are frozen, nothing more is posted into it.
const closing = await save('Closings', { date: '2026-10-05T23:59:59', posted: true });
check('editing a posted record in the closed period is refused', await refused('edit', () => save('Ops', { ...expense, amount: 250 }, expense)), 'The record is in a closed period: it cannot be posted, and what is posted there cannot be changed');
check('unposting it is refused', /closed period/.test(await refused('unpost', () => save('Ops', { ...expense, posted: false }, expense))), true);
check('deleting it is refused', /closed period/.test(await refused('delete', () => data.remove(T('Ops'), expense))), true);
check('posting a new record into the closed period is refused', /closed period/.test(await refused('new', () => save('Ops', { date: '2026-10-04T09:00:00', type: 'expense', account: card.id, amount: 1, posted: true }))), true);
const note = await save('Ops', { date: '2026-10-04T09:00:00', type: 'expense', account: card.id, amount: 1, posted: false, note: 'forgot to write it down' });
check('kept unposted, as a note: saved, no movements', [!!note.id, await moves(note.id)], [true, []]);
const after = await save('Ops', { date: '2026-10-06T09:00:00', type: 'expense', account: card.id, amount: 85, posted: true });
check('after the closed period: posted', await moves(after.id), [['out', 'UAH', 85]]);
check('balances unchanged by what was refused', await balances(), { Card: 1000, Cash: 10 });
void card2;

// A trigger that refuses a delete; the last closing can go, and with it the lock.
const second = await save('Closings', { date: '2026-10-07T23:59:59', posted: true });
check('beforeDelete: an earlier closing is kept', await refused('delete', () => data.remove(T('Closings'), closing)), 'Only the last closing can be deleted');
check('beforeDelete: the last one goes', await refused('delete', () => data.remove(T('Closings'), second)), 'saved');
check('the earlier one is there', (await data.all('Closings')).length, 1);
await data.remove(T('Closings'), (await data.all('Closings'))[0]);
check('without closings the period opens again', await refused('edit', () => save('Ops', { ...expense, amount: 250 }, expense)), 'saved');

// The designer's checks.
const wrong = structuredClone(config);
wrong.tables[3].posting = [{ key: 'x', register: 'Money', from: 'header', direction: 'in', set: {} }];
wrong.tables[1].posting[0].when = 'nope = 1';
wrong.tables[1].lockedWhen = 'nope2';
const problems = validateConfig(wrong).map((p) => p.message);
check('a register posting into a register', problems.some((m) => /has no posting rules of its own/.test(m)), true);
check('a rule’s condition checked', problems.some((m) => /“nope” is not found/.test(m)), true);
check('the closed period’s expression checked', problems.some((m) => /“nope2” is not found/.test(m)), true);
void now;

done('posting');
