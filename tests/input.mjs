/**
 * Entering data quickly: parts filled from a table (a stocktaking starts with
 * every product), the step that fills them again, records kept in an order
 * the person sets, sums typed into number fields, shortcuts — and the
 * designer's checks of all that.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/data', 'core/registers', 'core/actions', 'core/format', 'core/config/types', 'core/config/model', 'core/config/validate', '../plugins/builtin/local/store');
const { DataService, installPosting, installTriggers, runAction, evalArithmetic, normalizeHotkey, emptyConfig, validateConfig, defaultView, Store, memoryAdapter } = M;

const f = (name, type, extra = {}) => ({ key: `f_${name}`, name, type, ...extra });
const config = emptyConfig('Input');
config.tables = [
  {
    key: 't_wh',
    name: 'Warehouses',
    kind: 'catalog',
    title: 'Warehouses',
    fields: [f('name', 'string')],
  },
  {
    key: 't_prod',
    name: 'Products',
    kind: 'catalog',
    title: 'Products',
    orderable: true,
    fields: [f('name', 'string'), f('archived', 'boolean'), f('price', 'decimal')],
  },
  {
    key: 't_count',
    name: 'Counts',
    kind: 'document',
    title: 'Stocktakings',
    fields: [f('warehouse', 'ref', { ref: 'Warehouses' }), f('total', 'decimal', { computed: 'sum(lines.expected)' })],
    parts: [
      {
        key: 'p_l',
        name: 'lines',
        fields: [f('product', 'ref', { ref: 'Products' }), f('expected', 'decimal'), f('counted', 'decimal', { default: 'expected' }), f('note', 'string', { default: "'—'" })],
        fill: { from: 'Products', where: 'not archived', set: { product: 'id', expected: "price * iif(isEmpty(doc.warehouse), 1, 2)" } },
      },
    ],
  },
];
config.actions = [{ key: 'a_refill', name: 'Refill', title: 'Refill', table: 'Counts', steps: [{ type: 'fill', part: 'lines' }] }];
config.triggers = [{ key: 'tr_wh', table: 'Counts', event: 'onFieldChange', field: 'warehouse', steps: [{ type: 'fill', part: 'lines' }] }];
check('the configuration has no problems', validateConfig(config), []);

const store = new Store(memoryAdapter());
const data = new DataService(config, { user: () => 'tester', now: () => new Date(2026, 9, 8, 12, 0, 0) });
data.link('main', store, store.capabilities());
installPosting(data);
installTriggers(data);
const T = (name) => data.table(name);
const save = (name, row, previous = null) => data.save(T(name), { id: '', ...row }, previous);

// An ordered table: a new record comes last; a list shows them in that order.
const milk = await save('Products', { name: 'Milk', price: 30 });
const bread = await save('Products', { name: 'Bread', price: 20 });
await save('Products', { name: 'Old stock', price: 5, archived: true });
const tea = await save('Products', { name: 'Tea', price: 50, _order: 0 });
check('a new record comes last, unless placed', (await data.all('Products')).map((p) => [p.name, p._order]), [['Milk', 1], ['Bread', 2], ['Old stock', 3], ['Tea', 0]]);
check('its list is sorted by that order', defaultView(config, T('Products')).sort, [{ field: '_order' }]);
check('the order is a field of every record, not shown in lists', [T('Products').fields.some((x) => x.name === '_order'), defaultView(config, T('Products')).columns.some((c) => c.field === '_order')], [false, false]);

// A new stocktaking starts with a line for each product not archived, in their order.
const wh = await save('Warehouses', { name: 'Main' });
const count = await data.newRecord(T('Counts'));
check('lines filled from the table, in its order, by the condition', count.lines.map((l) => [l.product === tea.id ? 'Tea' : l.product === milk.id ? 'Milk' : l.product === bread.id ? 'Bread' : '?', l.expected]), [['Tea', 50], ['Milk', 30], ['Bread', 20]]);
check('the lines’ own defaults for the rest', count.lines.map((l) => [l.counted, l.note]), [[50, '—'], [30, '—'], [20, '—']]);

// A trigger on a field fills them again, in place: doc.x is the record being filled.
count.warehouse = wh.id;
await M.fieldChanged(data, T('Counts'), count, 'warehouse');
check('filled again when the warehouse is chosen', count.lines.map((l) => l.expected), [100, 60, 40]);
const saved = await save('Counts', { ...count, lines: count.lines.slice(0, 1) });
check('saved with one line', saved.lines.length, 1);

// The step outside a form: the record is saved with its new lines.
await save('Products', { ...bread, archived: true }, bread);
await runAction(data, config.actions[0], { table: T('Counts'), current: saved, selected: [saved] }, null);
const refilled = await data.get('Counts', saved.id);
check('the fill step saves the record with the lines again', refilled.lines.map((l) => l.expected), [100, 60]);

// Sums typed into a number field.
check('arithmetic: precedence', evalArithmetic('1200+350-50*2'), 1450);
check('arithmetic: brackets and decimal commas', evalArithmetic('(12,5 + 7,5) / 2'), 10);
check('arithmetic: grouped thousands', evalArithmetic("1 200,50+0,5"), 1201);
check('arithmetic: no float noise', evalArithmetic('0.1+0.2'), 0.3);
check('arithmetic: a plain number is not a sum', [evalArithmetic('100'), evalArithmetic('-5')], [null, null]);
check('arithmetic: what cannot be worked out', [evalArithmetic('1/0'), evalArithmetic('2+'), evalArithmetic('2+abc')], [null, null, null]);

// Shortcuts.
check('shortcuts in one spelling', ['r', 'shift+n', 'Cmd+Alt+R', 'alt+ctrl+shift+1', 'f2', 'Ctrl+Enter', 'Hyper+R', ''].map(normalizeHotkey), ['R', 'Shift+N', 'Ctrl+Alt+R', 'Ctrl+Alt+Shift+1', 'F2', null, null, null]);

// The designer's checks.
const wrong = structuredClone(config);
wrong.tables[2].parts[0].fill.from = 'Nope';
wrong.actions.push({ key: 'a2', name: 'Global', title: 'G', hotkey: 'R', steps: [] }, { key: 'a3', name: 'Mine', title: 'M', table: 'Counts', hotkey: 'r', steps: [] }, { key: 'a4', name: 'Bad', title: 'B', hotkey: 'Ctrl+Space', steps: [] });
wrong.menu = [{ key: 'm1', title: 'Counts', target: { kind: 'table', name: 'Counts' }, hotkey: 'Shift+C' }, { key: 'm2', title: 'Products', target: { kind: 'table', name: 'Products' }, hotkey: 'shift+c' }];
wrong.forms = [{ key: 'fo', name: 'Quick', table: 'Counts', focus: 'nope', layout: { type: 'group', key: 'r', children: [] } }];
wrong.views = [{ key: 'v', name: 'V', table: 'Counts', title: 'V', columns: [], details: [{ key: 'd', kind: 'view', table: 'Products', where: 'nope2 > 1' }] }];
wrong.actions[0].steps = [{ type: 'fill', part: 'nope3' }];
const problems = validateConfig(wrong).map((p) => p.message);
check('filled from a table that does not exist', problems.some((m) => /filled from “Nope”/.test(m)), true);
check('a shortcut taken twice', problems.filter((m) => /is taken by/.test(m)).length, 2);
check('not a shortcut', problems.some((m) => /“Ctrl\+Space” is not a shortcut/.test(m)), true);
check('the cursor in a field that is not there', problems.some((m) => /cursor in “nope”/.test(m)), true);
check('a detail tab’s condition is about its table', problems.some((m) => /“nope2” is not found/.test(m)), true);
check('a fill step of a part that cannot be filled', problems.some((m) => /“nope3”/.test(m)), true);

done('input');
