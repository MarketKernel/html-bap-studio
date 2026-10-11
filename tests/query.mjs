/**
 * The client-side query engine (src/core/query): filters, sorting, paging,
 * aggregation, grouping and the grid's quick-filter syntax.
 */
import { checker, load } from '../tools/load.mjs';

const Q = await load('core/query/index');
const { check, done } = checker();

const rows = [
  { id: 'a', name: 'Apple', qty: 10, price: 1.5, active: true, date: '2026-10-08', at: '2026-10-08T12:00:00', tag: 'x', _rev: '1' },
  { id: 'b', name: 'banana', qty: 0, price: 0.1, active: false, date: '2026-10-01', at: '2026-10-09T00:00:00', tag: null },
  { id: 'c', name: 'Cherry', qty: 25, price: 0.2, active: null, date: null, at: null, tag: '' },
  { id: 'd', name: null, qty: null, price: null, active: true, date: '2026-09-30', at: '2026-09-30T23:59:59', tag: 'y' },
  { id: 'e', name: 'apricot', qty: '10', price: 2, active: false, date: '2026-11-15', at: '2026-11-15T08:30:00', tag: 'x' },
];
const ids = (filter) => rows.filter((r) => Q.matches(r, filter)).map((r) => r.id);
const c = (field, op, value) => (value === undefined ? { field, op } : { field, op, value });

// getField
check('getField plain', Q.getField(rows[0], 'name'), 'Apple');
check('getField missing is null', Q.getField(rows[0], 'nope'), null);
check('getField undefined value is null', Q.getField({ id: 'x', v: undefined }, 'v'), null);
check('getField nested', Q.getField({ id: 'x', product: { name: 'P', unit: { code: 'kg' } } }, 'product.unit.code'), 'kg');
check('getField nested missing', Q.getField({ id: 'x', product: null }, 'product.name'), null);
check('getField flat dotted key wins', Q.getField({ id: 'x', 'product.name': 'Flat', product: { name: 'Nested' } }, 'product.name'), 'Flat');
check('getField through a scalar', Q.getField({ id: 'x', product: 'p1' }, 'product.name'), null);

// compare
check('compare nulls equal', [Q.compare(null, undefined), Q.compare('', null), Q.compare(undefined, '')], [0, 0, 0]);
check('compare null first', [Q.compare(null, 0), Q.compare(0, null), Q.compare('', 'a')], [-1, 1, -1]);
check('compare numbers', [Q.compare(2, 10), Q.compare(10, 2), Q.compare(3, 3)], [-1, 1, 0]);
check('compare booleans', [Q.compare(false, true), Q.compare(true, false), Q.compare(true, true)], [-1, 1, 0]);
check('compare mixed types', [Q.compare(true, 0), Q.compare(5, 'a'), Q.compare('a', false)], [-1, -1, 1]);
check('compare numeric collation', Q.compare('Item 2', 'Item 10') < 0, true);
check('compare case-insensitive', Q.compare('apple', 'APPLE'), 0);
check('compare Cyrillic', Q.compare('арбуз', 'яблоко') < 0 && Q.compare('Ёлка', 'Жук') < 0, true);
check('compare ISO dates', [Q.compare('2026-10-08', '2026-10-08T00:00:00'), Q.compare('2026-10-09', '2026-10-08T23:59:59')], [-1, 1]);
check('compare custom collator', Q.compare('a', 'B', new Intl.Collator('en', { caseFirst: 'upper' })) < 0, true);

// eq / ne
check('eq string', ids(c('name', 'eq', 'Apple')), ['a']);
check('eq is case-sensitive', ids(c('name', 'eq', 'apple')), []);
check('eq number strict', ids(c('qty', 'eq', 10)), ['a']);
check('eq numeric string strict', ids(c('qty', 'eq', '10')), ['e']);
check('eq boolean', ids(c('active', 'eq', false)), ['b', 'e']);
check('eq null is isNull', ids(c('tag', 'eq', null)), ['b', 'c']);
check('ne value', ids(c('tag', 'ne', 'x')), ['b', 'c', 'd']);
check('ne null is isNotNull', ids(c('tag', 'ne', null)), ['a', 'd', 'e']);
check('ne number', ids(c('qty', 'ne', 10)), ['b', 'c', 'd', 'e']);

