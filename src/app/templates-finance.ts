/**
 * "Personal finances" (Task_next.md 4): Cashflow — accounts and debts in any
 * currency, recurring and one-off operations, reconciliations that find the
 * money that went unrecorded, a forecast years ahead, how long the money
 * lasts, when a goal can be bought — built as a configuration, with nothing
 * in the core that knows about money.
 *
 * How it hangs together:
 *   - Money is a register by account and currency. An account's opening
 *     balance, a one-off operation and a reconciliation's differences are
 *     stored movements; a recurring operation plans its movements by its
 *     schedule, so they count as made once their moment has passed, and the
 *     forecast is the same register at later dates.
 *   - A movement's worth in the base currency is a computed field of the
 *     register: amount × rate × (1 − fee), a debt's × (1 + fee) — a fee makes a
 *     debt larger. Values are linear in the balances, so the sum of the worths
 *     is the worth of the balances at today's rates.
 *   - A reconciliation starts with every account and its expected balance on
 *     its date; what is typed in differs by the unaccounted money, posted as a
 *     correcting movement. Operations dated before the last one are a closed
 *     period: kept unposted, as notes.
 *   - A debt's balance is kept signed, as minus what is owed, and shown owed.
 *
 * Titles go through t(), so the application starts in the language of the
 * interface; once created they are the user's data.
 */
import { t } from '../core/i18n';
import { emptyConfig, type Config, type FieldDef, type PostingRule } from '../core/config/types';
import type { DataService } from '../core/data';
import { isoDate, isoDateTime } from '../core/data';
import type { Row } from '../core/query/types';

type Field = FieldDef;
const f = (key: string, name: string, title: string, type: Field['type'], extra: Partial<Field> = {}): Field => ({ key, name, title, type, ...extra });

/** A text as an expression literal: quotes doubled. */
const q = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** What a movement of Money is worth in the base currency, signed by its direction. */
const WORTH = "iif(direction = 'out', -1, 1) * amount * coalesce(currency.rate, 1) * iif(account.kind = 'debt', 1 + coalesce(account.fee, 0) / 100, 1 - coalesce(account.fee, 0) / 100)";
/** Money on the accounts, not owed: money outside any account counts here too. */
const ASSETS = "coalesce(account.kind, 'asset') <> 'debt'";
/** The reconciliations the pace of unaccounted money is learnt from: the window up to the last, after spending outside the accounts was last planned. */
const PACE_WINDOW = `posted and not isEmpty(prevDate) and date >= addDays(maxOf('Reconciliations', 'date', 'posted'), -coalesce($const.windowDays, 90)) and date > coalesce(maxOf('Recurring', 'validFrom', 'type = ''expense'' and isEmpty(account)'), '1900-01-01')`;
const PACE = `sumOf('Reconciliations', 'unaccounted', "${PACE_WINDOW}") / sumOf('Reconciliations', 'days', "${PACE_WINDOW}")`;

/** One operation, three movements at most: income in, expense out, a transfer out of one account and into another. */
function moneyRules(from: 'header' | 'schedule', prefix: string): PostingRule[] {
  const at = from === 'schedule' ? { schedule: 'when' } : {};
  return [
    { key: `${prefix}_in`, register: 'Money', from, ...at, direction: 'in', when: "type = 'income'", set: { account: 'account', currency: 'coalesce(account.currency, currency)', amount: 'amount' } },
    { key: `${prefix}_out`, register: 'Money', from, ...at, direction: 'out', when: "type in ('expense', 'transfer')", set: { account: 'account', currency: 'coalesce(account.currency, currency)', amount: 'amount' } },
    { key: `${prefix}_to`, register: 'Money', from, ...at, direction: 'in', when: "type = 'transfer' and not isEmpty(toAccount)", set: { account: 'toAccount', currency: 'toAccount.currency', amount: 'coalesce(amountTo, amount)' } },
  ];
}

/** The fields an operation has, recurring or one-off. */
function operationFields(p: string): Field[] {
  return [
    f(`${p}_type`, 'type', t('finance', 'Type'), 'enum', { enum: 'OpType', default: "'expense'", required: true, width: 110 }),
    f(`${p}_amount`, 'amount', t('finance', 'Amount'), 'decimal', { scale: 2, money: true, required: true, min: 0, width: 120 }),
    f(`${p}_account`, 'account', t('finance', 'Account'), 'ref', { ref: 'Accounts', width: 170, description: t('finance', 'Empty: money outside the accounts, in a currency') }),
    f(`${p}_currency`, 'currency', t('finance', 'Currency'), 'ref', { ref: 'Currencies', default: 'coalesce(account.currency, $const.base)', visible: 'isEmpty(account)', width: 80 }),
    f(`${p}_to`, 'toAccount', t('finance', 'To account'), 'ref', { ref: 'Accounts', visible: "type = 'transfer'", width: 170 }),
    f(`${p}_amountTo`, 'amountTo', t('finance', 'Amount credited'), 'decimal', { scale: 2, money: true, min: 0, visible: "type = 'transfer' and toAccount.currency <> account.currency", description: t('finance', 'What reaches the other account, in its currency'), width: 120 }),
  ];
}

