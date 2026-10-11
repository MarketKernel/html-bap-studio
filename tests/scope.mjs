/**
 * What expressions reach beyond their record (core/scope.ts): constants,
 * aggregates over tables and parts with conditions and `$this`, a table that
 * aggregates itself, register balances on now and on a date; the designer's
 * checks of all that; and that a list costs a fixed number of queries.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/data', 'core/format', 'core/expr/index', 'core/registers', 'core/config/types', 'core/config/validate', 'core/config/diff', '../plugins/builtin/local/store');
const { DataService, evaluate, parseCached, installPosting, emptyConfig, validateConfig, schemaDiff, Store, memoryAdapter, scaled, formatValue } = M;

const f = (name, type, extra = {}) => ({ key: `f_${name}`, name, type, ...extra });
const config = emptyConfig('Scope');
config.constants = [f('base', 'ref', { ref: 'Currencies' }), f('windowDays', 'integer', { default: '90' })];
config.tables = [
  {
    key: 't_cur',
    name: 'Currencies',
    kind: 'catalog',
    title: 'Currencies',
    fields: [f('code', 'string'), f('rate', 'decimal', { scale: 4 }), f('accounts', 'integer', { computed: 'countOf(\'Accounts\', "currency = $this.id")' })],
  },
  {
    key: 't_acc',
    name: 'Accounts',
    kind: 'catalog',
    title: 'Accounts',
    fields: [
      f('name', 'string'),
      f('kind', 'string'),
      f('currency', 'ref', { ref: 'Currencies' }),
      f('balance', 'decimal', { computed: "balance('Money', 'amount', 'account', id)" }),
      f('value', 'decimal', { computed: 'balance * currency.rate' }),
      f('share', 'decimal', { scale: 4, computed: "value / sumOf('Accounts', 'value')" }),
    ],
  },
  {
    key: 't_ops',
    name: 'Ops',
    kind: 'document',
    title: 'Ops',
    fields: [f('account', 'ref', { ref: 'Accounts' }), f('amount', 'decimal')],
    posting: [{ key: 'po', register: 'Money', from: 'header', direction: 'in', set: { account: 'account', amount: 'amount' } }],
  },
  {
    key: 't_recs',
    name: 'Recs',
    kind: 'document',
    title: 'Recs',
    fields: [
      f('prevDate', 'datetime', { computed: 'maxOf(\'Recs\', \'date\', "date < $this.date")' }),
      f('total', 'decimal', { computed: 'sum(lines.diff)' }),
    ],
    parts: [{ key: 'p_l', name: 'lines', fields: [f('account', 'ref', { ref: 'Accounts' }), f('diff', 'decimal')] }],
  },
  {
    key: 't_money',
    name: 'Money',
    kind: 'register',
    title: 'Money',
    registerKind: 'balance',
    fields: [f('account', 'ref', { ref: 'Accounts', role: 'dimension' }), f('amount', 'decimal', { role: 'resource' })],
  },
];
check('the configuration has no problems', validateConfig(config), []);

const now = new Date(2026, 9, 8, 12, 0, 0);
const store = new Store(memoryAdapter());
let queries = 0;
const query = store.query.bind(store);
store.query = (q) => {
  queries += 1;
  return query(q);
};
const data = new DataService(config, { user: () => 'tester', now: () => now });
data.link('main', store, store.capabilities());
installPosting(data);
const T = (name) => data.table(name);
const save = (name, row) => data.save(T(name), { id: '', ...row }, null);

const uah = await save('Currencies', { code: 'UAH', rate: 1 });
const usd = await save('Currencies', { code: 'USD', rate: 41.5 });
await data.save(T('_constants'), { id: 'constants', base: uah.id, windowDays: 90 }, null);
const card = await save('Accounts', { name: 'Card', kind: 'asset', currency: uah.id });
const cash = await save('Accounts', { name: 'Cash', kind: 'asset', currency: usd.id });
const loan = await save('Accounts', { name: 'Loan', kind: 'debt', currency: uah.id });
await save('Ops', { date: '2026-10-01T09:00:00', account: card.id, amount: 1000, posted: true });
await save('Ops', { date: '2026-10-05T09:00:00', account: cash.id, amount: 100, posted: true });
await save('Ops', { date: '2026-10-06T09:00:00', account: loan.id, amount: -500, posted: true });
// Dated after now: not in the balance on now.
await save('Ops', { date: '2026-10-20T09:00:00', account: card.id, amount: 300, posted: true });

/** An expression over one record of a table, with everything it reaches loaded. */
async function ev(source, row = {}, tableName = 'Accounts') {
  const envOf = await data.scope(T(tableName), [source]);
  return evaluate(parseCached(source), envOf(row));
}