// lt / le / gt / ge
check('lt number', ids(c('qty', 'lt', 10)), ['b']);
check('le number', ids(c('qty', 'le', 10)), ['a', 'b']);
check('gt number', ids(c('qty', 'gt', 10)), ['c', 'e']); // '10' is a string: strings sort after numbers
check('ge number', ids(c('price', 'ge', 1.5)), ['a', 'e']);
check('gt null value matches nothing', ids(c('qty', 'gt', null)), []);
check('lt skips null fields', ids(c('price', 'lt', 100)), ['a', 'b', 'c', 'e']);
check('gt date', ids(c('date', 'gt', '2026-10-01')), ['a', 'e']);
check('le date-time', ids(c('at', 'le', '2026-10-08T23:59:59')), ['a', 'd']);
check('lt string collation', ids(c('name', 'lt', 'b')), ['a', 'e']);
check('ge string case-insensitive', ids(c('name', 'ge', 'CHERRY')), ['c']);

// in / notIn
check('in', ids(c('tag', 'in', ['x', 'y'])), ['a', 'd', 'e']);
check('in with null', ids(c('tag', 'in', ['y', null])), ['b', 'c', 'd']);
check('in strict', ids(c('qty', 'in', [10])), ['a']);
check('in empty list', ids(c('tag', 'in', [])), []);
check('notIn', ids(c('tag', 'notIn', ['x'])), ['b', 'c', 'd']);
check('notIn with null', ids(c('tag', 'notIn', ['x', null])), ['d']);

// text operators
check('contains case-insensitive', ids(c('name', 'contains', 'AP')), ['a', 'e']);
check('contains number stringified', ids(c('qty', 'contains', '5')), ['c']);
check('contains null field false', ids(c('name', 'contains', '')), ['a', 'b', 'c', 'e']);
check('notContains null field true', ids(c('name', 'notContains', 'an')), ['a', 'c', 'd', 'e']);
check('startsWith', ids(c('name', 'startsWith', 'ap')), ['a', 'e']);
check('endsWith', ids(c('name', 'endsWith', 'RRY')), ['c']);
check('startsWith null false', ids(c('name', 'startsWith', '')).includes('d'), false);
check('contains Cyrillic case', Q.matches({ id: '1', s: 'Привет Мир' }, c('s', 'contains', 'мир')), true);
check('endsWith null false', ids(c('tag', 'endsWith', 'x')), ['a', 'e']);

// between
check('between numbers', ids(c('qty', 'between', [0, 10])), ['a', 'b']);
check('between open from', ids(c('price', 'between', [null, 0.2])), ['b', 'c']);
check('between open to', ids(c('price', 'between', [1.5, null])), ['a', 'e']);
check('between dates', ids(c('date', 'between', ['2026-10-01', '2026-10-31'])), ['a', 'b']);
check('between date-time in a day', ids(c('at', 'between', ['2026-10-08', '2026-10-08T23:59:59'])), ['a']);
check('between null field false', ids(c('date', 'between', [null, null])), ['a', 'b', 'd', 'e']);
check('between code points', Q.matches({ id: '1', s: 'B' }, c('s', 'between', ['A', 'C'])), true);

// isNull / isNotNull
check('isNull', ids(c('tag', 'isNull')), ['b', 'c']);
check('isNotNull', ids(c('tag', 'isNotNull')), ['a', 'd', 'e']);
check('isNull missing field', ids(c('missing', 'isNull')), ['a', 'b', 'c', 'd', 'e']);
check('isNull false is not null', ids(c('active', 'isNull')), ['c']);

