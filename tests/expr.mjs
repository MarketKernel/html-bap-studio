/**
 * The expression language: syntax, operators, null rules, every built-in
 * function, the fixed decimal vectors (Task.md 7 — do not change them), paths,
 * checking and error positions.
 */
import { checker, load } from '../tools/load.mjs';

const E = await load('core/expr/index');
const { check, done } = checker();

const now = () => new Date(2026, 9, 8, 14, 5, 9);
const ev = (src, row = {}, extra = {}) => E.evalSource(src, E.rowEnv(row, { now, ...extra }));
/** The error an expression throws, as [message, pos, end], or 'no error'. */
const err = (src, row = {}, extra = {}) => {
  try {
    ev(src, row, extra);
    return 'no error';
  } catch (e) {
    if (!(e instanceof E.ExprError)) return `not an ExprError: ${e}`;
    return [e.message, e.pos, e.end];
  }
};

// ---------------------------------------------------------------- literals
check('integer', ev('12'), 12);
check('decimal', ev('12.5'), 12.5);
check('negative', ev('-3'), -3);
check('string', ev("'abc'"), 'abc');
check('string with doubled quote', ev("'it''s'"), "it's");
check('double-quoted string', ev('"say ""hi"""'), 'say "hi"');
check('empty string', ev("''"), '');
check('true', ev('true'), true);
check('false', ev('FALSE'), false);
check('null', ev('null'), null);
check('date literal', ev('#2026-10-08#'), '2026-10-08');
check('date-time literal', ev('#2026-10-08T10:30:00#'), '2026-10-08T10:30:00');
check('date-time literal without seconds', ev('#2026-10-08T10:30#'), '2026-10-08T10:30:00');
check('invalid date literal', err('#2026-02-30#'), ['Invalid date “2026-02-30”', 0, 12]);
check('unicode name', ev('ціна * 2', { ціна: 5 }), 10);

// ---------------------------------------------------------------- precedence
check('* before +', ev('1 + 2 * 3'), 7);
check('brackets', ev('(1 + 2) * 3'), 9);
check('left associative -', ev('10 - 3 - 2'), 5);
check('left associative /', ev('24 / 4 / 2'), 3);
check('unary minus binds tight', ev('-2 * 3'), -6);
check('unary minus of a group', ev('-(2 + 3)'), -5);
check('double minus', ev('2 - -1'), 3);
check('& below +', ev("'n' & 1 + 2"), 'n3');
check('comparison below &', ev("'a' & 'b' = 'ab'"), true);
check('and before or', ev('true or false and false'), true);
check('not below comparison', ev('not 1 = 2'), true);
check('not binds before and', ev('not false and false'), false);
check('keywords any case', ev('true AND not FALSE Or false'), true);
check('between with and after', ev('5 between 1 and 10 and true'), true);
check('% with *', ev('7 % 4 * 2'), 6);

// ---------------------------------------------------------------- arithmetic
check('0.1 + 0.2', ev('0.1 + 0.2'), 0.3);
check('1.1 * 3', ev('1.1 * 3'), 3.3);
check('0.3 - 0.1', ev('0.3 - 0.1'), 0.2);
check('division', ev('7 / 2'), 3.5);
check('1 / 3 cleaned', ev('1 / 3'), 0.333333333333333);
check('division by zero', ev('5 / 0'), null);
check('modulo', ev('7 % 3'), 1);
check('modulo by zero', ev('7 % 0'), null);
check('null + 1', ev('null + 1'), null);
check('null * 2', ev('x * 2', { x: null }), null);
check('missing field is null', ev('nope + 1'), null);
check('string + number concatenates', ev("'a' + 1"), 'a1');
check('numeric string * number', ev("'4' * 2"), 8);
check('& with null', ev("'a' & null & 'b'"), 'ab');
check('& with number', ev("'#' & 5"), '#5');

// ---------------------------------------------------------------- dates as values
check('date + 1', ev("'2026-10-08' + 1"), '2026-10-09');
check('1 + date', ev("1 + #2026-12-31#"), '2027-01-01');
check('date - number', ev("#2026-03-01# - 1"), '2026-02-28');
check('date - date', ev("#2026-10-08# - #2026-01-01#"), 280);
check('date - date negative', ev("#2025-12-31# - #2026-01-01#"), -1);
check('date-time + 0.5 day', ev("#2026-10-08T18:00:00# + 0.5"), '2026-10-09T06:00:00');
check('leap day', ev("#2024-02-28# + 1"), '2024-02-29');
check('date across DST', ev("#2026-03-28# + 2"), '2026-03-30');