export function financeConfig(): Config {
  const c = emptyConfig(t('finance', 'Personal finances'));
  c.app.icon = 'wallet';
  c.app.home = 'Overview';
  c.constants = [
    f('k_base', 'base', t('finance', 'Base currency'), 'ref', { ref: 'Currencies', description: t('finance', 'Every total is shown in it; its rate is 1') }),
    f('k_horizon', 'horizonYears', t('finance', 'Forecast, years'), 'integer', { default: '5', min: 1, max: 20 }),
    f('k_window', 'windowDays', t('finance', 'Unaccounted money: learn the pace from the last, days'), 'integer', { default: '90', min: 7, max: 730 }),
  ];
  c.enums = [
    { key: 'e_kind', name: 'AccountKind', title: t('finance', 'Kinds of accounts'), values: [{ value: 'asset', title: t('finance', 'Account') }, { value: 'debt', title: t('finance', 'Debt'), color: '#c93535' }] },
    {
      key: 'e_op',
      name: 'OpType',
      title: t('finance', 'Kinds of operations'),
      values: [
        { value: 'income', title: t('finance', 'Income'), color: '#1f8a4c' },
        { value: 'expense', title: t('finance', 'Expense') },
        { value: 'transfer', title: t('finance', 'Transfer'), color: '#2f5bd3' },
      ],
    },
    { key: 'e_rule', name: 'GoalRule', title: t('finance', 'When a goal is affordable'), values: [{ value: 'margin', title: t('finance', 'With money to spare') }, { value: 'share', title: t('finance', 'As a share of the money') }] },
  ];
  c.tables = [
    {
      key: 't_cur',
      name: 'Currencies',
      kind: 'catalog',
      title: t('finance', 'Currencies'),
      itemTitle: t('finance', 'Currency'),
      icon: 'rates',
      display: 'code',
      description: t('finance', 'Rates are typed in by hand: one unit of the currency in the base currency.'),
      fields: [
        f('f_cur_code', 'code', t('finance', 'Code'), 'string', { required: true, unique: true, maxLength: 10, pattern: '^[A-Z0-9]{2,10}$', width: 90 }),
        f('f_cur_rate', 'rate', t('finance', 'Rate'), 'decimal', { scale: 4, default: '1', min: 0, required: true, width: 110 }),
        f('f_cur_dec', 'decimals', t('finance', 'Decimals'), 'integer', { default: '2', min: 0, max: 12, width: 90 }),
      ],
      validations: [{ when: 'id = $const.base and rate <> 1', message: t('finance', 'The base currency’s rate is 1') }],
    },
    {
      key: 't_acc',
      name: 'Accounts',
      kind: 'catalog',
      title: t('finance', 'Accounts and debts'),
      itemTitle: t('finance', 'Account'),
      icon: 'wallet',
      orderable: true,
      description: t('finance', 'A card, cash, a deposit — and debts: a credit card, a loan. The balance comes from the operations and reconciliations.'),
      fields: [
        f('f_acc_name', 'name', t('finance', 'Name'), 'string', { required: true, width: 200 }),
        f('f_acc_kind', 'kind', t('finance', 'Kind'), 'enum', { enum: 'AccountKind', default: "'asset'", required: true, width: 90 }),
        f('f_acc_cur', 'currency', t('finance', 'Currency'), 'ref', { ref: 'Currencies', default: '$const.base', required: true, width: 80 }),
        f('f_acc_fee', 'fee', t('finance', 'Fee, %'), 'decimal', { scale: 2, default: '0', min: 0, max: 100, width: 80, description: t('finance', 'Lost when the money is turned into the base currency; a debt’s fee makes it larger') }),
        f('f_acc_open', 'opening', t('finance', 'Opening balance'), 'decimal', { scale: 2, scaleFrom: 'decimals', default: '0', list: false, description: t('finance', 'For a debt, what is owed') }),
        f('f_acc_opened', 'openedOn', t('finance', 'Opened on'), 'date', { default: 'today()', list: false }),
        f('f_acc_arch', 'archived', t('finance', 'Archived'), 'boolean', { list: false }),
        f('f_acc_dec', 'decimals', t('finance', 'Decimals'), 'integer', { computed: 'coalesce(currency.decimals, 2)', list: false }),
        f('f_acc_bal', 'balance', t('finance', 'Signed balance'), 'decimal', { scale: 2, scaleFrom: 'decimals', computed: "balance('Money', 'amount', 'account', id)", list: false }),
        f('f_acc_shown', 'shown', t('finance', 'Balance'), 'decimal', { scale: 2, scaleFrom: 'decimals', computed: "iif(kind = 'debt', -balance, balance)", width: 130 }),
        f('f_acc_value', 'value', t('finance', 'In the base currency'), 'decimal', { scale: 2, money: true, computed: "balance * coalesce(currency.rate, 1) * iif(kind = 'debt', 1 + fee / 100, 1 - fee / 100)", width: 150 }),
      ],
      posting: [{ key: 'po_acc_open', register: 'Money', from: 'header', direction: 'in', when: 'opening <> 0', date: 'openedOn', set: { account: 'id', currency: 'currency', amount: "iif(kind = 'debt', -opening, opening)" } }],
      validations: [{ when: 'archived and balance <> 0', message: t('finance', 'Money is left on an archived account: move it elsewhere first (a transfer, or an expense), or it goes unaccounted'), level: 'warning' }],
    },
    {
      key: 't_rec',
      name: 'Recurring',
      kind: 'catalog',
      title: t('finance', 'Recurring'),
      itemTitle: t('finance', 'Recurring operation'),
      icon: 'refresh',
      versioned: true,
      description: t('finance', 'The salary, the rent, subscriptions, a card’s monthly payment. A change takes effect from now: what happened before stays as it was.'),
      fields: [
        f('f_rec_name', 'name', t('finance', 'Name'), 'string', { required: true, width: 180 }),
        ...operationFields('f_rec'),
        f('f_rec_when', 'when', t('finance', 'When'), 'schedule', { required: true, default: "schedule('month', '09:00', 1)", width: 240 }),
        f('f_rec_next', 'next', t('finance', 'Next'), 'datetime', { computed: 'nextOccurrence(when, now())', width: 140 }),
        f('f_rec_month', 'monthly', t('finance', 'A month'), 'decimal', { scale: 2, money: true, computed: "iif(type = 'income', 1, iif(type = 'expense', -1, 0)) * amount * perMonth(when) * coalesce(account.currency.rate, currency.rate, 1)", width: 120 }),
      ],
      posting: moneyRules('schedule', 'po_rec'),
      validations: [{ when: "type = 'transfer' and isEmpty(toAccount)", message: t('finance', 'A transfer needs the account it goes to') }],
    },
    {
      key: 't_ops',
      name: 'Operations',
      kind: 'document',
      title: t('finance', 'One-off operations'),
      itemTitle: t('finance', 'Operation'),
      icon: 'receipt',
      numbering: { sequence: 'op', format: '{00000}' },
      description: t('finance', 'What the recurring ones do not cover: a purchase, a bonus, a holiday. One dated before the last reconciliation is a note: it changes nothing.'),
      fields: [
        ...operationFields('f_op').map((x) => (x.name === 'account' ? { ...x, default: "lastOf('Operations', 'account', '', '_createdAt')" } : x)),
        f('f_op_note', 'note', t('finance', 'Note'), 'string', { width: 220 }),
        f('f_op_base', 'inBase', t('finance', 'In the base currency'), 'decimal', { scale: 2, money: true, computed: 'amount * coalesce(account.currency.rate, currency.rate, 1)', list: false }),
      ],
      posting: moneyRules('header', 'po_op'),
      lockedWhen: "date <= maxOf('Reconciliations', 'date', 'posted')",
      lockedMessage: t('finance', 'The operation is dated before the last reconciliation: that money is already counted. It can be kept unposted, as a note.'),
      validations: [
        { when: "type = 'transfer' and isEmpty(toAccount)", message: t('finance', 'A transfer needs the account it goes to') },
        { when: "type = 'transfer' and toAccount = account", message: t('finance', 'A transfer goes to another account') },
      ],
    },
    {
      key: 't_recon',
      name: 'Reconciliations',
      kind: 'document',
      title: t('finance', 'Reconciliations'),
      itemTitle: t('finance', 'Reconciliation'),
      icon: 'check',
      numbering: { sequence: 'recon', format: '{0000}' },
      description: t('finance', 'The real balances now and then. What they differ from the expected by is the money that went unrecorded; the forecast starts from here.'),
      fields: [
        f('f_rc_prev', 'prevDate', t('finance', 'Previous'), 'datetime', { computed: "maxOf('Reconciliations', 'date', \"posted and date < $this.date\")", width: 140 }),
        f('f_rc_days', 'days', t('finance', 'Days'), 'decimal', { scale: 1, computed: 'iif(isEmpty(prevDate), null, date - prevDate)', width: 70 }),
        f('f_rc_un', 'unaccounted', t('finance', 'Unaccounted'), 'decimal', { scale: 2, money: true, computed: 'sum(lines.diffBase)', width: 130 }),
        f('f_rc_note', 'note', t('finance', 'Note'), 'string', { list: false }),
      ],
      parts: [
        {
          key: 'p_rc_lines',
          name: 'lines',
          title: t('finance', 'Balances'),
          fields: [
            f('f_rl_acc', 'account', t('finance', 'Account'), 'ref', { ref: 'Accounts', required: true, width: 180 }),
            f('f_rl_kind', 'kind', t('finance', 'Kind'), 'enum', { enum: 'AccountKind', default: 'account.kind', width: 80 }),
            f('f_rl_cur', 'currency', t('finance', 'Currency'), 'ref', { ref: 'Currencies', default: 'account.currency', width: 70 }),
            f('f_rl_dec', 'decimals', t('finance', 'Decimals'), 'integer', { computed: 'coalesce(currency.decimals, 2)', list: false }),
            f('f_rl_fee', 'fee', t('finance', 'Fee, %'), 'decimal', { scale: 2, default: 'account.fee', list: false }),
            f('f_rl_rate', 'rate', t('finance', 'Rate'), 'decimal', { scale: 4, default: 'currency.rate', width: 80 }),
            f('f_rl_exp', 'expected', t('finance', 'Expected'), 'decimal', { scale: 2, scaleFrom: 'decimals', width: 120, description: t('finance', 'What the records lead one to expect; a debt’s, what is owed') }),
            f('f_rl_act', 'actual', t('finance', 'Actual'), 'decimal', { scale: 2, scaleFrom: 'decimals', default: 'expected', width: 120 }),
            f('f_rl_diff', 'diff', t('finance', 'Difference'), 'decimal', { scale: 2, scaleFrom: 'decimals', computed: "iif(kind = 'debt', -(actual - expected), actual - expected)", width: 110 }),
            f('f_rl_base', 'diffBase', t('finance', 'In the base currency'), 'decimal', { scale: 2, money: true, computed: 'diff * rate', width: 130 }),
          ],
          fill: {
            from: 'Accounts',
            where: 'not archived',
            set: { account: 'id', kind: 'kind', currency: 'currency', fee: 'fee', rate: 'coalesce(currency.rate, 1)', expected: "iif(kind = 'debt', -1, 1) * balanceAt('Money', 'amount', doc.date, 'account', id)" },
          },
        },
      ],
      posting: [{ key: 'po_rc', register: 'Money', from: 'lines', direction: 'in', when: 'diff <> 0', set: { account: 'account', currency: 'currency', amount: 'diff' } }],
      lockedWhen: "date < maxOf('Reconciliations', 'date', 'posted')",
      lockedMessage: t('finance', 'A reconciliation before the last one is history: it stays as it was found.'),
    },
    {
      key: 't_goal',
      name: 'Goals',
      kind: 'catalog',
      title: t('finance', 'Goals'),
      itemTitle: t('finance', 'Goal'),
      icon: 'star',
      orderable: true,
      description: t('finance', 'Something to buy once the money allows: with money to spare, or when it is a small enough share. Each is measured on its own.'),
      fields: [
        f('f_g_name', 'name', t('finance', 'Name'), 'string', { required: true, width: 180 }),
        f('f_g_price', 'price', t('finance', 'Price'), 'decimal', { scale: 2, money: true, required: true, min: 0, width: 110 }),
        f('f_g_cur', 'currency', t('finance', 'Currency'), 'ref', { ref: 'Currencies', default: '$const.base', width: 70 }),
        f('f_g_rule', 'rule', t('finance', 'Affordable'), 'enum', { enum: 'GoalRule', default: "'margin'", list: false }),
        f('f_g_margin', 'margin', t('finance', 'Money to spare'), 'decimal', { scale: 2, money: true, default: '0', visible: "rule = 'margin'", list: false }),
        f('f_g_pct', 'percent', t('finance', 'At most, % of the money'), 'decimal', { scale: 1, default: '10', min: 0.1, max: 100, visible: "rule = 'share'", list: false }),
        f('f_g_done', 'done', t('finance', 'Bought on'), 'date', { list: false }),
        f('f_g_need', 'threshold', t('finance', 'Needs'), 'decimal', { scale: 2, money: true, computed: "iif(rule = 'share', price * coalesce(currency.rate, 1) / (coalesce(percent, 100) / 100), (price + coalesce(margin, 0)) * coalesce(currency.rate, 1))", width: 120 }),
        f('f_g_have', 'have', t('finance', 'Personal money'), 'decimal', { scale: 2, money: true, computed: "sumOf('Money', 'worth')", list: false }),
        f('f_g_prog', 'progress', t('finance', 'Progress'), 'decimal', { scale: 0, display: 'progress', computed: 'iif(threshold > 0, min(100, max(0, have / threshold * 100)), 100)', width: 150 }),
        f('f_g_when', 'affordable', t('finance', 'Affordable on'), 'date', { computed: "iif(not isEmpty(done), null, iif(have >= threshold, today(), reach('Horizon', 'personal', '>=', threshold)))", width: 120 }),
      ],
    },
    {
      key: 't_money',
      name: 'Money',
      kind: 'register',
      title: t('finance', 'Money movements'),
      icon: 'money',
      registerKind: 'balance',
      description: t('finance', 'Every movement of money: stored ones, and the planned ones of the recurring operations up to now.'),
      fields: [
        f('f_m_acc', 'account', t('finance', 'Account'), 'ref', { ref: 'Accounts', role: 'dimension', width: 180 }),
        f('f_m_cur', 'currency', t('finance', 'Currency'), 'ref', { ref: 'Currencies', role: 'dimension', width: 80 }),
        f('f_m_amount', 'amount', t('finance', 'Amount'), 'decimal', { scale: 2, role: 'resource', width: 120 }),
        f('f_m_worth', 'worth', t('finance', 'In the base currency'), 'decimal', { scale: 2, money: true, computed: WORTH, width: 140 }),
      ],
    },
  ];
  c.forms = [
    {
      key: 'fo_op',
      name: 'QuickOperation',
      table: 'Operations',
      title: t('finance', 'Operation'),
      modal: true,
      width: 560,
      height: 560,
      focus: 'amount',
      enterSaves: true,
      layout: {
        type: 'group',
        key: 'fo_op_root',
        children: [
          { type: 'field', key: 'fo_op_type', field: 'type' },
          { type: 'field', key: 'fo_op_amount', field: 'amount' },
          { type: 'field', key: 'fo_op_acc', field: 'account' },
          { type: 'field', key: 'fo_op_cur', field: 'currency' },
          { type: 'field', key: 'fo_op_to', field: 'toAccount' },
          { type: 'field', key: 'fo_op_amountTo', field: 'amountTo' },
          { type: 'field', key: 'fo_op_date', field: 'date' },
          { type: 'field', key: 'fo_op_note', field: 'note' },
        ],
      },
    },
  ];
  const sum = 'sum' as const;
  c.views = [
    {
      key: 'v_acc',
      name: 'AccountsList',
      table: 'Accounts',
      title: t('finance', 'Accounts and debts'),
      icon: 'wallet',
      description: t('finance', 'By kind and currency: the balance as you see it (a debt’s, what is owed) and what it is worth in the base currency. Alt+↑/↓ to reorder.'),
      columns: [{ field: 'name' }, { field: 'kind' }, { field: 'currency' }, { field: 'shown', total: sum }, { field: 'fee' }, { field: 'value', total: sum }],
      where: 'not archived',
      group: ['kind', 'currency'],
      sort: [{ field: '_order' }],
      rules: [{ key: 'r_debt', when: "kind = 'debt'", field: 'shown', color: '#c93535', description: t('finance', 'Owed') }],
    },
    {
      key: 'v_rec',
      name: 'RecurringList',
      table: 'Recurring',
      title: t('finance', 'Recurring'),
      icon: 'refresh',
      columns: [{ field: 'name' }, { field: 'type' }, { field: 'amount' }, { field: 'account' }, { field: 'when' }, { field: 'next' }, { field: 'monthly', total: sum }],
      sort: [{ field: 'next' }],
      rules: [{ key: 'r_rec_in', when: "type = 'income'", field: 'monthly', color: '#1f8a4c' }],
    },
    {
      key: 'v_ops',
      name: 'OperationsList',
      table: 'Operations',
      title: t('finance', 'One-off operations'),
      icon: 'receipt',
      form: 'QuickOperation',
      columns: [{ field: 'date' }, { field: 'posted' }, { field: 'type' }, { field: 'amount' }, { field: 'account' }, { field: 'toAccount' }, { field: 'note' }, { field: 'inBase', total: sum }],
      sort: [{ field: 'date', desc: true }],
      rules: [
        { key: 'r_op_note', when: 'not posted', color: '#7b8394', description: t('finance', 'A note: not counted') },
        { key: 'r_op_in', when: "type = 'income'", field: 'amount', color: '#1f8a4c' },
      ],
    },
    {
      key: 'v_recon',
      name: 'ReconciliationsList',
      table: 'Reconciliations',
      title: t('finance', 'Reconciliations'),
      icon: 'check',
      columns: [{ field: 'date' }, { field: 'prevDate' }, { field: 'days' }, { field: 'unaccounted', total: sum }, { field: 'note' }],
      sort: [{ field: 'date', desc: true }],
      rules: [{ key: 'r_rc_minus', when: 'unaccounted < 0', field: 'unaccounted', color: '#c93535', description: t('finance', 'Spent without a record') }],
      details: [
        { key: 'd_rc_lines', kind: 'part', part: 'lines', title: t('finance', 'Balances') },
        { key: 'd_rc_ops', kind: 'view', table: 'Operations', title: t('finance', 'Operations of the interval'), where: 'date > coalesce($master.prevDate, \'1900-01-01\') and date <= $master.date' },
        { key: 'd_rc_moves', kind: 'movements', table: 'Money', title: t('finance', 'Its movements') },
      ],
    },
    {
      key: 'v_goal',
      name: 'GoalsList',
      table: 'Goals',
      title: t('finance', 'Goals'),
      icon: 'star',
      columns: [{ field: 'name' }, { field: 'price' }, { field: 'currency' }, { field: 'threshold' }, { field: 'progress' }, { field: 'affordable' }],
      where: 'isEmpty(done)',
      sort: [{ field: '_order' }],
      actions: ['Bought'],
    },
    {
      key: 'v_goal_brief',
      name: 'GoalsBrief',
      table: 'Goals',
      title: t('finance', 'Goals'),
      icon: 'star',
      // For the overview: how far along, and when.
      columns: [{ field: 'name' }, { field: 'progress', width: 130 }, { field: 'affordable', width: 110 }],
      where: 'isEmpty(done)',
      sort: [{ field: '_order' }],
      details: [],
    },
  ];
  c.actions = [
    { key: 'a_new', name: 'NewOperation', title: t('finance', 'New operation'), icon: 'plus', hotkey: 'N', steps: [{ type: 'create', table: 'Operations', values: {}, open: true }] },
    { key: 'a_recon', name: 'Reconcile', title: t('finance', 'Reconcile'), icon: 'check', hotkey: 'R', steps: [{ type: 'create', table: 'Reconciliations', values: {}, open: true }] },
    {
      key: 'a_bought',
      name: 'Bought',
      title: t('finance', 'Bought'),
      icon: 'cart',
      table: 'Goals',
      where: ['list', 'card'],
      enabled: 'isEmpty(done)',
      steps: [
        { type: 'confirm', text: t('finance', 'Mark it as bought and write down the expense?') },
        { type: 'update', target: 'current', values: { done: 'today()' } },
        { type: 'create', table: 'Operations', values: { type: "'expense'", amount: 'price', account: 'null', currency: 'currency', note: 'name' }, open: true },
      ],
    },
    {
      key: 'a_plan',
      name: 'PlanUnaccounted',
      title: t('finance', 'Plan it as a daily expense'),
      icon: 'refresh',
      enabled: '$widget.value < 0',
      steps: [
        {
          type: 'create',
          table: 'Recurring',
          values: { name: q(t('finance', 'Unrecorded spending')), type: "'expense'", amount: 'round(-$widget.value, 2)', account: 'null', currency: '$const.base', when: "schedule('day', '21:00')" },
          open: true,
        },
      ],
    },
  ];
  c.triggers = [
    {
      key: 'tr_post',
      table: 'Operations',
      event: 'beforeSave',
      description: t('finance', 'An operation counts unless it is dated before the last reconciliation: then it is a note'),
      steps: [{ type: 'update', target: 'current', values: { posted: "date > coalesce(maxOf('Reconciliations', 'date', 'posted'), '1900-01-01')" } }],
    },
    {
      key: 'tr_last',
      table: 'Reconciliations',
      event: 'beforeDelete',
      description: t('finance', 'Only the last reconciliation can be deleted'),
      steps: [{ type: 'if', when: "posted and date < maxOf('Reconciliations', 'date', 'posted')", steps: [{ type: 'stop', text: t('finance', 'Only the last reconciliation can be deleted: the ones before it are history') }] }],
    },
  ];
  const forecast = (key: string, name: string, title: string, period: string, chart: boolean): Config['reports'][number] => ({
    key,
    name,
    title,
    icon: 'line',
    source: 'Money',
    mode: 'series',
    bucket: 'day',
    params: [{ name: 'period', type: 'period', title: t('finance', 'Period'), default: period }],
    groupBy: [],
    measures: [
      { name: 'personal', fn: 'sum', field: 'worth', title: t('finance', 'Personal money') },
      { name: 'assets', fn: 'sum', field: 'worth', where: ASSETS, title: t('finance', 'On the accounts') },
    ],
    ...(chart
      ? {
          chart: {
            type: 'line' as const,
            x: 'date:day',
            series: ['personal', 'assets'],
            title,
            refLines: [{ value: '0' }, { from: 'Goals', value: 'threshold', title: 'name', where: 'isEmpty(done)' }],
          },
        }
      : {}),
  });
  c.reports = [
    forecast('rp_fc', 'Forecast', t('finance', 'Forecast'), 'next:3m', true),
    // The whole horizon, for "the money lasts until" and the goals' dates.
    forecast('rp_hz', 'Horizon', t('finance', 'Forecast to the horizon'), "='next:' & coalesce($const.horizonYears, 5) & 'y'", true),
    {
      key: 'rp_un',
      name: 'Unaccounted',
      title: t('finance', 'Unaccounted money'),
      icon: 'warning',
      description: t('finance', 'What the reconciliations found unrecorded, by month and currency: minus is spending, plus is income.'),
      source: 'Reconciliations.lines',
      where: 'doc.posted',
      dateField: 'doc.date',
      params: [{ name: 'period', type: 'period', title: t('finance', 'Period'), default: 'year' }],
      groupBy: ['doc.date:month', 'currency'],
      measures: [
        { name: 'diff', fn: 'sum', field: 'diff', title: t('finance', 'In the currency') },
        { name: 'diffBase', fn: 'sum', field: 'diffBase', title: t('finance', 'In the base currency') },
      ],
      sort: [{ field: 'doc.date:month' }],
      chart: { type: 'bar', x: 'doc.date:month', series: ['diffBase'], title: t('finance', 'Unaccounted money by month') },
    },
    {
      key: 'rp_ops',
      name: 'OperationsByMonth',
      title: t('finance', 'One-off operations by month'),
      icon: 'chart',
      source: 'Operations',
      where: 'posted',
      params: [{ name: 'period', type: 'period', title: t('finance', 'Period'), default: 'year' }],
      groupBy: ['date:month', 'type'],
      measures: [{ name: 'total', fn: 'sum', field: 'inBase', title: t('finance', 'In the base currency') }],
      sort: [{ field: 'date:month' }],
      chart: { type: 'stacked', x: 'date:month', series: ['total'], title: t('finance', 'One-off operations by month') },
    },
  ];
  const lasts = "reach('Horizon', 'assets', '<=', 0)";
  const below = "reach('Horizon', 'personal', '<', 0)";
  c.dashboards = [
    {
      key: 'd_home',
      name: 'Overview',
      title: t('finance', 'Overview'),
      widgets: [
        {
          key: 'w_personal',
          type: 'kpi',
          size: 'hero',
          title: t('finance', 'Personal money'),
          x: 0,
          y: 0,
          w: 5,
          h: 2,
          value: "sumOf('Money', 'worth')",
          format: 'money',
          text: `${t('finance', 'On the accounts')} {{sumOf('Money', 'worth', "${ASSETS}") | money}} · ${t('finance', 'debts')} {{-sumOf('Money', 'worth', "account.kind = 'debt'") | money}}`,
          actions: ['Reconcile', 'NewOperation'],
        },
        {
          key: 'w_lasts',
          type: 'kpi',
          title: t('finance', 'The money lasts until'),
          x: 5,
          y: 0,
          w: 4,
          h: 2,
          value: lasts,
          format: 'date',
          text: `{{#if isEmpty(${lasts})}}${t('finance', 'Longer than the horizon: {years} years', { years: '{{coalesce($const.horizonYears, 5)}}' })}{{else}}${t('finance', 'when the accounts are empty')}{{/if}}{{#if not isEmpty(${below}) and (isEmpty(${lasts}) or ${below} < ${lasts})}}\n${t('finance', 'Personal money goes below zero on {date}', { date: `{{${below} | date}}` })}{{/if}}`,
        },
        {
          key: 'w_pace',
          type: 'kpi',
          title: t('finance', 'Unaccounted a day'),
          x: 9,
          y: 0,
          w: 3,
          h: 2,
          value: PACE,
          format: 'money',
          text: t('finance', 'Learnt from the reconciliations of the last {days} days', { days: '{{coalesce($const.windowDays, 90)}}' }),
          actions: ['PlanUnaccounted'],
        },
        { key: 'w_chart', type: 'chart', title: t('finance', 'Forecast'), x: 0, y: 2, w: 8, h: 4, report: 'Forecast' },
        { key: 'w_goals', type: 'list', title: t('finance', 'Goals'), x: 8, y: 2, w: 4, h: 4, view: 'GoalsBrief' },
        {
          key: 'w_last',
          type: 'text',
          title: t('finance', 'Reconciliation'),
          x: 0,
          y: 6,
          w: 12,
          h: 1,
          text: `{{#if isEmpty(maxOf('Reconciliations', 'date', 'posted'))}}${t('finance', 'No reconciliation yet: press R and type in the real balances — the forecast starts there.')}{{else}}${t('finance', 'Last reconciled on {date}; it found {amount} unaccounted. Press R to reconcile again.', { date: "{{maxOf('Reconciliations', 'date', 'posted') | date}}", amount: "{{lastOf('Reconciliations', 'unaccounted', 'posted') | money}}" })}{{/if}}`,
        },
      ],
    },
  ];
  c.menu = [
    {
      key: 'm_main',
      title: t('finance', 'Money'),
      children: [
        { key: 'm_over', title: t('finance', 'Overview'), icon: 'dashboard', target: { kind: 'dashboard', name: 'Overview' } },
        { key: 'm_acc', title: t('finance', 'Accounts and debts'), icon: 'wallet', target: { kind: 'view', name: 'AccountsList' } },
        { key: 'm_rec', title: t('finance', 'Recurring'), icon: 'refresh', target: { kind: 'view', name: 'RecurringList' } },
        { key: 'm_ops', title: t('finance', 'One-off operations'), icon: 'receipt', target: { kind: 'view', name: 'OperationsList' } },
        { key: 'm_recon', title: t('finance', 'Reconciliations'), icon: 'check', target: { kind: 'view', name: 'ReconciliationsList' } },
        { key: 'm_goals', title: t('finance', 'Goals'), icon: 'star', target: { kind: 'view', name: 'GoalsList' } },
      ],
    },
    {
      key: 'm_rep',
      title: t('finance', 'Reports'),
      children: [
        { key: 'm_fc', title: t('finance', 'Forecast'), icon: 'line', target: { kind: 'report', name: 'Forecast' } },
        { key: 'm_hz', title: t('finance', 'Forecast to the horizon'), icon: 'line', target: { kind: 'report', name: 'Horizon' } },
        { key: 'm_un', title: t('finance', 'Unaccounted money'), icon: 'warning', target: { kind: 'report', name: 'Unaccounted' } },
        { key: 'm_opm', title: t('finance', 'One-off operations by month'), icon: 'chart', target: { kind: 'report', name: 'OperationsByMonth' } },
        { key: 'm_moves', title: t('finance', 'Money movements'), icon: 'list', target: { kind: 'table', name: 'Money' } },
      ],
    },
    {
      key: 'm_set',
      title: t('finance', 'Settings'),
      children: [
        { key: 'm_cur', title: t('finance', 'Currencies'), icon: 'rates', target: { kind: 'table', name: 'Currencies' } },
        { key: 'm_const', title: t('finance', 'Settings of the application'), icon: 'settings', target: { kind: 'table', name: '_constants' } },
      ],
    },
  ];
  return c;
}