// and / or / not
check('and', ids({ and: [c('tag', 'eq', 'x'), c('active', 'eq', true)] }), ['a']);
check('or', ids({ or: [c('qty', 'eq', 25), c('name', 'isNull')] }), ['c', 'd']);
check('not', ids({ not: c('tag', 'eq', 'x') }), ['b', 'c', 'd']);
check('empty and is true', ids({ and: [] }).length, 5);
check('empty or is false', ids({ or: [] }), []);
check('not empty or', ids({ not: { or: [] } }).length, 5);
check(
  'nested',
  ids({ or: [{ and: [c('tag', 'eq', 'x'), { not: c('active', 'eq', true) }] }, { and: [c('qty', 'isNull'), { or: [c('tag', 'eq', 'y'), c('tag', 'eq', 'z')] }] }] }),
  ['d', 'e'],
);
check('undefined filter matches', Q.matches(rows[0], undefined), true);
check('unknown op matches nothing', Q.matches(rows[0], c('name', 'regex', 'A')), false);
check('dotted field in filter', Q.matches({ id: '1', 'customer.city': 'Kyiv' }, c('customer.city', 'eq', 'Kyiv')), true);
check('nested object in filter', Q.matches({ id: '1', customer: { city: 'Kyiv' } }, c('customer.city', 'contains', 'yi')), true);

// sortRows
const sr = [
  { id: '1', g: 'b', n: 2 },
  { id: '2', g: 'a', n: null },
  { id: '3', g: 'b', n: 1 },
  { id: '4', g: null, n: 5 },
  { id: '5', g: 'a', n: 3 },
  { id: '6', g: 'b', n: 2 },
];
const sids = (list) => list.map((r) => r.id);
check('sort asc nulls first', sids(Q.sortRows(sr, [{ field: 'n' }])), ['2', '3', '1', '6', '5', '4']);
check('sort desc nulls last', sids(Q.sortRows(sr, [{ field: 'n', desc: true }])), ['4', '5', '1', '6', '3', '2']);
check('sort multi-key stable', sids(Q.sortRows(sr, [{ field: 'g' }, { field: 'n', desc: true }])), ['4', '5', '2', '1', '6', '3']);
check('sort stable on ties', sids(Q.sortRows(sr, [{ field: 'g', desc: true }])), ['1', '3', '6', '2', '5', '4']);
check('sort returns new array', Q.sortRows(sr, undefined) !== sr && sids(Q.sortRows(sr, [])).join() === '1,2,3,4,5,6', true);
check('sort does not mutate', sids(sr), ['1', '2', '3', '4', '5', '6']);
check(
  'sort numeric collation',
  Q.sortRows([{ id: '1', s: 'Item 10' }, { id: '2', s: 'Item 2' }, { id: '3', s: 'item 1' }], [{ field: 's' }]).map((r) => r.s),
  ['item 1', 'Item 2', 'Item 10'],
);
check(
  'sort Cyrillic',
  Q.sortRows(['Яблоко', 'арбуз', 'Груша', 'вишня', 'ёж', 'Банан'].map((s, i) => ({ id: String(i), s })), [{ field: 's' }]).map((r) => r.s),
  ['арбуз', 'Банан', 'вишня', 'Груша', 'ёж', 'Яблоко'],
);
check(
  'sort Ukrainian',
  Q.sortRows(['їжак', 'гуска', 'ґанок', 'іній', 'ялина'].map((s, i) => ({ id: String(i), s })), [{ field: 's' }], new Intl.Collator('uk')).map((r) => r.s),
  ['гуска', 'ґанок', 'іній', 'їжак', 'ялина'],
);
check('sort mixed types', Q.sortRows([{ id: '1', v: 'x' }, { id: '2', v: 3 }, { id: '3', v: true }, { id: '4', v: null }], [{ field: 'v' }]).map((r) => r.id), ['4', '3', '2', '1']);
check('sort dates', sids(Q.sortRows(rows, [{ field: 'date', desc: true }])), ['e', 'a', 'b', 'd', 'c']);
check('sort by dotted path', Q.sortRows([{ id: '1', p: { n: 2 } }, { id: '2', p: { n: 1 } }], [{ field: 'p.n' }]).map((r) => r.id), ['2', '1']);