// ---------------------------------------------------------------- comparison
check('= numbers', ev('2 = 2'), true);
check('<> numbers', ev('2 <> 3'), true);
check('!= alias', ev('2 != 2'), false);
check('< numbers', ev('2 < 10'), true);
check('<= equal', ev('3 <= 3'), true);
check('> strings by code points', ev("'b' > 'a'"), true);
check('strings case-sensitive order', ev("'Z' < 'a'"), true);
check('>= dates', ev("#2026-10-08# >= #2026-09-30#"), true);
check('= strings', ev("'x' = 'x'"), true);
check('booleans', ev('true = true and false < true'), true);
check('number = numeric string', ev("5 = '5'"), true);
check('null = null', ev('null = null'), true);
check('x = null', ev('1 = null'), false);
check('x <> null', ev('1 <> null'), true);
check('null <> null', ev('null <> null'), false);
check('null < 1', ev('null < 1'), false);
check('null > 1', ev('null > 1'), false);
check('null >= null', ev('null >= null'), false);
check('mixed kinds do not order', ev("'a' < 1"), false);
check('in', ev('2 in (1, 2, 3)'), true);
check('in miss', ev("'d' in ('a', 'b')"), false);
check('not in', ev('4 not in (1, 2, 3)'), true);
check('not in hit', ev('2 NOT IN (1, 2)'), false);
check('in with null', ev('x in (null, 1)', { x: null }), true);
check('in array value', ev('x in ($selected)', { x: 'b' }, { vars: { $selected: ['a', 'b'] } }), true);
check('between', ev('5 between 1 and 5'), true);
check('between miss', ev('6 between 1 and 5'), false);
check('not between', ev('6 not between 1 and 5'), true);
check('between dates', ev("#2026-10-08# between #2026-10-01# and #2026-10-31#"), true);
check('between null', ev('null between 1 and 5'), false);

// ---------------------------------------------------------------- logic
check('and false', ev('true and false'), false);
check('or true', ev('false or 1'), true);
check('and returns boolean', ev("'a' and 2"), true);
check('or of falsy', ev("0 or '' or null"), false);
check('not null', ev('not null'), true);
check('not empty array', ev('not lines', { lines: [] }), true);
check('and short-circuits', ev('false and boom()'), false);
check('or short-circuits', ev('true or boom()'), true);

// ---------------------------------------------------------------- functions: logic
check('iif true', ev("iif(1 > 0, 'yes', 'no')"), 'yes');
check('iif false', ev("iif(null, 'yes', 'no')"), 'no');
check('iif is lazy', ev('iif(true, 1, unknownFn())'), 1);
check('iif is lazy (else)', ev('iif(false, unknownFn(), 2)'), 2);
check('IIF any case', ev('IIf(true, 1, 2)'), 1);
check('coalesce', ev("coalesce(null, x, 'z')", { x: 'y' }), 'y');
check('coalesce all null', ev('coalesce(null, null)'), null);
check('coalesce is lazy', ev('coalesce(1, unknownFn())'), 1);
check('isEmpty null', ev('isEmpty(null)'), true);
check('isEmpty empty string', ev("isEmpty('')"), true);
check('isEmpty empty array', ev('isEmpty(lines)', { lines: [] }), true);
check('isEmpty zero', ev('isEmpty(0)'), false);

// ---------------------------------------------------------------- functions: numbers (fixed vectors)
check('round(2.675, 2)', ev('round(2.675, 2)'), 2.68);
check('round(1.005, 2)', ev('round(1.005, 2)'), 1.01);
check('round(-2.5)', ev('round(-2.5)'), -3);
check('round(2.5)', ev('round(2.5)'), 3);
check('round(-1.005, 2)', ev('round(-1.005, 2)'), -1.01);
check('round(1234.5678, -2)', ev('round(1234.5678, -2)'), 1200);
check('round(-0.001, 2)', ev('round(-0.001, 2)'), 0);
check('round(null)', ev('round(null)'), null);
check('round of a tiny number', ev('round(0.0000001, 2)'), 0);
check('floor', ev('floor(-2.5)'), -3);
check('ceil', ev('ceil(2.1)'), 3);
check('floor with digits', ev('floor(2.678, 2)'), 2.67);
check('abs', ev('abs(-4.2)'), 4.2);
check('min args', ev('min(3, 1, 2)'), 1);
check('max args', ev('max(3, 1, 2)'), 3);
check('min skips null', ev('min(null, 5, 4)'), 4);
check('min array', ev('min(lines.amount)', { lines: [{ amount: 3 }, { amount: null }, { amount: 2 }] }), 2);
check('max array', ev('max(lines.amount)', { lines: [{ amount: 3 }, { amount: 7 }] }), 7);
check('max dates', ev("max(#2026-01-01#, #2025-12-31#)"), '2026-01-01');
check('max empty array', ev('max(lines)', { lines: [] }), null);
check('number comma', ev("number('1,5')"), 1.5);
check('number spaces', ev("number(' 1 234.5 ')"), 1234.5);
check('number junk', ev("number('abc')"), null);
check('number of number', ev('number(7)'), 7);

