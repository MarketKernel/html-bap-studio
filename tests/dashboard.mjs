/**
 * The words of a dashboard: plain text with expressions and conditions, values
 * shown as their kind says, expressions that belong to no record evaluated
 * with what they reach loaded, and an action that reads its widget's value.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/template', 'core/format', 'core/data', 'core/reports', 'core/actions', 'core/config/types', 'core/config/validate', '../plugins/builtin/local/store');
const { parseText, renderText, textExpressions, formatAs, DataService, evaluator, runAction, emptyConfig, validateConfig, Store, memoryAdapter, truthy } = M;

const nodes = parseText("Hello, {{name}}! {{#if debt > 0}}You owe {{debt | money}}.{{else}}No debts.{{/if}} Until {{until | date}}. {{a || b}}");
check('the expressions a text names', textExpressions(nodes), ['name', 'debt > 0', 'debt', 'until', 'a || b']);
const values = { name: 'Olena', 'debt > 0': true, debt: 1234.5, until: '2027-03-01', 'a || b': 'x' };
const text = renderText(nodes, (e) => values[e], formatAs, truthy);
check('rendered as text, conditions taken', text.replace(/ | /g, ' ').replace(/[,.]/g, (c) => c), `Hello, Olena! You owe ${formatAs(1234.5, 'money')}. Until ${formatAs('2027-03-01', 'date')}. x`);
check('the other branch', renderText(parseText('{{#if x}}yes{{else}}no{{/if}}'), () => false, formatAs, truthy), 'no');
check('nothing is a dash', [formatAs(null, 'money'), formatAs('', 'date')], ['—', '—']);
check('a share ends with %', formatAs(12.345, 'percent').endsWith('%'), true);

const f = (name, type, extra = {}) => ({ key: `f_${name}`, name, type, ...extra });
const config = emptyConfig('Dash');
config.constants = [f('target', 'decimal')];
config.tables = [{ key: 't', name: 'Notes', kind: 'catalog', title: 'Notes', fields: [f('text', 'string'), f('amount', 'decimal')] }];
config.actions = [{ key: 'a', name: 'Note', title: 'Note it', enabled: '$widget.value > 0', steps: [{ type: 'create', table: 'Notes', values: { text: "'from the widget'", amount: '$widget.value * 2' } }] }];
config.dashboards = [{ key: 'd', name: 'Home', title: 'Home', widgets: [
  { key: 'w1', type: 'kpi', x: 0, y: 0, w: 3, h: 1, value: "sumOf('Notes', 'amount') - $const.target", text: 'of {{$const.target | money}}', actions: ['Note'] },
  { key: 'w2', type: 'text', x: 0, y: 1, w: 3, h: 1, text: '{{countOf(\'Nope\')}}' },
  { key: 'w3', type: 'chart', x: 0, y: 2, w: 3, h: 1, report: 'Missing', actions: ['Gone'] },
] }];
const problems = validateConfig(config).map((p) => p.message);
check('a widget’s expression is checked against the tables it names', problems.some((m) => /“Nope” does not exist/.test(m)), true);
check('a widget’s report and actions must exist', [problems.some((m) => /report “Missing”/.test(m)), problems.some((m) => /action “Gone”/.test(m))], [true, true]);

const store = new Store(memoryAdapter());
const data = new DataService(config, { user: () => 'tester', now: () => new Date(2026, 9, 8, 12) });
data.link('main', store, store.capabilities());
await data.save(data.table('_constants'), { id: 'constants', target: 100 }, null);
await data.save(data.table('Notes'), { id: '', text: 'a', amount: 150 }, null);
const value = await evaluator(data, ["sumOf('Notes', 'amount') - $const.target", '$const.target * 2', 'nope(']);
check('expressions of no record: other tables and the constants', [value("sumOf('Notes', 'amount') - $const.target"), value('$const.target * 2')], [50, 200]);
check('…one that fails gives nothing', value('nope('), null);
await runAction(data, config.actions[0], { vars: { widget: { value: 50 } } }, null);
check('an action reads its widget’s value', (await data.all('Notes')).map((n) => n.amount), [150, 100]);

done('dashboard');
