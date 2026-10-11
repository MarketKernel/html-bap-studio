/**
 * DataService end to end in Node, on the "Warehouse and sales" template over
 * the memory store: defaults, computed fields, numbering, checks, posting and
 * balances, the refusal to sell what is not there, triggers, actions,
 * reports, schema changes. The seeding of the demo runs here too, so a broken
 * template fails a test rather than a user's first minute.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/data', 'core/registers', 'core/actions', 'core/reports', 'core/config/validate', 'core/config/diff', '../plugins/builtin/local/store', 'app/templates');
const { DataService, ValidationError, installPosting, installTriggers, runAction, runReport, validateConfig, schemaDiff, Store, memoryAdapter, TEMPLATES } = M;

const now = new Date(2026, 9, 8, 12, 0, 0);
const tpl = TEMPLATES.find((x) => x.id === 'warehouse');
const config = tpl.config();
check('template config has no problems', validateConfig(config), []);

const store = new Store(memoryAdapter());
const data = new DataService(config, { user: () => 'tester', now: () => now });
data.link('main', store, store.capabilities());
installPosting(data);
installTriggers(data);

const T = (name) => data.table(name);
const wh = await data.save(T('Warehouses'), { id: '', name: 'Main' }, null);
const sup = await data.save(T('Counterparties'), { id: '', name: 'Supplier', kind: 'supplier' }, null);
const cust = await data.save(T('Counterparties'), { id: '', name: 'Customer', kind: 'customer', discount: 10 }, null);
const milk = await data.save(T('Products'), { id: '', name: 'Milk', sku: 'M1', unit: 'l', purchasePrice: 20, price: 30, isFolder: false }, null);
check('audit fields', [milk._createdBy, milk._createdAt], ['tester', '2026-10-08T12:00:00']);
check('computed margin', milk.margin, 50);
check('stock is zero before any receipt', milk.stock, 0);

// Defaults: a new sale takes the customer's discount; a line takes the product's price.
const sale0 = await data.newRecord(T('Sales'), { customer: cust.id });
check('default status', sale0.status, 'new');
check('default discount from the customer', sale0.discount, 10);
check('default date is now', sale0.date, '2026-10-08T12:00:00');
const line = await data.newLine(T('Sales'), 'lines', sale0, { product: milk.id });
check('line price from product', [line.price, line.qty], [30, 1]);

// Unique SKU.
try {
  await data.save(T('Products'), { id: '', name: 'Other', sku: 'M1', isFolder: false }, null);
  check('unique sku refused', 'saved', 'refused');
} catch (error) {
  check('unique sku refused', error instanceof ValidationError, true);
}
// Table check: price below purchase price.
try {
  await data.save(T('Products'), { id: '', name: 'Cheap', purchasePrice: 10, price: 5, isFolder: false }, null);
  check('table validation', 'saved', 'refused');
} catch (error) {
  check('table validation', error.problems?.[0]?.message, 'The price is below the purchase price');
}

// A receipt of 10, posted.
const rc = await data.save(T('Receipts'), { id: '', date: '2026-10-01T09:00:00', supplier: sup.id, warehouse: wh.id, posted: true, lines: [{ product: milk.id, qty: 10, price: 20 }] }, null);
check('receipt numbered', rc.number, 'RC-000001');
check('receipt total computed', rc.total, 200);
const moves = await data.all('Stock');
check('one movement in', moves.map((m) => [m.direction, m.qty, m.amount, m.recorder === rc.id]), [['in', 10, 200, true]]);
check('stock after receipt', (await data.compute(T('Products'), [await data.get('Products', milk.id)]))[0].stock, 10);

// Selling 12 is refused, and does not use up a number.
try {
  await data.save(T('Sales'), { id: '', date: '2026-10-02T10:00:00', customer: cust.id, warehouse: wh.id, discount: 0, status: 'new', posted: true, lines: [{ product: milk.id, qty: 12, price: 30 }] }, null);
  check('overselling refused', 'saved', 'refused');
} catch (error) {
  check('overselling refused', /Not enough/.test(error.message), true);
}
const sale = await data.save(T('Sales'), { id: '', date: '2026-10-02T10:00:00', customer: cust.id, warehouse: wh.id, discount: 10, status: 'new', posted: true, lines: [{ product: milk.id, qty: 4, price: 30 }] }, null);
check('sale numbered without a gap', sale.number, 'SL-000001');
check('sale amount with discount', [sale.lines[0].amount, sale.total], [108, 108]);
check('stock after sale', (await data.compute(T('Products'), [await data.get('Products', milk.id)]))[0].stock, 6);
// Cancelling the receipt's posting would leave the sale without stock: refused.
// (The check applies to "out" movements only, so unposting a receipt is allowed by design;
// re-saving the sale with more than there is is not.)
try {
  await data.save(T('Sales'), { ...sale, lines: [{ product: milk.id, qty: 11, price: 30 }] }, sale);
  check('editing a sale beyond stock refused', 'saved', 'refused');
} catch (error) {
  check('editing a sale beyond stock refused', /Not enough/.test(error.message), true);
}
// Unposting removes the movements.
const unposted = await data.save(T('Sales'), { ...sale, posted: false }, sale);
check('unposted sale has no movements', (await data.all('Stock')).filter((m) => m.recorder === sale.id).length, 0);
// Deleting a posted document removes its movements in the same batch.
await data.remove(T('Receipts'), await data.get('Receipts', rc.id));
check('receipt deleted with its movements', (await data.all('Stock')).length, 0);
void unposted;

// Trigger: a discount above 30 needs a comment.
try {
  await data.save(T('Sales'), { id: '', date: '2026-10-03T10:00:00', customer: cust.id, warehouse: wh.id, discount: 35, status: 'new', posted: false, lines: [] }, null);
  check('trigger stops the save', 'saved', 'stopped');
} catch (error) {
  check('trigger stops the save', error.problems?.[0]?.message, 'A discount above 30% needs a comment explaining it');
}

// Action with ask + update over selected records.
const p2 = await data.save(T('Products'), { id: '', name: 'Bread', purchasePrice: 10, price: 20, isFolder: false }, null);
const ui = { ask: async () => ({ percent: 10 }), confirm: async () => true, message: () => {}, openRecord: () => {}, openNew: () => {}, open: () => {}, print: () => {}, runPlugin: async () => null };
await runAction(data, config.actions.find((a) => a.name === 'ChangePrice'), { table: T('Products'), selected: [milk, p2], current: milk }, ui);
const prices = (await data.all('Products')).filter((p) => !p.isFolder).map((p) => [p.name, p.price]).sort();
check('ChangePrice raised by 10%', prices, [['Bread', 22], ['Milk', 33]]);

// Reports.
await data.save(T('Receipts'), { id: '', date: '2026-09-01T09:00:00', supplier: sup.id, warehouse: wh.id, posted: true, lines: [{ product: milk.id, qty: 5, price: 20 }, { product: p2.id, qty: 3, price: 10 }] }, null);
const stock = await runReport(data, config.reports.find((r) => r.name === 'StockReport'), { period: { kind: 'all' } }, now);
check('stock report rows', stock.rows.map((r) => [stock.labels.product.get(r.product), r.qty]).sort(), [['Bread', 3], ['Milk', 5]]);
await data.save(T('Sales'), { id: '', date: '2026-09-15T10:00:00', customer: cust.id, warehouse: wh.id, discount: 0, status: 'paid', posted: true, lines: [{ product: milk.id, qty: 2, price: 30 }] }, null);
const byMonth = await runReport(data, config.reports.find((r) => r.name === 'SalesByMonth'), { period: { kind: 'all' } }, now);
check('sales by month', byMonth.rows.map((r) => [r['date:month'], r.total, r.count]), [['2026-09', 60, 1]]);
const byProduct = await runReport(data, config.reports.find((r) => r.name === 'SalesByProduct'), { period: { kind: 'all' } }, now);
check('sales by product (from lines)', byProduct.rows.map((r) => [byProduct.labels.product.get(r.product), r.qty, r.amount]), [['Milk', 2, 60]]);
const balanceAt = await runReport(data, config.reports.find((r) => r.name === 'StockReport'), { period: { kind: 'custom', to: '2026-09-10' } }, now);
check('balance at a date', balanceAt.rows.map((r) => [balanceAt.labels.product.get(r.product), r.qty]).sort(), [['Bread', 3], ['Milk', 5]]);

// Schema changes: a rename keeps the data, matched by key.
const renamed = structuredClone(config);
renamed.tables.find((x) => x.name === 'Products').fields.find((f) => f.name === 'sku').name = 'article';
const diff = schemaDiff(config, renamed);
check('rename seen as rename', diff, [{ op: 'renameField', table: 'Products', from: 'sku', to: 'article' }]);
await store.applySchema(diff);
data.setConfig(renamed);
check('renamed field keeps its value', (await data.get('Products', milk.id)).article, 'M1');

// Regressions from the review (docs: Task.md 18).
{
  // Overlapping writes to the memory store all land, and the lock still catches the stale one.
  const s = new Store(memoryAdapter());
  await Promise.all([s.insert('T', { id: 'a', n: 1 }), s.insert('T', { id: 'b', n: 2 })]);
  check('concurrent inserts both kept', (await s.query({ table: 'T' })).rows.length, 2);
  const results = await Promise.allSettled([s.update('T', 'a', { n: 3 }, '1'), s.update('T', 'a', { n: 4 }, '1')]);
  check('one of two stale updates refused', results.filter((r) => r.status === 'rejected').length, 1);
  const numbers = await Promise.all([s.nextNumber('q'), s.nextNumber('q'), s.nextNumber('q')]);
  check('concurrent sequence numbers distinct', [...numbers].sort(), [1, 2, 3]);

  // A line reaching the document's references: doc.customer.discount.
  const cfg = tpl.config();
  cfg.tables.find((x) => x.name === 'Sales').parts[0].fields.push({ key: 'f_rx', name: 'custDisc', type: 'decimal', computed: 'coalesce(doc.customer.discount, -1)' });
  cfg.triggers.push({ key: 'tr_zero', table: 'Sales', event: 'beforeSave', steps: [{ type: 'if', when: "status = 'new'", steps: [{ type: 'update', target: 'current', values: { discount: '0' } }] }] });
  cfg.triggers.push({ key: 'tr_after', table: 'Sales', event: 'afterSave', steps: [{ type: 'update', target: 'current', values: { comment: "'checked'" } }] });
  const st = new Store(memoryAdapter());
  const d2 = new DataService(cfg, { user: () => 't', now: () => now });
  d2.link('main', st, st.capabilities());
  installPosting(d2);
  installTriggers(d2);
  const w2 = await d2.save(d2.table('Warehouses'), { id: '', name: 'W' }, null);
  const c2 = await d2.save(d2.table('Counterparties'), { id: '', name: 'C', kind: 'customer', discount: 7 }, null);
  const p3 = await d2.save(d2.table('Products'), { id: '', name: 'P', price: 10, isFolder: false }, null);
  const s2 = await d2.save(d2.table('Sales'), { id: '', date: '2026-10-05T10:00:00', customer: c2.id, warehouse: w2.id, discount: 20, status: 'new', posted: false, lines: [{ product: p3.id, qty: 3, price: 10 }] }, null);
  check('line reaches doc.customer.discount', s2.lines[0].custDisc, 7);
  check('beforeSave change recomputes the total', [s2.discount, s2.total], [0, 30]);
  const stored = await d2.get('Sales', s2.id);
  check('afterSave trigger updating its record runs once', [stored.comment, Number(stored._rev) <= 3], ['checked', true]);
}

// The demo seeds without errors.
const demoStore = new Store(memoryAdapter());
const demo = new DataService(tpl.config(), { user: () => 'demo', now: () => now });
demo.link('main', demoStore, demoStore.capabilities());
installPosting(demo);
installTriggers(demo);
await tpl.seed(demo, () => {});
const sales = await demo.all('Sales');
check('demo has sales', sales.length, 48);
check('most demo sales posted', sales.filter((s) => s.posted).length >= 40, true);
check('demo stock never negative', (await runReport(demo, demo.config.reports.find((r) => r.name === 'StockReport'), { period: { kind: 'all' } }, now)).rows.every((r) => r.qty >= 0), true);
done('data');