/**
 * Four months of a life: a salary, rent, groceries, a credit card paid off
 * monthly; one-off operations now and then, a reconciliation every month that
 * finds a little unrecorded spending; three goals.
 */
export async function seedFinance(data: DataService, progress: (text: string) => void): Promise<void> {
  const save = (table: string, row: Record<string, unknown>) => data.save(data.table(table), { id: '', ...row }, null);
  const now = new Date();
  const day = (offset: number, hour = 12, minute = 0) => isoDateTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, hour, minute));
  const date = (offset: number) => isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
  progress(t('finance', 'Currencies and accounts…'));
  const uah = await save('Currencies', { code: 'UAH', rate: 1, decimals: 2 });
  const usd = await save('Currencies', { code: 'USD', rate: 41.5, decimals: 2 });
  await save('Currencies', { code: 'EUR', rate: 45.2, decimals: 2 });
  await data.save(data.table('_constants'), { id: 'constants', base: uah.id, horizonYears: 5, windowDays: 90 }, null);
  const start = 125;
  const card = await save('Accounts', { name: t('finance', 'Salary card'), kind: 'asset', currency: uah.id, fee: 0, opening: 28000, openedOn: date(start) });
  const cash = await save('Accounts', { name: t('finance', 'Cash'), kind: 'asset', currency: uah.id, fee: 0, opening: 4000, openedOn: date(start) });
  const dollars = await save('Accounts', { name: t('finance', 'Savings in dollars'), kind: 'asset', currency: usd.id, fee: 1, opening: 1000, openedOn: date(start) });
  const credit = await save('Accounts', { name: t('finance', 'Credit card'), kind: 'debt', currency: uah.id, fee: 0, opening: 12000, openedOn: date(start) });
  await save('Accounts', { name: t('finance', 'Borrowed from a friend'), kind: 'debt', currency: usd.id, fee: 2, opening: 200, openedOn: date(start) });

  progress(t('finance', 'Recurring operations…'));
  const from = day(start, 8);
  const recurring: Record<string, unknown>[] = [
    { name: t('finance', 'Salary'), type: 'income', account: card.id, amount: 52000, when: { every: 'month', day: 10, time: '10:00' } },
    { name: t('finance', 'Rent'), type: 'expense', account: card.id, amount: 16000, when: { every: 'month', day: 'last', time: '18:00' } },
    { name: t('finance', 'Groceries'), type: 'expense', account: card.id, amount: 520, when: { every: 'day', time: '19:00' } },
    { name: t('finance', 'Phone and internet'), type: 'expense', account: card.id, amount: 450, when: { every: 'month', day: 5, time: '09:00' } },
    { name: t('finance', 'Credit card payment'), type: 'transfer', account: card.id, toAccount: credit.id, amount: 3000, when: { every: 'month', day: 20, time: '09:00' } },
    { name: t('finance', 'Into savings'), type: 'transfer', account: card.id, toAccount: dollars.id, amount: 4150, amountTo: 100, when: { every: 'month', day: 12, time: '12:00' } },
    { name: t('finance', 'Car insurance'), type: 'expense', account: card.id, amount: 9500, when: { every: 'year', month: ((now.getMonth() + 3) % 12) + 1, day: 1, time: '09:00' } },
  ];
  for (const r of recurring) await save('Recurring', { ...r, validFrom: from });

  progress(t('finance', 'Operations and reconciliations…'));
  // Each month: a few one-off operations, then a reconciliation that finds a little spent without a record.
  const oneOffs: [number, Record<string, unknown>][] = [
    [118, { type: 'expense', account: cash.id, amount: 1200, note: t('finance', 'A present') }],
    [104, { type: 'income', account: card.id, amount: 6500, note: t('finance', 'A bonus') }],
    [92, { type: 'transfer', account: card.id, toAccount: cash.id, amount: 3000, note: t('finance', 'Cash from an ATM') }],
    [80, { type: 'expense', account: card.id, amount: 7800, note: t('finance', 'Winter boots') }],
    [61, { type: 'expense', account: cash.id, amount: 900, note: t('finance', 'A haircut and a book') }],
    [45, { type: 'expense', account: card.id, amount: 4300, note: t('finance', 'A weekend away') }],
    [33, { type: 'transfer', account: card.id, toAccount: cash.id, amount: 2000, note: t('finance', 'Cash from an ATM') }],
    [18, { type: 'expense', account: credit.id, amount: 2600, note: t('finance', 'A coffee machine') }],
    [9, { type: 'income', account: cash.id, amount: 1500, note: t('finance', 'Sold an old bike') }],
  ];
  const reconciliations: [number, number][] = [
    [100, -850],
    [70, -1300],
    [40, -600],
    [12, -1100],
  ];
  let next = 0;
  for (const [offset, missing] of reconciliations) {
    while (next < oneOffs.length && oneOffs[next]![0] > offset) {
      const [o, op] = oneOffs[next++]!;
      await save('Operations', { ...op, date: day(o, 13, 30), posted: true });
    }
    const recon = await data.newRecord(data.table('Reconciliations'), { date: day(offset, 21) });
    // Cash is where the unrecorded spending happens.
    const lines = (recon.lines as Row[]).map((l) => (l.account === cash.id ? { ...l, actual: Math.round(((l.expected as number) + missing) * 100) / 100 } : l));
    await data.save(data.table('Reconciliations'), { ...recon, lines, posted: true }, null);
  }
  while (next < oneOffs.length) {
    const [o, op] = oneOffs[next++]!;
    await save('Operations', { ...op, date: day(o, 13, 30), posted: true });
  }

  progress(t('finance', 'Goals…'));
  await save('Goals', { name: t('finance', 'A new bike'), price: 35000, currency: uah.id, rule: 'margin', margin: 20000 });
  await save('Goals', { name: t('finance', 'A laptop'), price: 1500, currency: usd.id, rule: 'share', percent: 40 });
  await save('Goals', { name: t('finance', 'A holiday by the sea'), price: 90000, currency: uah.id, rule: 'margin', margin: 30000 });
}
