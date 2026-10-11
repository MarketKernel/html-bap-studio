/**
 * Starter applications (Task.md 1): an empty one, and "Warehouse and sales"
 * with demo data — it shows most of what the studio can do and the browser
 * test runs on it. Titles go through t(), so the application starts in the
 * language of the interface; once created they are the user's data.
 */
import { t } from '../core/i18n';
import { emptyConfig, type Config } from '../core/config/types';
import type { DataService } from '../core/data';
import { isoDate, isoDateTime } from '../core/data';
import { financeConfig, seedFinance } from './templates-finance';

export interface Template {
  id: string;
  title: string;
  description: string;
  icon: string;
  config(): Config;
  seed?(data: DataService, progress: (text: string) => void): Promise<void>;
}

const f = (key: string, name: string, title: string, type: Config['tables'][number]['fields'][number]['type'], extra: Partial<Config['tables'][number]['fields'][number]> = {}) => ({ key, name, title, type, ...extra });

function warehouseConfig(): Config {
  const c = emptyConfig(t('template', 'Warehouse and sales'));
  c.app.currency = 'UAH';
  c.app.icon = 'warehouse';
  c.app.home = 'Home';
  c.enums = [
    {
      key: 'e_unit',
      name: 'Unit',
      title: t('template', 'Units'),
      values: [
        { value: 'pcs', title: t('template', 'pcs') },
        { value: 'kg', title: t('template', 'kg') },
        { value: 'l', title: t('template', 'l') },
        { value: 'pack', title: t('template', 'pack') },
      ],
    },
    {
      key: 'e_kind',
      name: 'PartyKind',
      title: t('template', 'Counterparty kinds'),
      values: [
        { value: 'supplier', title: t('template', 'Supplier') },
        { value: 'customer', title: t('template', 'Customer') },
        { value: 'both', title: t('template', 'Supplier and customer') },
      ],
    },
    {
      key: 'e_status',
      name: 'SaleStatus',
      title: t('template', 'Sale statuses'),
      values: [
        { value: 'new', title: t('template', 'New'), color: '#2f5bd3' },
        { value: 'shipped', title: t('template', 'Shipped'), color: '#a86400' },
        { value: 'paid', title: t('template', 'Paid'), color: '#1f8a4c' },
      ],
    },
  ];
  c.tables = [
    {
      key: 't_products',
      name: 'Products',
      kind: 'catalog',
      title: t('template', 'Products'),
      itemTitle: t('template', 'Product'),
      icon: 'box',
      hierarchical: true,
      description: t('template', 'Goods we buy and sell. The stock is counted by the “Stock” register from posted documents.'),
      fields: [
        f('f_p_name', 'name', t('template', 'Name'), 'string', { required: true, maxLength: 150, width: 260 }),
        f('f_p_sku', 'sku', t('template', 'SKU'), 'string', { unique: true, width: 100 }),
        f('f_p_unit', 'unit', t('template', 'Unit'), 'enum', { enum: 'Unit', default: "'pcs'", width: 70 }),
        f('f_p_buy', 'purchasePrice', t('template', 'Purchase price'), 'decimal', { scale: 2, money: true, min: 0, width: 110 }),
        f('f_p_price', 'price', t('template', 'Price'), 'decimal', { scale: 2, money: true, min: 0, width: 100 }),
        f('f_p_margin', 'margin', t('template', 'Margin %'), 'decimal', { scale: 1, computed: 'iif(purchasePrice > 0, round((price - purchasePrice) / purchasePrice * 100, 1), null)', width: 90 }),
        f('f_p_stock', 'stock', t('template', 'In stock'), 'decimal', { scale: 3, computed: "balance('Stock', 'qty', 'product', id)", width: 100 }),
        f('f_p_notes', 'notes', t('template', 'Notes'), 'text', { list: false }),
      ],
      validations: [{ when: 'price > 0 and purchasePrice > price', message: t('template', 'The price is below the purchase price') }],
    },
    {
      key: 't_wh',
      name: 'Warehouses',
      kind: 'catalog',
      title: t('template', 'Warehouses'),
      itemTitle: t('template', 'Warehouse'),
      icon: 'warehouse',
      fields: [f('f_w_name', 'name', t('template', 'Name'), 'string', { required: true, width: 200 }), f('f_w_addr', 'address', t('template', 'Address'), 'string', { width: 280 })],
    },
    {
      key: 't_parties',
      name: 'Counterparties',
      kind: 'catalog',
      title: t('template', 'Counterparties'),
      itemTitle: t('template', 'Counterparty'),
      icon: 'users',
      fields: [
        f('f_c_name', 'name', t('template', 'Name'), 'string', { required: true, width: 240 }),
        f('f_c_kind', 'kind', t('template', 'Kind'), 'enum', { enum: 'PartyKind', default: "'customer'", width: 120 }),
        f('f_c_tax', 'taxId', t('template', 'Tax ID'), 'string', { width: 110 }),
        f('f_c_phone', 'phone', t('template', 'Phone'), 'phone', { width: 130 }),
        f('f_c_mail', 'email', t('template', 'E-mail'), 'email', { width: 180 }),
        f('f_c_disc', 'discount', t('template', 'Discount %'), 'decimal', { scale: 1, min: 0, max: 50, default: '0', width: 90 }),
        f('f_c_addr', 'address', t('template', 'Address'), 'string', { list: false }),
      ],
    },
    {
      key: 't_receipts',
      name: 'Receipts',
      kind: 'document',
      title: t('template', 'Receipts'),
      itemTitle: t('template', 'Receipt'),
      icon: 'truck',
      description: t('template', 'Goods received from suppliers. Posting adds them to the stock.'),
      numbering: { sequence: 'receipt', format: 'RC-{000000}' },
      fields: [
        f('f_r_sup', 'supplier', t('template', 'Supplier'), 'ref', { ref: 'Counterparties', required: true, width: 200 }),
        f('f_r_wh', 'warehouse', t('template', 'Warehouse'), 'ref', { ref: 'Warehouses', required: true, width: 150 }),
        f('f_r_total', 'total', t('template', 'Amount'), 'decimal', { scale: 2, money: true, computed: 'sum(lines.amount)', width: 120 }),
        f('f_r_comment', 'comment', t('template', 'Comment'), 'text', { list: false }),
      ],
      parts: [
        {
          key: 'p_r_lines',
          name: 'lines',
          title: t('template', 'Goods'),
          fields: [
            f('f_rl_prod', 'product', t('template', 'Product'), 'ref', { ref: 'Products', required: true, width: 260 }),
            f('f_rl_qty', 'qty', t('template', 'Quantity'), 'decimal', { scale: 3, required: true, min: 0, default: '1', width: 90 }),
            f('f_rl_price', 'price', t('template', 'Price'), 'decimal', { scale: 2, default: 'product.purchasePrice', width: 100 }),
            f('f_rl_amount', 'amount', t('template', 'Amount'), 'decimal', { scale: 2, computed: 'round(qty * price, 2)', width: 110 }),
          ],
        },
      ],
      posting: [{ key: 'po_r', register: 'Stock', from: 'lines', direction: 'in', set: { product: 'product', warehouse: 'doc.warehouse', qty: 'qty', amount: 'amount' } }],
    },
    {
      key: 't_sales',
      name: 'Sales',
      kind: 'document',
      title: t('template', 'Sales'),
      itemTitle: t('template', 'Sale'),
      icon: 'cart',
      description: t('template', 'Goods sold to customers. Posting takes them from the stock; selling more than there is is refused.'),
      numbering: { sequence: 'sale', format: 'SL-{000000}' },
      fields: [
        f('f_s_cust', 'customer', t('template', 'Customer'), 'ref', { ref: 'Counterparties', required: true, width: 200 }),
        f('f_s_wh', 'warehouse', t('template', 'Warehouse'), 'ref', { ref: 'Warehouses', required: true, width: 150 }),
        f('f_s_status', 'status', t('template', 'Status'), 'enum', { enum: 'SaleStatus', default: "'new'", width: 100 }),
        f('f_s_disc', 'discount', t('template', 'Discount %'), 'decimal', { scale: 1, min: 0, max: 50, default: 'coalesce(customer.discount, 0)', width: 90 }),
        f('f_s_total', 'total', t('template', 'Amount'), 'decimal', { scale: 2, money: true, computed: 'sum(lines.amount)', width: 120 }),
        f('f_s_comment', 'comment', t('template', 'Comment'), 'text', { list: false }),
      ],
      parts: [
        {
          key: 'p_s_lines',
          name: 'lines',
          title: t('template', 'Goods'),
          fields: [
            f('f_sl_prod', 'product', t('template', 'Product'), 'ref', { ref: 'Products', required: true, width: 260 }),
            f('f_sl_qty', 'qty', t('template', 'Quantity'), 'decimal', { scale: 3, required: true, min: 0, default: '1', width: 90 }),
            f('f_sl_price', 'price', t('template', 'Price'), 'decimal', { scale: 2, default: 'product.price', width: 100 }),
            f('f_sl_amount', 'amount', t('template', 'Amount'), 'decimal', { scale: 2, computed: 'round(qty * price * (1 - coalesce(doc.discount, 0) / 100), 2)', width: 110 }),
          ],
        },
      ],
      posting: [{ key: 'po_s', register: 'Stock', from: 'lines', direction: 'out', set: { product: 'product', warehouse: 'doc.warehouse', qty: 'qty', amount: 'round(qty * coalesce(product.purchasePrice, 0), 2)' } }],
    },
    {
      key: 't_stock',
      name: 'Stock',
      kind: 'register',
      title: t('template', 'Stock'),
      icon: 'boxes',
      registerKind: 'balance',
      description: t('template', 'Movements of goods: what came in and went out, by product and warehouse.'),
      fields: [
        f('f_st_prod', 'product', t('template', 'Product'), 'ref', { ref: 'Products', role: 'dimension', width: 240 }),
        f('f_st_wh', 'warehouse', t('template', 'Warehouse'), 'ref', { ref: 'Warehouses', role: 'dimension', width: 150 }),
        f('f_st_qty', 'qty', t('template', 'Quantity'), 'decimal', { scale: 3, role: 'resource', width: 100 }),
        f('f_st_amount', 'amount', t('template', 'Cost'), 'decimal', { scale: 2, role: 'resource', width: 110 }),
      ],
      denyNegative: ['qty'],
    },
  ];
  c.views = [
    {
      key: 'v_products',
      name: 'ProductsList',
      table: 'Products',
      title: t('template', 'Products'),
      icon: 'box',
      description: t('template', 'Products. Red — out of stock, amber — fewer than 10 left. Right-click a column header for more.'),
      columns: [{ field: 'name' }, { field: 'sku' }, { field: 'unit' }, { field: 'purchasePrice' }, { field: 'price' }, { field: 'margin' }, { field: 'stock', total: 'sum' }],
      sort: [{ field: 'name' }],
      rules: [
        { key: 'r_out', when: 'not isFolder and coalesce(stock, 0) <= 0', field: 'stock', color: '#c93535', bold: true, description: t('template', 'Out of stock') },
        { key: 'r_low', when: 'not isFolder and stock > 0 and stock < 10', field: 'stock', background: '#fff1cc', color: '#7a4b00', description: t('template', 'Running low') },
      ],
      actions: ['ChangePrice'],
    },
    {
      key: 'v_sales',
      name: 'SalesList',
      table: 'Sales',
      title: t('template', 'Sales'),
      icon: 'cart',
      columns: [{ field: 'number' }, { field: 'date' }, { field: 'posted' }, { field: 'customer' }, { field: 'warehouse' }, { field: 'status' }, { field: 'discount' }, { field: 'total', total: 'sum' }],
      sort: [{ field: 'date', desc: true }],
      rules: [
        { key: 'r_unposted', when: 'not posted', color: '#7b8394', description: t('template', 'Not posted') },
        { key: 'r_paid', when: "status = 'paid'", field: 'status', color: '#1f8a4c', bold: true, description: t('template', 'Paid') },
      ],
      actions: ['MarkPaid'],
    },
    {
      key: 'v_unpaid',
      name: 'UnpaidSales',
      table: 'Sales',
      title: t('template', 'Unpaid sales'),
      icon: 'wallet',
      description: t('template', 'Posted sales not paid yet.'),
      columns: [{ field: 'number' }, { field: 'date' }, { field: 'customer' }, { field: 'status' }, { field: 'total', total: 'sum' }],
      filter: { and: [{ field: 'posted', op: 'eq', value: true }, { field: 'status', op: 'ne', value: 'paid' }] },
      sort: [{ field: 'date' }],
      actions: ['MarkPaid'],
    },
  ];
  c.actions = [
    {
      key: 'a_paid',
      name: 'MarkPaid',
      title: t('template', 'Mark as paid'),
      icon: 'check',
      table: 'Sales',
      multi: true,
      where: ['list', 'card'],
      steps: [
        { type: 'confirm', text: t('template', 'Mark the selected sales as paid?') },
        { type: 'update', target: 'selected', values: { status: "'paid'" } },
        { type: 'message', text: t('template', 'Done') },
      ],
    },
    {
      key: 'a_price',
      name: 'ChangePrice',
      title: t('template', 'Change prices…'),
      icon: 'tag',
      table: 'Products',
      multi: true,
      where: ['list'],
      steps: [
        { type: 'ask', title: t('template', 'Change prices'), fields: [{ key: 'pp', name: 'percent', title: t('template', 'By, %'), type: 'decimal', scale: 1, default: '5', required: true }] },
        { type: 'update', target: 'selected', values: { price: 'round(price * (1 + $params.percent / 100), 2)' } },
      ],
    },
    {
      key: 'a_sell',
      name: 'NewSale',
      title: t('template', 'New sale to this customer'),
      icon: 'cart',
      table: 'Counterparties',
      where: ['card', 'list'],
      steps: [{ type: 'create', table: 'Sales', values: { customer: 'id', discount: 'discount' }, open: true }],
    },
  ];
  c.triggers = [
    {
      key: 'tr_disc',
      table: 'Sales',
      event: 'beforeSave',
      description: t('template', 'A discount above 30% needs a comment'),
      steps: [{ type: 'if', when: 'discount > 30 and isEmpty(comment)', steps: [{ type: 'stop', text: t('template', 'A discount above 30% needs a comment explaining it') }] }],
    },
  ];
  c.reports = [
    {
      key: 'rp_stock',
      name: 'StockReport',
      title: t('template', 'Stock by warehouse'),
      icon: 'boxes',
      source: 'Stock',
      mode: 'balance',
      groupBy: ['product', 'warehouse'],
      measures: [
        { name: 'qty', fn: 'sum', field: 'qty', title: t('template', 'Quantity') },
        { name: 'amount', fn: 'sum', field: 'amount', title: t('template', 'Cost') },
      ],
      sort: [{ field: 'qty', desc: true }],
      chart: { type: 'hbar', x: 'product', series: ['amount'], title: t('template', 'Cost of stock') },
    },
    {
      key: 'rp_month',
      name: 'SalesByMonth',
      title: t('template', 'Sales by month'),
      icon: 'line',
      source: 'Sales',
      where: 'posted',
      dateField: 'date',
      params: [{ name: 'period', type: 'period', title: t('template', 'Period'), default: 'year' }],
      groupBy: ['date:month'],
      measures: [
        { name: 'total', fn: 'sum', field: 'total', title: t('template', 'Amount') },
        { name: 'count', fn: 'count', title: t('template', 'Sales') },
      ],
      sort: [{ field: 'date:month' }],
      chart: { type: 'bar', x: 'date:month', series: ['total'], title: t('template', 'Sales by month') },
    },
    {
      key: 'rp_prod',
      name: 'SalesByProduct',
      title: t('template', 'Sales by product'),
      icon: 'pie',
      source: 'Sales.lines',
      where: 'doc.posted',
      dateField: 'doc.date',
      params: [{ name: 'period', type: 'period', title: t('template', 'Period'), default: 'all' }],
      groupBy: ['product'],
      measures: [
        { name: 'qty', fn: 'sum', field: 'qty', title: t('template', 'Quantity') },
        { name: 'amount', fn: 'sum', field: 'amount', title: t('template', 'Amount') },
      ],
      sort: [{ field: 'amount', desc: true }],
      chart: { type: 'donut', x: 'product', series: ['amount'], title: t('template', 'Share of sales') },
    },
    {
      key: 'rp_cust',
      name: 'SalesByCustomer',
      title: t('template', 'Sales by customer'),
      icon: 'users',
      source: 'Sales',
      where: 'posted',
      dateField: 'date',
      params: [{ name: 'period', type: 'period', title: t('template', 'Period'), default: 'all' }],
      groupBy: ['customer', 'status'],
      measures: [{ name: 'total', fn: 'sum', field: 'total', title: t('template', 'Amount') }],
      sort: [{ field: 'total', desc: true }],
      chart: { type: 'stacked', x: 'customer', series: ['total'], title: t('template', 'Sales by customer and status') },
    },
  ];
  c.dashboards = [
    {
      key: 'd_home',
      name: 'Home',
      title: t('template', 'Overview'),
      widgets: [
        { key: 'w1', type: 'kpi', title: t('template', 'Sales this month'), x: 0, y: 0, w: 3, h: 1, table: 'Sales', fn: 'sum', field: 'total', where: 'posted and date >= startOfMonth($today)' },
        { key: 'w2', type: 'kpi', title: t('template', 'Unpaid'), x: 3, y: 0, w: 3, h: 1, table: 'Sales', fn: 'sum', field: 'total', where: "posted and status <> 'paid'" },
        { key: 'w3', type: 'kpi', title: t('template', 'Products out of stock'), x: 6, y: 0, w: 3, h: 1, table: 'Products', fn: 'count', where: 'not isFolder and coalesce(stock, 0) <= 0' },
        { key: 'w4', type: 'kpi', title: t('template', 'Customers'), x: 9, y: 0, w: 3, h: 1, table: 'Counterparties', fn: 'count', where: "kind <> 'supplier'" },
        { key: 'w5', type: 'chart', title: t('template', 'Sales by month'), x: 0, y: 1, w: 7, h: 3, report: 'SalesByMonth' },
        { key: 'w6', type: 'chart', title: t('template', 'Share of sales'), x: 7, y: 1, w: 5, h: 3, report: 'SalesByProduct' },
        { key: 'w7', type: 'list', title: t('template', 'Unpaid sales'), x: 0, y: 4, w: 7, h: 3, view: 'UnpaidSales' },
        { key: 'w8', type: 'chart', title: t('template', 'Cost of stock'), x: 7, y: 4, w: 5, h: 3, report: 'StockReport' },
      ],
    },
  ];
  c.printTemplates = [
    {
      key: 'pt_sale',
      name: 'Invoice',
      title: t('template', 'Invoice'),
      table: 'Sales',
      // Written in the interface's language when the application is created: from then on it is the user's text.
      html: [
        `<h1>${t('template', 'Invoice')} {{number}}</h1>`,
        `<p>${t('template', 'Date')}: {{format date "date"}}<br>${t('template', 'Customer')}: <b>{{customer.name}}</b><br>${t('template', 'Warehouse')}: {{warehouse.name}}</p>`,
        `<table><thead><tr><th>#</th><th>${t('template', 'Product')}</th><th class="num">${t('template', 'Quantity')}</th><th class="num">${t('template', 'Price')}</th><th class="num">${t('template', 'Amount')}</th></tr></thead>`,
        '<tbody>{{#each lines}}<tr><td>{{@number}}</td><td>{{product.name}}</td><td class="num">{{format qty "number"}}</td><td class="num">{{format price "money"}}</td><td class="num">{{format amount "money"}}</td></tr>{{/each}}</tbody>',
        `<tfoot><tr><td colspan="4" class="num">${t('template', 'Total')}</td><td class="num"><b>{{format total "money"}}</b></td></tr></tfoot></table>`,
        `<p>${t('template', 'Discount')}: {{discount}}%</p>`,
        '<p class="words">{{amountInWords total}}</p>',
      ].join('\n'),
    },
  ];
  c.menu = [
    {
      key: 'm_main',
      title: t('template', 'Main'),
      children: [
        { key: 'm_home', title: t('template', 'Overview'), icon: 'dashboard', target: { kind: 'dashboard', name: 'Home' } },
        { key: 'm_sales', title: t('template', 'Sales'), icon: 'cart', target: { kind: 'view', name: 'SalesList' } },
        { key: 'm_unpaid', title: t('template', 'Unpaid sales'), icon: 'wallet', target: { kind: 'view', name: 'UnpaidSales' } },
        { key: 'm_receipts', title: t('template', 'Receipts'), icon: 'truck', target: { kind: 'table', name: 'Receipts' } },
      ],
    },
    {
      key: 'm_cat',
      title: t('template', 'Catalogs'),
      children: [
        { key: 'm_products', title: t('template', 'Products'), icon: 'box', target: { kind: 'view', name: 'ProductsList' } },
        { key: 'm_parties', title: t('template', 'Counterparties'), icon: 'users', target: { kind: 'table', name: 'Counterparties' } },
        { key: 'm_wh', title: t('template', 'Warehouses'), icon: 'warehouse', target: { kind: 'table', name: 'Warehouses' } },
      ],
    },
    {
      key: 'm_rep',
      title: t('template', 'Reports'),
      children: [
        { key: 'm_stock', title: t('template', 'Stock by warehouse'), icon: 'boxes', target: { kind: 'report', name: 'StockReport' } },
        { key: 'm_month', title: t('template', 'Sales by month'), icon: 'line', target: { kind: 'report', name: 'SalesByMonth' } },
        { key: 'm_prod', title: t('template', 'Sales by product'), icon: 'pie', target: { kind: 'report', name: 'SalesByProduct' } },
        { key: 'm_cust', title: t('template', 'Sales by customer'), icon: 'users', target: { kind: 'report', name: 'SalesByCustomer' } },
        { key: 'm_moves', title: t('template', 'Stock movements'), icon: 'list', target: { kind: 'table', name: 'Stock' } },
      ],
    },
  ];
  return c;
}