// runQuery
const many = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, n: i, odd: i % 2 === 1, _rev: `v${i}`, extra: 'z' }));
let r = Q.runQuery(many, { table: 't', where: c('odd', 'eq', true), orderBy: [{ field: 'n', desc: true }], limit: 5, count: true });
check('runQuery page', r.rows.map((x) => x.n), [23, 21, 19, 17, 15]);
check('runQuery total', r.total, 12);
check('runQuery cursor', r.cursor, '5');
r = Q.runQuery(many, { table: 't', where: c('odd', 'eq', true), orderBy: [{ field: 'n', desc: true }], limit: 5, cursor: r.cursor });
check('runQuery next page', r.rows.map((x) => x.n), [13, 11, 9, 7, 5]);
check('runQuery no total unless asked', r.total, undefined);
r = Q.runQuery(many, { table: 't', where: c('odd', 'eq', true), orderBy: [{ field: 'n', desc: true }], limit: 5, cursor: r.cursor });
check('runQuery last page', r.rows.map((x) => x.n), [3, 1]);
check('runQuery no cursor at end', r.cursor, undefined);
r = Q.runQuery(many, { table: 't', offset: 20, limit: 5 });
check('runQuery offset exact end', [r.rows.length, r.cursor], [5, undefined]);
r = Q.runQuery(many, { table: 't', offset: 3, count: true });
check('runQuery offset without limit', [r.rows.length, r.total, r.cursor], [22, 25, undefined]);
check('runQuery offset beyond', Q.runQuery(many, { table: 't', offset: 100, limit: 5 }).rows, []);
check('runQuery limit 0', Q.runQuery(many, { table: 't', limit: 0, count: true }), { rows: [], total: 25, cursor: '0' });
r = Q.runQuery(many, { table: 't', select: ['n'], limit: 1 });
check('runQuery select keeps id and _rev', r.rows[0], { id: 'r0', _rev: 'v0', n: 0 });
check('runQuery select missing field null', Q.runQuery([{ id: 'x' }], { table: 't', select: ['a.b'] }).rows, [{ id: 'x', 'a.b': null }]);
check('runQuery does not mutate', many[0], { id: 'r0', n: 0, odd: false, _rev: 'v0', extra: 'z' });
check('runQuery no options', Q.runQuery(many, { table: 't' }).rows.length, 25);