// ---------------------------------------------------------------- functions: strings
check('len', ev("len('héllo')"), 5);
check('len null', ev('len(null)'), 0);
check('upper', ev("upper('abc')"), 'ABC');
check('lower', ev("lower('ÀB')"), 'àb');
check('upper null', ev('upper(null)'), null);
check('trim', ev("trim('  a b  ')"), 'a b');
check('left', ev("left('abcdef', 2)"), 'ab');
check('left too long', ev("left('ab', 5)"), 'ab');
check('right', ev("right('abcdef', 2)"), 'ef');
check('right zero', ev("right('abc', 0)"), '');
check('contains ignores case', ev("contains('Hello World', 'WORLD')"), true);
check('contains miss', ev("contains('abc', 'x')"), false);
check('startsWith', ev("startsWith('Invoice 12', 'inv')"), true);
check('startsWith miss', ev("startsWith('Invoice', 'voice')"), false);
check('replace all', ev("replace('a-b-c', '-', '+')"), 'a+b+c');
check('concat', ev("concat('a', 1, null, true)"), 'a1true');
check('text', ev('text(12.5)'), '12.5');
check('text null', ev('text(null)'), '');
check('format', ev('format(2.675, 2)'), '2.68');
check('format pads', ev('format(3, 2)'), '3.00');
check('format no grouping', ev('format(1234567.891, 1)'), '1234567.9');
check('format negative', ev('format(-1.5)'), '-2');
check('padLeft', ev('padLeft(42, 5)'), '00042');
check('padLeft char', ev("padLeft('7', 3, ' ')"), '  7');

// ---------------------------------------------------------------- functions: dates
check('today', ev('today()'), '2026-10-08');
check('now', ev('now()'), '2026-10-08T14:05:09');
check('today default clock', /^\d{4}-\d{2}-\d{2}$/.test(E.evalSource('today()', E.rowEnv({}))), true);
check('year', ev("year(#2026-10-08#)"), 2026);
check('month', ev("month(#2026-10-08#)"), 10);
check('day', ev("day('2026-10-08T23:59:00')"), 8);
check('year null', ev('year(null)'), null);
check('weekday Thursday', ev("weekday(#2026-10-08#)"), 4);
check('weekday Sunday', ev("weekday(#2026-10-11#)"), 7);
check('weekday Monday', ev("weekday(#2026-10-12#)"), 1);
check('addDays year boundary', ev("addDays(#2026-12-31#, 1)"), '2027-01-01');
check('addDays negative', ev("addDays(#2027-01-01#, -1)"), '2026-12-31');
check('addDays date-time', ev("addDays('2026-10-08T10:30:00', 2)"), '2026-10-10T10:30:00');
check('addMonths leap clamp', ev("addMonths('2024-01-31', 1)"), '2024-02-29');
check('addMonths clamp', ev("addMonths('2025-01-31', 1)"), '2025-02-28');
check('addMonths year boundary', ev("addMonths(#2026-11-15#, 3)"), '2027-02-15');
check('addMonths backwards', ev("addMonths(#2026-01-15#, -1)"), '2025-12-15');
check('addMonths date-time', ev("addMonths('2026-01-31T08:00:00', 1)"), '2026-02-28T08:00:00');
check('addYears Feb 29', ev("addYears(#2024-02-29#, 1)"), '2025-02-28');
check('dateDiff age', ev("dateDiff('year', '2007-09-22', '2019-09-21')"), 11);
check('dateDiff age on birthday', ev("dateDiff('year', '2007-09-22', '2019-09-22')"), 12);
check('dateDiff day', ev("dateDiff('day', #2026-01-01#, #2026-10-08#)"), 280);
check('dateDiff month', ev("dateDiff('month', #2026-01-31#, #2026-03-30#)"), 1);
check('dateDiff month negative', ev("dateDiff('month', #2026-03-15#, #2026-01-20#)"), -1);
check('dateDiff null', ev("dateDiff('day', null, #2026-01-01#)"), null);
check('dateDiff bad unit', err("dateDiff('week', #2026-01-01#, #2026-01-08#)"), ['Unknown unit “week”: use “day”, “month” or “year”', 9, 15]);
check('startOfMonth', ev("startOfMonth('2026-10-08T10:00:00')"), '2026-10-01');
check('endOfMonth', ev("endOfMonth(#2024-02-10#)"), '2024-02-29');
check('endOfMonth December', ev("endOfMonth(#2026-12-01#)"), '2026-12-31');
check('startOfYear', ev("startOfYear(#2026-10-08#)"), '2026-01-01');
check('date()', ev('date(2026, 10, 8)'), '2026-10-08');
check('date() overflow', ev('date(2026, 13, 1)'), '2027-01-01');
check('date() null', ev('date(2026, null, 1)'), null);

