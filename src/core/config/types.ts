/**
 * The configuration: everything that describes an application built in the
 * studio (Task.md 2, 6). It is one JSON document; the data lives elsewhere, in
 * the data sources.
 *
 * Every object that can be renamed carries a `key` that never changes: renames
 * are told apart from drop-and-create by it (core/config/diff.ts), and links
 * between objects that must survive a rename (form elements, menu items) use it.
 * `name` is the identifier people see and expressions use.
 */
import type { Filter, OrderBy, AggregateFn } from '../query/types';

export const FORMAT_VERSION = 1;

export type FieldType =
  | 'string'
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'enum'
  | 'ref'
  | 'file'
  | 'image'
  | 'color'
  | 'email'
  | 'phone'
  | 'url'
  | 'json'
  /** When something recurring happens: core/schedule.ts. */
  | 'schedule';

export interface EnumValue {
  value: string;
  title: string;
  color?: string;
}

export interface FieldDef {
  key: string;
  name: string;
  title?: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  unique?: boolean;
  /** An expression evaluated for a new record. */
  default?: string;
  /** An expression; the field is read-only and, unless `stored`, never written to the source. */
  computed?: string;
  stored?: boolean;
  /** true, or an expression: read-only when it is true. */
  readonly?: boolean | string;
  /** An expression: shown on forms only when true. */
  visible?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  /** decimal: digits after the point. */
  scale?: number;
  money?: boolean;
  /** enum: the name of a configuration enum, or `options` inline. */
  enum?: string;
  options?: EnumValue[];
  /** ref: the name of the referenced table. */
  ref?: string;
  /** Registers: what the field is for. */
  role?: 'dimension' | 'resource' | 'attribute';
  /** A number 0–100 shown as a bar: how far along. */
  display?: 'progress';
  /** List column width in pixels. */
  width?: number;
  /** Shown in lists by default. */
  list?: boolean;
  multiline?: boolean;
  /**
   * decimal: the name of a field of the same record holding the number of
   * digits after the point (often a computed one, `currency.decimals`): an
   * amount in a currency of its own precision. `scale` is the fallback.
   */
  scaleFrom?: string;
}

export interface PartDef {
  key: string;
  name: string;
  title?: string;
  fields: FieldDef[];
  /**
   * The lines a new record starts with: one per row of `from` that `where`
   * lets through, its fields from `set` — expressions over that row, with
   * `doc.x` for the record being filled. Every account for a reconciliation,
   * every product for a stocktaking. The `fill` step fills them again.
   */
  fill?: PartFill;
}

export interface PartFill {
  from: string;
  where?: string;
  sort?: OrderBy[];
  set: Record<string, string>;
}

export type TableKind = 'catalog' | 'document' | 'register' | 'table';

export interface PostingRule {
  key: string;
  register: string;
  /**
   * 'header' — one movement per record; a part's name — one per line;
   * 'schedule' — one per time the record's `schedule` field comes round:
   * planned movements, never stored, made when a balance or a report asks.
   */
  from: string;
  /** For `from: 'schedule'`: the schedule field. */
  schedule?: string;
  direction: 'in' | 'out';
  /** An expression over the line (or header): the rule makes a movement only where it is true. */
  when?: string;
  /** An expression: the movement's date. The record's `date` by default, else when it was created. */
  date?: string;
  /** Register field → expression over the line (or header); `doc.x` is the document's field. */
  set: Record<string, string>;
}

export interface Validation {
  /** An expression that is true when the record is WRONG. */
  when: string;
  message: string;
  /** A warning is shown, but the record is saved all the same. */
  level?: 'error' | 'warning';
}

export interface TableDef {
  key: string;
  name: string;
  kind: TableKind;
  title: string;
  itemTitle?: string;
  icon?: string;
  description?: string;
  /** Connection id; the first connection when left out. */
  connection?: string;
  /** The field shown when a record is referenced; 'name', or the first string field. */
  display?: string;
  hierarchical?: boolean;
  fields: FieldDef[];
  parts?: PartDef[];
  numbering?: { sequence: string; format: string };
  /** Movements into registers: of a posted document, or of every record of a catalog or a table. */
  posting?: PostingRule[];
  /**
   * An expression: the record is in a closed period while it is true. Then it
   * cannot be posted, and a record posted there cannot be changed, unposted or
   * deleted; one that is not posted can still be kept, as a note.
   */
  lockedWhen?: string;
  /** What the person is told about a closed period; a general text when left out. */
  lockedMessage?: string;
  registerKind?: 'balance' | 'turnover';
  /** Register resources that may not go below zero. */
  denyNegative?: string[];
  validations?: Validation[];
  history?: boolean;
  /** The records keep an order the person sets (`_order`), and lists show them in it. */
  orderable?: boolean;
  /**
   * A change does not rewrite a record: it closes the version in force
   * (`validTo` = now) and opens the next from now (`validFrom`), the versions
   * sharing `seriesId`. A delete only closes it. What was planned by a version
   * stays as it was: editing a recurring payment does not change the past.
   */
  versioned?: boolean;
  /** An external source's own key field, when it is not 'id'. */
  sourceKey?: string;
  readOnly?: boolean;
}