// aggregate
const sales = [
  { id: '1', region: 'North', product: 'A', amount: 0.1, qty: 1 },
  { id: '2', region: 'North', product: 'B', amount: 0.2, qty: 2 },
  { id: '3', region: 'South', product: 'A', amount: 10, qty: null },
  { id: '4', region: 'South', product: 'A', amount: 'n/a', qty: 4 },
  { id: '5', region: null, product: 'C', amount: 5, qty: 5 },
];
const measures = [
  { name: 'total', fn: 'sum', field: 'amount' },
  { name: 'rows', fn: 'count' },
  { name: 'withQty', fn: 'count', field: 'qty' },
  { name: 'products', fn: 'countDistinct', field: 'product' },
  { name: 'avgQty', fn: 'avg', field: 'qty' },
  { name: 'minProduct', fn: 'min', field: 'product' },
  { name: 'maxAmount', fn: 'max', field: 'amount' },
];
check('aggregate no groupBy', Q.aggregate(sales, { groupBy: [], measures }), [
  { total: 15.3, rows: 5, withQty: 4, products: 3, avgQty: 3, minProduct: 'A', maxAmount: 'n/a' },
]);
check('aggregate empty input', Q.aggregate([], { groupBy: [], measures }), [
  { total: 0, rows: 0, withQty: 0, products: 0, avgQty: null, minProduct: null, maxAmount: null },
]);
check('aggregate empty input with groupBy', Q.aggregate([], { groupBy: ['region'], measures }), []);
check(
  'aggregate groupBy region',
  Q.aggregate(sales, { groupBy: ['region'], measures: [{ name: 'total', fn: 'sum', field: 'amount' }, { name: 'n', fn: 'count' }] }),
  [
    { region: null, total: 5, n: 1 },
    { region: 'North', total: 0.3, n: 2 },
    { region: 'South', total: 10, n: 2 },
  ],
);
check(
  'aggregate two keys + where + orderBy measure',
  Q.aggregate(sales, {
    table: 'sales',
    where: c('region', 'isNotNull'),
    groupBy: ['region', 'product'],
    measures: [{ name: 'q', fn: 'sum', field: 'qty' }],
    orderBy: [{ field: 'q', desc: true }],
  }),
  [
    { region: 'South', product: 'A', q: 4 },
    { region: 'North', product: 'B', q: 2 },
    { region: 'North', product: 'A', q: 1 },
  ],
);
check(
  'aggregate avg noise cleaned',
  Q.aggregate([{ id: '1', v: 0.1 }, { id: '2', v: 0.2 }, { id: '3', v: 0.4 }], { groupBy: [], measures: [{ name: 'a', fn: 'avg', field: 'v' }, { name: 's', fn: 'sum', field: 'v' }] }),
  [{ a: 0.233333333333333, s: 0.7 }],
);
check('aggregate min/max dates', Q.aggregate(rows, { groupBy: [], measures: [{ name: 'lo', fn: 'min', field: 'date' }, { name: 'hi', fn: 'max', field: 'date' }] }), [{ lo: '2026-09-30', hi: '2026-11-15' }]);
check(
  'aggregate groupBy number vs string keys distinct',
  Q.aggregate([{ id: '1', k: 1 }, { id: '2', k: '1' }, { id: '3', k: 1 }], { groupBy: ['k'], measures: [{ name: 'n', fn: 'count' }] }),
  [{ k: 1, n: 2 }, { k: '1', n: 1 }],
);
check(
  'aggregate groupBy dotted field',
  Q.aggregate([{ id: '1', 'p.cat': 'x' }, { id: '2', 'p.cat': 'x' }], { groupBy: ['p.cat'], measures: [{ name: 'n', fn: 'count' }] }),
  [{ 'p.cat': 'x', n: 2 }],
);

// groupTree
const tree = Q.groupTree(sales, ['region', 'product'], [{ name: 'total', fn: 'sum', field: 'amount' }, { name: 'n', fn: 'count' }]);
check('groupTree top values', tree.map((g) => g.value), [null, 'North', 'South']);
check('groupTree top totals', tree.map((g) => g.totals), [{ total: 5, n: 1 }, { total: 0.3, n: 2 }, { total: 10, n: 2 }]);
check('groupTree children', tree[1].children.map((g) => [g.field, g.value, g.path, g.totals.total]), [
  ['product', 'A', ['North', 'A'], 0.1],
  ['product', 'B', ['North', 'B'], 0.2],
]);
check('groupTree leaf rows', tree[2].children[0].rows.map((x) => x.id), ['3', '4']);
check('groupTree leaf children empty', tree[2].children[0].children, []);
check('groupTree rows at top', tree[2].rows.map((x) => x.id), ['3', '4']);
check('groupTree field', tree[0].field, 'region');
check('groupTree no fields', Q.groupTree(sales, [], []), []);

// distinctValues
check('distinctValues', Q.distinctValues(rows, 'tag'), [null, 'x', 'y']);
check('distinctValues mixed', Q.distinctValues(rows, 'qty'), [null, 0, 10, 25, '10']);
check('distinctValues limit', Q.distinctValues(rows, 'name', 3), [null, 'Apple', 'apricot']);
check('distinctValues collation', Q.distinctValues([{ id: '1', s: 'Item 10' }, { id: '2', s: 'Item 2' }, { id: '3', s: 'Item 2' }], 's'), ['Item 2', 'Item 10']);