// ---------------------------------------------------------------- functions: collections
const order = { lines: [{ qty: 2, price: 0.1, amount: 0.1 }, { qty: 1, price: 0.2, amount: 0.2 }, { qty: 3, price: 0.3, amount: 0.3 }] };
check('sum fixed vector', ev('sum(lines.amount)', order), 0.6);
check('sum literal array via var', ev('sum($a)', {}, { vars: { a: [0.1, 0.2, 0.3] } }), 0.6);
check('sum skips null', ev('sum(lines.amount)', { lines: [{ amount: 1 }, { amount: null }, {}] }), 1);
check('sum null', ev('sum(null)'), 0);
check('count rows', ev('count(lines)', order), 3);
check('count null', ev('count(missing)'), 0);
check('avg', ev('avg(lines.qty)', order), 2);
check('avg empty', ev('avg(lines.qty)', { lines: [] }), null);
check('aggregate in arithmetic', ev('sum(lines.qty) * 10', order), 60);

// ---------------------------------------------------------------- paths and rowEnv
const row = { qty: 3, product: { price: 2.5, unit: { name: 'pcs' } }, lines: [{ amount: 1, tags: ['a', 'b'] }, { amount: 2, tags: ['c'] }] };
check('field', ev('qty', row), 3);
check('nested path', ev('product.price * qty', row), 7.5);
check('deep path', ev('product.unit.name', row), 'pcs');
check('path through null', ev('missing.price'), null);
check('path through array', ev('lines.amount', row), [1, 2]);
check('path through nested arrays flattens', ev('lines.tags', row), ['a', 'b', 'c']);
check('$this defaults to the row', ev('$this.qty', row), 3);
check('$params from vars', ev('$params.from', {}, { vars: { params: { from: '2026-01-01' } } }), '2026-01-01');
check('$today from vars', ev('$today', {}, { vars: { $today: '2026-10-08' } }), '2026-10-08');
check('unknown $ var', ev('$nope'), null);
check('member of a call result', ev("coalesce(null, product).price", row), 2.5);
check('custom resolver first', ev('qty', row, { resolve: (p) => (p[0] === 'qty' ? 99 : undefined) }), 99);
check('keyword after dot', ev('doc.in', { doc: { in: 5 } }), 5);

// ---------------------------------------------------------------- host functions
const host = {
  call(name, args) {
    if (name.toLowerCase() === 'lookup') return `${args[0]}#${args[1]}.${args[2]}`;
    if (name === 'currentUser') return 'ann';
    return undefined;
  },
};
check('env.call delegation', ev("lookup('Product', 7, 'name')", {}, host), 'Product#7.name');
check('env.call name as written', ev('LOOKUP(1, 2, 3)', {}, host), '1#2.3');
check('env.call with no args', ev('currentUser()', {}, host), 'ann');
check('env.call returns undefined', err('balance(1)', {}, host), ['Unknown function “balance”', 0, 10]);
let seenNodes = null;
ev('balance(qty > 1)', {}, { call: (_n, _a, _e, nodes) => ((seenNodes = nodes.map((x) => x.type)), 0) });
check('env.call receives argument nodes', seenNodes, ['binary']);
check('built-ins are not delegated', ev('round(1.4)', {}, { call: () => 'host' }), 1);