export interface EnumDef {
  key: string;
  name: string;
  title?: string;
  values: EnumValue[];
}

export interface ColumnDef {
  /** A field name or a path through references: 'product.category.name'. */
  field: string;
  title?: string;
  width?: number;
  total?: AggregateFn;
  hidden?: boolean;
}

export interface FormatRule {
  key: string;
  /** An expression over the row; the rule applies when it is true. */
  when: string;
  /** The column it colours; the whole row when left out. */
  field?: string;
  background?: string;
  color?: string;
  bold?: boolean;
  active?: boolean;
  description?: string;
}

export interface DetailDef {
  key: string;
  title?: string;
  /**
   * 'backref': rows of `table` whose `field` references the selected record;
   * 'part': a document's part; 'movements': register rows recorded by it;
   * 'view': rows of `table` for which `where` holds — an expression over them,
   * with `$master.x` for the selected record.
   */
  kind: 'backref' | 'part' | 'movements' | 'view' | 'versions';
  table?: string;
  field?: string;
  part?: string;
  view?: string;
  where?: string;
}

export interface ViewDef {
  key: string;
  name: string;
  table: string;
  title: string;
  icon?: string;
  description?: string;
  columns: ColumnDef[];
  filter?: Filter;
  /** An expression filter on top of `filter`, may use $params. */
  where?: string;
  sort?: OrderBy[];
  group?: string[];
  rules?: FormatRule[];
  /** Action names shown on the toolbar. */
  actions?: string[];
  /** Detail tabs below the list; all back-references when left out. */
  details?: DetailDef[];
  editable?: boolean;
  /** The form a record opens in. */
  form?: string;
}

export type FormNode =
  | { type: 'group'; key: string; title?: string; children: FormNode[]; collapsed?: boolean }
  | { type: 'columns'; key: string; children: FormNode[] }
  | { type: 'tabs'; key: string; children: FormNode[] }
  | { type: 'tab'; key: string; title: string; children: FormNode[] }
  | { type: 'field'; key: string; field: string; title?: string; span?: number; label?: 'left' | 'top' | 'none' }
  | { type: 'part'; key: string; part: string; title?: string }
  | { type: 'related'; key: string; table: string; field: string; title?: string }
  | { type: 'button'; key: string; action: string; title?: string }
  | { type: 'link'; key: string; action: string; title?: string }
  | { type: 'text'; key: string; text: string }
  | { type: 'spacer'; key: string };

export interface FormDef {
  key: string;
  name: string;
  table: string;
  title?: string;
  width?: number;
  height?: number;
  modal?: boolean;
  /** The field the cursor is put in when a new record opens. */
  focus?: string;
  /** Enter moves to the next field, and in the last one saves and closes: a form for quick entry. */
  enterSaves?: boolean;
  layout: FormNode;
}

export type MenuTarget =
  | { kind: 'view'; name: string }
  | { kind: 'table'; name: string }
  | { kind: 'report'; name: string }
  | { kind: 'dashboard'; name: string }
  | { kind: 'action'; name: string };

export interface MenuNode {
  key: string;
  title: string;
  icon?: string;
  children?: MenuNode[];
  target?: MenuTarget;
  hidden?: boolean;
  /** A keyboard shortcut that opens the target: 'R', 'Shift+N', 'Ctrl+Alt+R'. */
  hotkey?: string;
}

export type Step =
  | { type: 'ask'; title?: string; fields: FieldDef[] }
  | { type: 'confirm'; text: string }
  | { type: 'create'; table: string; values: Record<string, string>; open?: boolean }
  | { type: 'update'; target: 'current' | 'selected'; values: Record<string, string> }
  | { type: 'delete'; target: 'current' | 'selected' }
  | { type: 'open'; target: MenuTarget; filter?: string }
  | { type: 'post'; target: 'current' | 'selected' }
  /** Fills a part of the current record again from its `fill`. */
  | { type: 'fill'; part: string }
  | { type: 'unpost'; target: 'current' | 'selected' }
  | { type: 'print'; template: string }
  | { type: 'plugin'; plugin: string; action: string; args: Record<string, string> }
  | { type: 'message'; text: string }
  /** Ends the action; in a beforeSave trigger the record is not saved and `text` says why. */
  | { type: 'stop'; text: string }
  | { type: 'if'; when: string; steps: Step[]; else?: Step[] };

export interface ActionDef {
  key: string;
  name: string;
  title: string;
  icon?: string;
  /** The table whose records it works on; any when left out. */
  table?: string;
  steps: Step[];
  where?: ('list' | 'card' | 'detail')[];
  multi?: boolean;
  /** An expression: the action is disabled when false. */
  enabled?: string;
  /** A keyboard shortcut: 'R', 'Shift+N', 'Ctrl+Alt+R'; in a list or card of its table, or anywhere for an action of no table. */
  hotkey?: string;
}