// quick filters: text
const P = (input, kind = 'text') => Q.parseQuickFilter('f', input, kind);
check('qf empty', P(''), null);
check('qf whitespace', P('   '), null);
check('qf text contains', P('abc'), c('f', 'contains', 'abc'));
check('qf text trimmed', P('  ab c  '), c('f', 'contains', 'ab c'));
check('qf text eq', P('=abc'), c('f', 'eq', 'abc'));
check('qf text startsWith', P('abc*'), c('f', 'startsWith', 'abc'));
check('qf text endsWith', P('*abc'), c('f', 'endsWith', 'abc'));
check('qf text *both*', P('*abc*'), c('f', 'contains', 'abc'));
check('qf text notContains', P('!abc'), c('f', 'notContains', 'abc'));
check('qf text ne', P('<>abc'), c('f', 'ne', 'abc'));
check('qf text != value', P('!=abc'), c('f', 'ne', 'abc'));
check('qf text = alone', P('='), c('f', 'isNull'));
check('qf text ""', P('""'), c('f', 'isNull'));
check('qf text * alone', P('*'), c('f', 'isNotNull'));
check('qf text != alone', P('!='), c('f', 'isNotNull'));
check('qf text filter works', ids(Q.parseQuickFilter('name', 'ap*', 'text')), ['a', 'e']);

// quick filters: number
const N = (input) => P(input, 'number');
check('qf num eq', N('100'), c('f', 'eq', 100));
check('qf num gt', N('>100'), c('f', 'gt', 100));
check('qf num ge', N('>=100'), c('f', 'ge', 100));
check('qf num lt', N('<100'), c('f', 'lt', 100));
check('qf num le', N('<= 100'), c('f', 'le', 100));
check('qf num ne <>', N('<>100'), c('f', 'ne', 100));
check('qf num ne !=', N('!=100'), c('f', 'ne', 100));
check('qf num = value', N('=7'), c('f', 'eq', 7));
check('qf num between', N('10..20'), c('f', 'between', [10, 20]));
check('qf num between open', [N('10..'), N('..20')], [c('f', 'between', [10, null]), c('f', 'between', [null, 20])]);
check('qf num decimal comma', N('1,5'), c('f', 'eq', 1.5));
check('qf num decimal point', N('-2.25'), c('f', 'eq', -2.25));
check('qf num thousands', N('1 000'), c('f', 'eq', 1000));
check('qf num thousands nbsp', N('>1 000,5'), c('f', 'gt', 1000.5));
check('qf num list', N('10; 20; 30'), c('f', 'in', [10, 20, 30]));
check('qf num = alone', N('='), c('f', 'isNull'));
check('qf num * alone', N('*'), c('f', 'isNotNull'));
check('qf num invalid', N('abc'), { error: 'Not a number' });
check('qf num invalid op', N('>'), { error: 'Not a number' });
check('qf num invalid range', N('1..x'), { error: 'Not a number' });
check('qf num invalid list', N('1; two'), { error: 'Not a number' });
check('qf num filter works', ids(Q.parseQuickFilter('qty', '0..10', 'number')), ['a', 'b']);