check('constants: a reference walked', await ev('$const.base.code'), 'UAH');
check('constants: a number', await ev('$const.windowDays * 2'), 180);
check('balance is on now: a later movement is not in it', await ev("balance('Money', 'amount', 'account', id)", card), 1000);
check('balanceAt a later date takes it in', await ev("balanceAt('Money', 'amount', '2026-10-20', 'account', id)", card), 1300);
check('balanceAt a date takes in its whole day', await ev("balanceAt('Money', 'amount', '2026-10-05', 'account', $this.id)", cash), 100);
check('balanceAt before the first movement', await ev("balanceAt('Money', 'amount', '2026-09-30', 'account', id)", card), 0);
check('turnoverBetween: the values, whatever their direction', await ev("turnoverBetween('Money', 'amount', '2026-10-02', '2026-10-31')"), -100);

const accounts = await data.compute(T('Accounts'), await data.all('Accounts'));
check('computed over a balance and a reference', accounts.map((a) => [a.name, a.balance, a.value]), [['Card', 1000, 1000], ['Cash', 100, 4150], ['Loan', -500, -500]]);
check('sumOf over a computed field', await ev("sumOf('Accounts', 'value')"), 4650);
check('sumOf with a condition', await ev('sumOf(\'Accounts\', \'value\', "kind = \'debt\'")'), -500);
check('a condition walks references', await ev('sumOf(\'Accounts\', \'balance\', "currency.code = \'USD\'")'), 100);
check('countOf with and without a condition', [await ev("countOf('Accounts')"), await ev('countOf(\'Accounts\', "kind = \'asset\'")')], [3, 2]);
check('avgOf, minOf, maxOf', [await ev("avgOf('Accounts', 'balance')"), await ev("minOf('Accounts', 'balance')"), await ev("maxOf('Ops', 'date')")], [200, -500, '2026-10-20T09:00:00']);
check('firstOf and lastOf: by date by default', [await ev("firstOf('Ops', 'amount')"), await ev("lastOf('Ops', 'amount')")], [1000, 300]);
check('lastOf with a condition and a sort field', await ev('lastOf(\'Ops\', \'amount\', "amount < 1000", \'amount\')'), 300);
check('an empty table gives 0 to sum and count, null to the rest', [await ev('sumOf(\'Ops\', \'amount\', "amount > 9999")'), await ev('countOf(\'Ops\', "amount > 9999")'), await ev('maxOf(\'Ops\', \'amount\', "amount > 9999")')], [0, 0, null]);
check('a condition built at run time reads the rows', await ev("countOf('Accounts', 'kind = ' & \"'debt'\")"), 1);
check('a per-row condition with $this', (await data.compute(T('Currencies'), await data.all('Currencies'))).map((c) => [c.code, c.accounts]), [['UAH', 2], ['USD', 1]]);
check('an aggregate of the table a field belongs to', accounts.map((a) => a.share), [0.2151, 0.8925, -0.1075]);