/** A small deterministic generator: the same demo every time, for tests and screenshots. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedWarehouse(data: DataService, progress: (text: string) => void): Promise<void> {
  const rnd = random(20261008);
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)]!;
  const save = (table: string, row: Record<string, unknown>) => data.save(data.table(table), { id: '', ...row }, null);
  progress(t('template', 'Warehouses and counterparties…'));
  const warehouses = [await save('Warehouses', { name: t('template', 'Main warehouse'), address: t('template', '12 Industrial St.') }), await save('Warehouses', { name: t('template', 'Shop'), address: t('template', '5 Market Sq.') })];
  const suppliers = [];
  for (const [name, tax] of [
    [t('template', 'Fresh Farm LLC'), '31245678'],
    [t('template', 'Global Foods Ltd'), '40871234'],
    [t('template', 'Household Supply Co.'), '35560912'],
  ] as const) {
    suppliers.push(await save('Counterparties', { name, kind: 'supplier', taxId: tax, discount: 0, phone: `+380 44 ${Math.floor(100 + rnd() * 899)} ${Math.floor(10 + rnd() * 89)} ${Math.floor(10 + rnd() * 89)}` }));
  }
  const customers = [];
  for (const [name, discount] of [
    [t('template', 'Corner Shop'), 0],
    [t('template', 'Cafe “Morning”'), 5],
    [t('template', 'Hotel Riverside'), 10],
    [t('template', 'School canteen No. 3'), 7.5],
    [t('template', 'Olena Kovalenko'), 0],
    [t('template', 'Mini-market “Daily”'), 3],
    [t('template', 'Restaurant “Old Town”'), 12],
  ] as const) {
    customers.push(await save('Counterparties', { name, kind: 'customer', discount, email: `orders${customers.length + 1}@example.com` }));
  }
  progress(t('template', 'Products…'));
  const groups: [string, [string, string, string, number][]][] = [
    [t('template', 'Dairy'), [[t('template', 'Milk 2.5%, 1 l'), 'D-001', 'l', 28.5], [t('template', 'Kefir 1%, 0.9 l'), 'D-002', 'l', 31], [t('template', 'Butter 82%'), 'D-003', 'pack', 78], [t('template', 'Cheese “Gouda”'), 'D-004', 'kg', 320], [t('template', 'Sour cream 20%'), 'D-005', 'pack', 36]]],
    [t('template', 'Bakery'), [[t('template', 'Rye bread'), 'B-001', 'pcs', 24], [t('template', 'Baguette'), 'B-002', 'pcs', 19], [t('template', 'Croissant'), 'B-003', 'pcs', 27]]],
    [t('template', 'Groceries'), [[t('template', 'Buckwheat'), 'G-001', 'kg', 52], [t('template', 'Rice'), 'G-002', 'kg', 58], [t('template', 'Pasta'), 'G-003', 'pack', 34], [t('template', 'Sunflower oil'), 'G-004', 'l', 69], [t('template', 'Sugar'), 'G-005', 'kg', 31], [t('template', 'Flour'), 'G-006', 'kg', 22]]],
    [t('template', 'Drinks'), [[t('template', 'Mineral water 1.5 l'), 'W-001', 'pcs', 21], [t('template', 'Apple juice 1 l'), 'W-002', 'pcs', 46], [t('template', 'Green tea'), 'W-003', 'pack', 64], [t('template', 'Coffee beans'), 'W-004', 'kg', 640]]],
    [t('template', 'Household'), [[t('template', 'Dish soap'), 'H-001', 'pcs', 55], [t('template', 'Paper towels'), 'H-002', 'pack', 48], [t('template', 'Trash bags'), 'H-003', 'pack', 39]]],
  ];
  const products: { id: string; price: number; buy: number }[] = [];
  for (const [groupName, items] of groups) {
    const group = await save('Products', { name: groupName, isFolder: true });
    for (const [name, sku, unit, buy] of items) {
      const price = Math.round(buy * (1.25 + rnd() * 0.3) * 100) / 100;
      const p = await save('Products', { name, sku, unit, purchasePrice: buy, price, parent: group.id, isFolder: false });
      products.push({ id: p.id, price, buy });
    }
  }
  // An item nobody has delivered yet: shown red in the list.
  await save('Products', { name: t('template', 'Truffle oil'), sku: 'G-099', unit: 'l', purchasePrice: 900, price: 1250, parent: null, isFolder: false });

  const today = new Date();
  const day = (offset: number, hour = 10) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, hour, Math.floor(rnd() * 60));
    return isoDateTime(d);
  };
  progress(t('template', 'Receipts…'));
  // Every product arrives at both warehouses early on, then more now and then: most sales can be posted.
  for (let i = 0; i < 12; i++) {
    const warehouse = i % 2 === 0 ? warehouses[0]! : warehouses[1]!;
    const lines = [];
    const batch = i < 4 ? products.filter((_, k) => k % 2 === Math.floor(i / 2) % 2) : products.filter(() => rnd() < 0.35);
    for (const p of batch) lines.push({ product: p.id, qty: (i < 4 ? 40 : 15) + Math.floor(rnd() * 60), price: p.buy });
    if (!lines.length) continue;
    await save('Receipts', { date: day(i < 4 ? 175 - i : 150 - (i - 4) * 18, 8), supplier: pick(suppliers).id, warehouse: warehouse.id, posted: true, lines, comment: '' });
  }
  progress(t('template', 'Sales…'));
  const statuses = ['paid', 'paid', 'paid', 'shipped', 'new'];
  for (let i = 0; i < 48; i++) {
    const customer = pick(customers);
    const offset = 160 - Math.floor(i * 3.3);
    const lines = [];
    const used = new Set<string>();
    for (let n = 0; n < 1 + Math.floor(rnd() * 4); n++) {
      const p = pick(products);
      if (used.has(p.id)) continue;
      used.add(p.id);
      lines.push({ product: p.id, qty: 1 + Math.floor(rnd() * 6), price: p.price });
    }
    const row = { date: day(Math.max(0, offset), 12), customer: customer.id, warehouse: (i % 4 === 3 ? warehouses[1]! : warehouses[0]!).id, status: offset < 10 ? pick(['new', 'shipped']) : pick(statuses), discount: customer.discount ?? 0, posted: i % 17 !== 9, lines, comment: '' };
    try {
      await save('Sales', row);
    } catch {
      // Not enough of something in that warehouse on that day: keep it as a draft.
      await save('Sales', { ...row, posted: false });
    }
  }
  void isoDate;
}

export const TEMPLATES: Template[] = [
  {
    id: 'finance',
    title: t('template', 'Personal finances'),
    description: t('template', 'Accounts and debts in any currency, recurring and one-off operations, reconciliations, a forecast and goals — with four months of demo data.'),
    icon: 'wallet',
    config: financeConfig,
    seed: seedFinance,
  },
  {
    id: 'finance-empty',
    title: t('template', 'Personal finances, no data'),
    description: t('template', 'The same application, empty: add your currencies and accounts, then reconcile.'),
    icon: 'wallet',
    config: financeConfig,
  },
  {
    id: 'warehouse',
    title: t('template', 'Warehouse and sales'),
    description: t('template', 'Products, counterparties, receipts and sales, stock register, reports and an overview — with demo data.'),
    icon: 'warehouse',
    config: warehouseConfig,
    seed: seedWarehouse,
  },
  {
    id: 'warehouse-empty',
    title: t('template', 'Warehouse and sales, no data'),
    description: t('template', 'The same application, empty: start entering your own data.'),
    icon: 'boxes',
    config: warehouseConfig,
  },
  {
    id: 'blank',
    title: t('template', 'Empty application'),
    description: t('template', 'Nothing yet: build tables, forms and reports in the designer.'),
    icon: 'layers',
    config: () => emptyConfig(t('template', 'New application')),
  },
];