// ---------------------------------------------------------------- errors
check('unknown function', err('1 + foo(2)'), ['Unknown function “foo”', 4, 10]);
check('syntax error position', err('1 + * 2'), ['Unexpected “*”', 4, 5]);
check('ExprError from parseExpr', (() => {
  try {
    E.parseExpr('1 + * 2');
    return 'no error';
  } catch (e) {
    return [e instanceof E.ExprError, e instanceof Error, e.pos];
  }
})(), [true, true, 4]);
check('unexpected end', err('1 +'), ['The expression ends unexpectedly', 3, 3]);
check('unclosed bracket', err('(1 + 2'), ['“)” is expected at the end', 6, 6]);
check('unclosed string', err("'abc"), ['The text is not closed with a quote', 0, 4]);
check('unclosed date', err('#2026'), ['The date is not closed with “#”', 0, 5]);
check('bad character', err('1 ? 2'), ['Unexpected character “?”', 2, 3]);
check('trailing tokens', err('1 2'), ['Unexpected “2”', 2, 3]);
check('empty', err('  '), ['The expression is empty', 0, 0]);
check('between without and', err('1 between 0 or 2'), ['“and” is expected after the lower bound of “between”', 12, 14]);
check('wrong arg count', err('round()'), ['Function “round” takes from 1 to 2 arguments', 0, 7]);
check('wrong arg count exact', err('iif(true, 1)'), ['Function “iif” takes 3 arguments', 0, 12]);
check('wrong arg count one', err('len(1, 2)'), ['Function “len” takes 1 argument', 0, 9]);
check('wrong arg count at least', err('coalesce()'), ['Function “coalesce” takes at least 1 argument', 0, 10]);

// ---------------------------------------------------------------- AST, collectPaths, cache
check('AST is plain JSON', E.parseExpr('a + 1'), {
  type: 'binary', op: '+',
  left: { type: 'path', path: ['a'], pos: 0, end: 1 },
  right: { type: 'literal', value: 1, pos: 4, end: 5 },
  pos: 0, end: 5,
});
check('collectPaths', E.collectPaths(E.parseExpr("qty * product.price + sum(lines.amount) + iif($this.id = qty, 1, lookup('T', lines.amount))")), [
  ['qty'], ['product', 'price'], ['lines', 'amount'], ['$this', 'id'],
]);
check('collectPaths no functions', E.collectPaths(E.parseExpr('today()')), []);
check('evalSource cache gives the same answer', [ev('qty + 1', { qty: 1 }), ev('qty + 1', { qty: 2 })], [2, 3]);
for (let i = 0; i < 600; i += 1) E.evalSource(`${i} + 1`, E.rowEnv({}));
check('cache survives overflow', ev('599 + 1'), 600);

// ---------------------------------------------------------------- checkExpr
const fields = ['qty', 'price', 'product', 'lines'];
check('check ok', E.checkExpr('qty * price + sum(lines.amount) + $params.x', fields), {});
check('check suggestion', E.checkExpr('qty * prcie', fields), { error: { message: 'Field “prcie” is not found. Did you mean “price”?', pos: 6, end: 11 } });
check('check no suggestion', E.checkExpr('qty * zzzzzz', fields), { error: { message: 'Field “zzzzzz” is not found', pos: 6, end: 12 } });
check('check path first segment', E.checkExpr('prodct.price', fields), { error: { message: 'Field “prodct” is not found. Did you mean “product”?', pos: 0, end: 6 } });
check('check unknown function', E.checkExpr('rund(qty)', fields), { error: { message: 'Function “rund” is not found. Did you mean “round”?', pos: 0, end: 4 } });
check('check extra function', E.checkExpr("Lookup('T', qty, 'x')", fields, ['lookup']), {});
check('check function case-insensitive', E.checkExpr('ROUND(qty)', fields), {});
check('check syntax error', E.checkExpr('qty +', fields), { error: { message: 'The expression ends unexpectedly', pos: 5, end: 5 } });
check('check arg count', E.checkExpr('left(qty)', fields), { error: { message: 'Function “left” takes 2 arguments', pos: 0, end: 9 } });

// ---------------------------------------------------------------- FUNCTIONS
check('FUNCTIONS lists built-ins', ['iif', 'coalesce', 'isEmpty', 'round', 'startsWith', 'padLeft', 'dateDiff', 'startOfMonth', 'sum', 'count', 'avg'].every((f) => E.FUNCTIONS.includes(f)), true);
check('FUNCTIONS has no host functions', E.FUNCTIONS.includes('lookup'), false);

done('expr');