// Parts: one row per line, with the document as doc.
const r1 = await save('Recs', { date: '2026-10-01T10:00:00', posted: true, lines: [{ account: card.id, diff: -100 }, { account: cash.id, diff: 5 }] });
await save('Recs', { date: '2026-10-07T10:00:00', posted: true, lines: [{ account: card.id, diff: -50 }] });
await save('Recs', { date: '2026-10-08T10:00:00', posted: false, lines: [{ account: card.id, diff: -7 }] });
check('sumOf over a part', await ev("sumOf('Recs.lines', 'diff')"), -152);
check('a condition on the document of a line', await ev('sumOf(\'Recs.lines\', \'diff\', "doc.posted")'), -145);
check('a condition with the line and $this', await ev('sumOf(\'Recs.lines\', \'diff\', "doc.posted and account = $this.id")', card), -150);
const recs = await data.compute(T('Recs'), await data.all('Recs'));
check('a table aggregating itself: the previous date', recs.map((r) => r.prevDate), [null, '2026-10-01T10:00:00', '2026-10-07T10:00:00']);
check('a condition nesting another aggregate', await ev('sumOf(\'Recs\', \'total\', "date >= maxOf(\'Recs\', \'date\', \'posted\')")'), -57);
void r1;

// A list of many records costs the same few queries as a list of one.
for (let i = 0; i < 40; i++) await save('Accounts', { name: `A${i}`, kind: 'asset', currency: uah.id });
queries = 0;
await data.compute(T('Accounts'), await data.all('Accounts'));
const many = queries;
check('a list costs a fixed number of queries', many <= 8, true);

// The designer's checks.
const broken = structuredClone(config);
broken.tables[1].fields.push(f('bad1', 'decimal', { computed: "sumOf('Nope', 'x')" }));
broken.tables[1].fields.push(f('bad2', 'decimal', { computed: "sumOf('Accounts', 'nope')" }));
broken.tables[1].fields.push(f('bad3', 'decimal', { computed: 'sumOf(\'Accounts\', \'value\', "nope > 1")' }));
broken.tables[1].fields.push(f('bad4', 'decimal', { computed: "balanceAt('Money', 'amount')" }));
broken.tables.push({ key: 't_x', name: '_x', kind: 'table', title: 'X', fields: [] });
const problems = validateConfig(broken).map((p) => p.message);
check('unknown table in an aggregate', problems.some((m) => /“Nope” does not exist/.test(m)), true);
check('unknown field of the table aggregated', problems.some((m) => /has no field “nope”/.test(m)), true);
check('a condition is checked against the table searched', problems.some((m) => /“nope” is not found/.test(m)), true);
check('arguments of a host function counted', problems.some((m) => /balanceAt” takes at least 3/.test(m)), true);
check('a table may not be named like the studio’s own', problems.some((m) => /must not start with “_”/.test(m)), true);

// Constants in the schema: a renamed constant is a rename.
const renamed = structuredClone(config);
renamed.constants[1].name = 'days';
check('a constant renamed', schemaDiff(config, renamed), [{ op: 'renameField', table: '_constants', from: 'windowDays', to: 'days' }]);
const fewer = structuredClone(config);
delete fewer.constants;
check('the constants removed', schemaDiff(config, fewer), [{ op: 'dropTable', table: '_constants' }]);

// Decimals from a field of the same record: an amount in a currency of its own precision.
const amount = { key: 'a', name: 'amount', type: 'decimal', scale: 2, scaleFrom: 'decimals' };
check('scaleFrom: the record says 8', scaled(amount, { decimals: 8 }).scale, 8);
check('scaleFrom: no number there, the field’s own', scaled(amount, { decimals: null }).scale, 2);
check('scaleFrom: formatted with it', formatValue(scaled(amount, { decimals: 0 }), 1234), formatValue({ type: 'integer' }, 1234));
const withScale = structuredClone(config);
withScale.tables[2].fields.push(f('decimals', 'integer', { computed: '0' }), f('whole', 'decimal', { scaleFrom: 'decimals', computed: 'amount / 3' }), f('wrong', 'decimal', { scaleFrom: 'nope' }));
check('scaleFrom must name a number field beside it', validateConfig(withScale).map((p) => p.message), ['Field “wrong” takes its decimals from “nope”, which is not a number field beside it']);
data.setConfig(withScale);
check('a computed amount rounded to the record’s decimals', (await data.compute(data.table('Ops'), await data.all('Ops'))).map((o) => o.whole), [333, 33, -167, 100]);
data.setConfig(config);

done('scope');