// quick filters: date
const D = (input) => P(input, 'date');
const day = (d) => c('f', 'between', [d, `${d}T23:59:59`]);
check('qf date ISO', D('2026-10-08'), day('2026-10-08'));
check('qf date dd.mm.yyyy', D('08.10.2026'), day('2026-10-08'));
check('qf date d.mm.yy', D('8.10.26'), day('2026-10-08'));
check('qf date = day', D('=8.10.2026'), day('2026-10-08'));
check('qf date month ISO', D('2026-10'), c('f', 'between', ['2026-10-01', '2026-10-31T23:59:59']));
check('qf date month dotted', D('02.2028'), c('f', 'between', ['2028-02-01', '2028-02-29T23:59:59']));
check('qf date year', D('2026'), c('f', 'between', ['2026-01-01', '2026-12-31T23:59:59']));
check('qf date gt', D('>08.10.2026'), c('f', 'gt', '2026-10-08T23:59:59'));
check('qf date ge', D('>=08.10.2026'), c('f', 'ge', '2026-10-08'));
check('qf date lt', D('<08.10.2026'), c('f', 'lt', '2026-10-08'));
check('qf date le', D('<=01.10.2026'), c('f', 'le', '2026-10-01T23:59:59'));
check('qf date le month', D('<=2026-10'), c('f', 'le', '2026-10-31T23:59:59'));
check('qf date ne', D('<>2026-10-08'), { not: day('2026-10-08') });
check('qf date range', D('01.10.2026..2026-10-08'), c('f', 'between', ['2026-10-01', '2026-10-08T23:59:59']));
check('qf date range months', D('2026-09..2026-10'), c('f', 'between', ['2026-09-01', '2026-10-31T23:59:59']));
check('qf date range open', D('..2026-10-08'), c('f', 'between', [null, '2026-10-08T23:59:59']));
check('qf date list', D('2026-10-01; 2026-10-08'), { or: [day('2026-10-01'), day('2026-10-08')] });
check('qf date = alone', D('='), c('f', 'isNull'));
check('qf date invalid', D('yesterday'), { error: 'Not a date' });
check('qf date invalid day', D('31.02.2026'), { error: 'Not a date' });
check('qf date invalid month', D('2026-13'), { error: 'Not a date' });
check('qf date invalid range', D('2026-10-01..soon'), { error: 'Not a date' });
check('qf date matches date and date-time', ids(Q.parseQuickFilter('at', '08.10.2026', 'date')), ['a']);
check('qf date on date field', ids(Q.parseQuickFilter('date', '2026-10', 'date')), ['a', 'b']);
check('qf date gt on date-time', ids(Q.parseQuickFilter('at', '>2026-10-08', 'date')), ['b', 'e']);
check('qf date le on date-time', ids(Q.parseQuickFilter('at', '<=30.09.2026', 'date')), ['d']);
check('qf date lt on date field', ids(Q.parseQuickFilter('date', '<2026-10-01', 'date')), ['d']);

// quick filters: boolean
const B = (input) => P(input, 'boolean');
const no = { or: [c('f', 'eq', false), c('f', 'isNull')] };
check('qf bool yes forms', ['yes', 'TRUE', '1', '+', 'да', 'Так', '✓'].map(B), Array(7).fill(c('f', 'eq', true)));
check('qf bool no forms', ['no', 'False', '0', '-', 'нет', 'ні'].map(B), Array(6).fill(no));
check('qf bool invalid', 'error' in B('maybe'), true);
check('qf bool no matches null', ids(Q.parseQuickFilter('active', 'no', 'boolean')), ['b', 'c', 'e']);

// quick filters: enum
check('qf enum list', P('new, done ,  ', 'enum'), c('f', 'in', ['new', 'done']));
check('qf enum single', P('new', 'enum'), c('f', 'in', ['new']));
check('qf enum = alone', P('=', 'enum'), c('f', 'isNull'));

// performance sanity
const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'Яблоко', 'груша', 'Item'];
const big = Array.from({ length: 100_000 }, (_, i) => ({
  id: `id${i}`,
  name: `${words[i % words.length]} ${(i * 7919) % 100_000}`,
  qty: (i * 31) % 1000,
  date: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
}));
const t0 = performance.now();
const res = Q.runQuery(big, { table: 't', where: c('name', 'contains', 'a'), orderBy: [{ field: 'name' }, { field: 'qty', desc: true }], limit: 100, count: true });
const ms = performance.now() - t0;
console.log(`query: contains + sort over 100 000 rows: ${ms.toFixed(0)} ms (${res.total} matched)`);
check('perf result size', res.rows.length, 100);
check('perf under 1500 ms', ms < 1500, true);
const t1 = performance.now();
Q.aggregate(big, { groupBy: ['date'], measures: [{ name: 's', fn: 'sum', field: 'qty' }, { name: 'n', fn: 'count' }] });
console.log(`query: aggregate over 100 000 rows: ${(performance.now() - t1).toFixed(0)} ms`);

done('query');