export type TriggerEvent = 'beforeSave' | 'afterSave' | 'beforeDelete' | 'afterDelete' | 'onFieldChange' | 'onFormOpen';

export interface TriggerDef {
  key: string;
  table: string;
  event: TriggerEvent;
  field?: string;
  steps: Step[];
  description?: string;
  active?: boolean;
}

export interface ReportParam {
  name: string;
  title?: string;
  type: 'period' | FieldType;
  ref?: string;
  default?: string;
}

export interface ReportDef {
  key: string;
  name: string;
  title: string;
  icon?: string;
  description?: string;
  /** A table or a register. */
  source: string;
  /**
   * Computed by a plugin instead (Task_next.md H): its report, given the
   * parameters, reads the application's data and gives back the rows.
   */
  plugin?: { plugin: string; report: string };
  /**
   * Registers: balances at the end of the period, movements in it, or the
   * balance at the end of each day, week or month of it ('series': a
   * forecast when the period lies ahead, the planned movements in it).
   */
  mode?: 'rows' | 'balance' | 'turnover' | 'series';
  /** For a series: the step. */
  bucket?: 'day' | 'week' | 'month';
  params?: ReportParam[];
  /** An expression filter, may use $params. */
  where?: string;
  /** The date field the period applies to. */
  dateField?: string;
  groupBy: string[];
  /**
   * `field`, or `expr` — an expression over each source row (what a movement
   * is worth in the base currency); `where` — only the rows it holds for.
   */
  measures: { name: string; fn: AggregateFn; field?: string; expr?: string; where?: string; title?: string }[];
  /** Columns worked out from a grouped row: expressions over its groups and measures. */
  columns?: { name: string; title?: string; expr: string; scale?: number }[];
  sort?: OrderBy[];
  chart?: { type: ChartType; x: string; series: string[]; title?: string; refLines?: RefLine[] };
}

/**
 * A level drawn across a chart: a value (an expression), or one per row of a
 * table — each goal's price — with `value` and `title` expressions over it.
 */
export interface RefLine {
  value: string;
  title?: string;
  from?: string;
  where?: string;
}

export type ChartType = 'bar' | 'hbar' | 'stacked' | 'line' | 'area' | 'pie' | 'donut';

export interface WidgetDef {
  key: string;
  type: 'kpi' | 'chart' | 'list' | 'text';
  title?: string;
  /** Grid placement: 12 columns. */
  x: number;
  y: number;
  w: number;
  h: number;
  report?: string;
  view?: string;
  /** kpi: an aggregate over a table… */
  table?: string;
  fn?: AggregateFn;
  field?: string;
  where?: string;
  /** …or an expression: sumOf('Accounts', 'value'), reach('Forecast', 'assets', '<=', 0). */
  value?: string;
  /** kpi: how the value is shown. */
  format?: 'money' | 'number' | 'integer' | 'percent' | 'date' | 'datetime';
  /** kpi: a hero is the one big number of the page. */
  size?: 'normal' | 'hero';
  /**
   * text, and the line under a kpi: plain text with `{{expression}}`,
   * `{{expression | money}}` and `{{#if expression}}…{{else}}…{{/if}}`.
   */
  text?: string;
  /** Actions offered under the widget; `$widget.value` is a kpi's value. */
  actions?: string[];
}

export interface DashboardDef {
  key: string;
  name: string;
  title: string;
  widgets: WidgetDef[];
}

export interface PrintTemplateDef {
  key: string;
  name: string;
  title: string;
  table: string;
  html: string;
}

export interface ConnectionDef {
  id: string;
  title?: string;
  plugin: string;
  /** The data source inside the plugin (a plugin may contribute several). */
  source: string;
  settings: Record<string, unknown>;
}

export interface Config {
  formatVersion: number;
  rev?: string;
  app: { name: string; currency?: string; icon?: string; home?: string };
  /** Fields of the one record of settings the whole application shares: `$const.name` in expressions. */
  constants?: FieldDef[];
  connections: ConnectionDef[];
  enums: EnumDef[];
  tables: TableDef[];
  views: ViewDef[];
  forms: FormDef[];
  menu: MenuNode[];
  actions: ActionDef[];
  triggers: TriggerDef[];
  reports: ReportDef[];
  dashboards: DashboardDef[];
  printTemplates: PrintTemplateDef[];
  /** ER diagram node positions, by table key. */
  diagram?: Record<string, { x: number; y: number }>;
}

export function emptyConfig(name = 'New application'): Config {
  return {
    formatVersion: FORMAT_VERSION,
    app: { name },
    connections: [{ id: 'main', title: 'Main', plugin: 'local', source: 'local', settings: {} }],
    enums: [],
    tables: [],
    views: [],
    forms: [],
    menu: [],
    actions: [],
    triggers: [],
    reports: [],
    dashboards: [],
    printTemplates: [],
  };
}
