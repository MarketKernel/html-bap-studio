/**
 * The report designer (Task.md 11.1): the source and filter of a report on
 * the right; its groupings, measures, sort and chart in the middle; and under
 * them a live preview — the report run on the real data for its default
 * period, with the chart and the first rows — rebuilt after every change.
 */
import { t, tn } from '../../core/i18n';
import { formatValue } from '../../core/format';
import { allFields, IDENT, isNumeric, table as tableOf } from '../../core/config/model';
import type { ChartType, Config, FieldDef, MenuNode, ReportDef, Step, TableDef, RefLine } from '../../core/config/types';
import type { AggregateFn } from '../../core/query/types';
import { partTableOf } from '../../core/data';
import { PERIODS, PERIODS_AHEAD, periodTitle, runReport, type PeriodKind, type ReportResult } from '../../core/reports';
import { button, clear, h, icon } from '../dom';
import { confirm, toast } from '../ui';
import { renderChart } from '../charts';
import { reportChartData } from '../pages/report';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { checkProp, exprProp, iconProp, section, selectProp, textProp } from './props';

type Measure = ReportDef['measures'][number];

const FNS: AggregateFn[] = ['sum', 'count', 'avg', 'min', 'max', 'countDistinct'];
const CHARTS: ChartType[] = ['bar', 'hbar', 'stacked', 'line', 'area', 'pie', 'donut'];
const PREVIEW_ROWS = 50;

function fnTitle(fn: AggregateFn): string {
  switch (fn) {
    case 'sum':
      return t('reportDesigner', 'Sum');
    case 'count':
      return t('reportDesigner', 'Count');
    case 'avg':
      return t('reportDesigner', 'Average');
    case 'min':
      return t('reportDesigner', 'Minimum');
    case 'max':
      return t('reportDesigner', 'Maximum');
    case 'countDistinct':
      return t('reportDesigner', 'Distinct values');
  }
}

function chartTitle(type: ChartType): string {
  switch (type) {
    case 'bar':
      return t('reportDesigner', 'Columns');
    case 'hbar':
      return t('reportDesigner', 'Horizontal bars');
    case 'stacked':
      return t('reportDesigner', 'Stacked columns');
    case 'line':
      return t('reportDesigner', 'Line');
    case 'area':
      return t('reportDesigner', 'Area');
    case 'pie':
      return t('reportDesigner', 'Pie');
    case 'donut':
      return t('reportDesigner', 'Donut');
  }
}

function unitTitle(unit: string): string {
  return unit === 'day' ? t('reportDesigner', 'by day') : unit === 'month' ? t('reportDesigner', 'by month') : t('reportDesigner', 'by year');
}

/** A select over options, keeping a value that is not among them (a broken path stays visible). */
function select(value: string, options: [string, string][], onChange: (v: string) => void, opts: { empty?: string; cls?: string } = {}): HTMLSelectElement {
  const list = [...options];
  if (value && !list.some(([v]) => v === value)) list.push([value, `${value} (?)`]);
  const el = h('select', { class: `input ${opts.cls ?? ''}` }, opts.empty !== undefined ? h('option', { value: '' }, opts.empty) : null, list.map(([v, title]) => h('option', { value: v }, title)));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export class ReportDesigner implements Page {
  id: string;
  title = '';
  icon = 'chart';
  readonly el: HTMLElement;
  private main: HTMLElement;
  private props: HTMLElement;
  private toolbar: HTMLElement;
  private preview: HTMLElement;
  private runNo = 0;
  private unsubscribe: () => void;

  constructor(
    private readonly shell: Shell,
    private readonly key: string,
  ) {
    this.id = `design:report:${key}`;
    this.toolbar = h('div', { class: 'toolbar' });
    this.main = h('div', { class: 'rd-main' });
    this.preview = h('div', { class: 'rd-preview' });
    this.props = h('div', { class: 'props' });
    this.el = h('div', { class: 'page report-designer' }, this.toolbar, h('div', { class: 'designer' }, h('div', { class: 'designer-main' }, this.main), this.props));
    // Data changed elsewhere (a document posted in another tab): the preview follows.
    this.unsubscribe = shell.data.onChange(() => void this.runPreview());
    this.render();
  }

  dispose(): void {
    this.unsubscribe();
  }

  private report(config: Config = this.shell.session.config): ReportDef | undefined {
    return config.reports.find((r) => r.key === this.key);
  }

  configChanged(): void {
    if (!this.report()) {
      this.shell.closePage(this.id);
      return;
    }
    this.render();
  }

  private change(fn: (r: ReportDef, c: Config) => void): Promise<void> {
    return this.shell.session
      .change((c) => {
        const r = this.report(c);
        if (r) fn(r, c);
      })
      .then(() => undefined)
      .catch((e: unknown) => this.shell.fail(e));
  }

  /** The table the report reads — a part's lines look like a table — and, for a part, its document. */
  private source(r: ReportDef): { table: TableDef; owner?: TableDef } | null {
    const [name, part] = r.source.split('.') as [string, string?];
    const tb = tableOf(this.shell.session.config, name);
    if (!tb) return null;
    return part ? { table: partTableOf(tb, part), owner: tb } : { table: tb };
  }

  /**
   * Paths a grouping or a measure may use: the fields, one step through each
   * reference, a part's document fields as doc.x, and date buckets.
   */
  private paths(r: ReportDef, opts: { buckets?: boolean; numeric?: boolean } = {}): [string, string][] {
    const config = this.shell.session.config;
    const src = this.source(r);
    if (!src) return [];
    const out: [string, string][] = [];
    const add = (prefix: string, titlePrefix: string, fields: FieldDef[], deep: boolean) => {
      for (const f of fields) {
        const path = `${prefix}${f.name}`;
        const title = `${titlePrefix}${f.title ?? f.name}`;
        if (!opts.numeric || isNumeric(f)) out.push([path, title]);
        if (opts.buckets && (f.type === 'date' || f.type === 'datetime')) for (const unit of ['day', 'month', 'year']) out.push([`${path}:${unit}`, `${title} · ${unitTitle(unit)}`]);
        if (deep && f.type === 'ref') {
          const target = tableOf(config, f.ref);
          for (const g of target ? allFields(target) : []) if (!opts.numeric || isNumeric(g)) out.push([`${path}.${g.name}`, `${title} → ${g.title ?? g.name}`]);
        }
      }
    };
    add('', '', allFields(src.table), true);
    // The report core resolves references of the lines, not of the document: doc paths stay one level.
    if (src.owner) add('doc.', `${t('reportDesigner', 'Document')}: `, allFields(src.owner), false);
    return out;
  }

  private render(): void {
    const r = this.report();
    if (!r) return;
    const inputs = () => [...this.el.querySelectorAll<HTMLElement>('input, select, textarea')];
    const active = document.activeElement as HTMLElement | null;
    const focusAt = active && this.el.contains(active) ? inputs().indexOf(active) : -1;
    const scroll = this.main.scrollTop;
    this.title = `${t('reportDesigner', 'Report')}: ${r.title}`;
    this.icon = r.icon ?? 'chart';
    this.shell.updateTab(this);
    clear(
      this.toolbar,
      icon(r.icon ?? 'chart'),
      h('span', { class: 'page-title' }, r.title),
      h('span', { class: 'muted mono' }, r.name),
      h('span', { class: 'spacer' }),
      button(t('reportDesigner', 'Open the report'), { icon: 'play', onClick: () => this.shell.openTarget({ kind: 'report', name: r.name }) }),
      button(t('reportDesigner', 'Delete'), { icon: 'trash', class: 'danger', onClick: () => void this.deleteReport() }),
    );
    clear(this.main, h('div', { class: 'rd-pair' }, this.groupings(r), this.sorting(r)), this.measures(r), this.computedColumns(r), this.chart(r), h('h4', { class: 'rd-head' }, t('reportDesigner', 'Preview')), this.preview);
    this.renderProps(r);
    this.main.scrollTop = scroll;
    if (focusAt >= 0) inputs()[focusAt]?.focus();
    void this.runPreview();
  }

  /* ------------------------------ groupings ------------------------------ */

  private groupings(r: ReportDef): HTMLElement {
    const options = this.paths(r, { buckets: true });
    const replace = (from: string, to: string | null) =>
      void this.change((x) => {
        const i = x.groupBy.indexOf(from);
        if (i < 0) return;
        if (to === null) x.groupBy.splice(i, 1);
        else x.groupBy[i] = to;
        // Sort and chart refer to groupings by their path: follow the change.
        x.sort = (x.sort ?? []).flatMap((s) => (s.field !== from ? [s] : to === null ? [] : [{ ...s, field: to }]));
        if (!x.sort.length) delete x.sort;
        if (x.chart?.x === from) x.chart.x = to ?? x.groupBy[0] ?? '';
      });
    const rows = r.groupBy.map((g, i) =>
      h(
        'div',
        { class: 'rd-row', 'data-group': g },
        h('span', { class: 'n muted' }, String(i + 1)),
        select(g, options, (v) => replace(g, v)),
        button(null, { icon: 'arrowUp', title: t('reportDesigner', 'Move up'), disabled: i === 0, onClick: () => void this.change((x) => x.groupBy.splice(i - 1, 0, x.groupBy.splice(i, 1)[0]!)) }),
        button(null, { icon: 'x', title: t('reportDesigner', 'Remove'), onClick: () => replace(g, null) }),
      ),
    );
    return h(
      'fieldset',
      { class: 'f-group rd-section' },
      h('legend', null, t('reportDesigner', 'Group rows by')),
      rows.length ? rows : h('div', { class: 'muted rd-none' }, t('reportDesigner', 'No groupings: the report is one line of totals.')),
      button(t('reportDesigner', 'Add a grouping'), {
        icon: 'plus',
        disabled: !options.length,
        onClick: () => void this.change((x) => x.groupBy.push(options.find(([v]) => !x.groupBy.includes(v))?.[0] ?? options[0]![0])),
      }),
    );
  }

  /* ------------------------------ measures ------------------------------ */

  private measures(r: ReportDef): HTMLElement {
    const setM = (i: number, fn: (m: Measure, x: ReportDef) => void) =>
      void this.change((x) => {
        const m = x.measures[i];
        if (m) fn(m, x);
      });
    const rename = (i: number, from: string, to: string) => {
      if (to === from) return;
      if (!IDENT.test(to)) return toast(t('reportDesigner', 'The name must be a Latin identifier'), 'error');
      if (r.measures.some((m) => m.name === to) || r.groupBy.includes(to)) return toast(t('reportDesigner', 'There is already a column named “{name}”', { name: to }), 'error');
      setM(i, (m, x) => {
        m.name = to;
        for (const s of x.sort ?? []) if (s.field === from) s.field = to;
        if (x.chart) x.chart.series = x.chart.series.map((s) => (s === from ? to : s));
      });
    };
    const rows = r.measures.map((m, i) => {
      const name = h('input', { class: 'input mono', value: m.name, title: t('reportDesigner', 'Column name') });
      name.addEventListener('change', () => rename(i, m.name, name.value.trim()));
      const title = h('input', { class: 'input', value: m.title ?? '', placeholder: t('reportDesigner', 'Title') });
      title.addEventListener('change', () => setM(i, (x) => (title.value.trim() ? (x.title = title.value.trim()) : delete x.title)));
      const numericOnly = m.fn === 'sum' || m.fn === 'avg';
      // An expression over each row in place of a field, and a condition of the measure's own.
      const expr = h('input', { class: 'input mono', value: m.expr ?? '', placeholder: t('reportDesigner', '= an expression instead of a field'), 'data-measure-expr': m.name });
      expr.addEventListener('change', () => setM(i, (x) => (expr.value.trim() ? ((x.expr = expr.value.trim()), delete x.field) : delete x.expr)));
      const where = h('input', { class: 'input mono', value: m.where ?? '', placeholder: t('reportDesigner', 'only where…') });
      where.addEventListener('change', () => setM(i, (x) => (where.value.trim() ? (x.where = where.value.trim()) : delete x.where)));
      const more = h('div', { class: 'rd-row rd-measure-more' }, expr, where);
      return h(
        'div',
        { class: 'rd-measure-block' },
        h(
        'div',
        { class: 'rd-row rd-measure', 'data-measure': m.name },
        name,
        select(m.fn, FNS.map((f) => [f, fnTitle(f)]), (v) => setM(i, (x) => (x.fn = v as AggregateFn))),
        m.expr ? h('span', { class: 'muted mono' }, '= …') : select(m.field ?? '', this.paths(r, { numeric: numericOnly }), (v) => setM(i, (x) => (v ? (x.field = v) : delete x.field)), { empty: m.fn === 'count' ? t('reportDesigner', '(rows)') : '—' }),
        title,
        button(null, { icon: 'arrowUp', title: t('reportDesigner', 'Move up'), disabled: i === 0, onClick: () => void this.change((x) => x.measures.splice(i - 1, 0, x.measures.splice(i, 1)[0]!)) }),
        button(null, {
          icon: 'x',
          title: t('reportDesigner', 'Remove'),
          onClick: () =>
            setM(i, (_m, x) => {
              x.measures.splice(i, 1);
              x.sort = (x.sort ?? []).filter((s) => s.field !== m.name);
              if (!x.sort.length) delete x.sort;
              if (x.chart) x.chart.series = x.chart.series.filter((s) => s !== m.name);
            }),
        }),
        ),
        more,
      );
    });
    return h(
      'fieldset',
      { class: 'f-group rd-section' },
      h('legend', null, t('reportDesigner', 'Measures')),
      rows.length ? h('div', { class: 'rd-row rd-measure rd-labels muted' }, h('span', null, t('reportDesigner', 'Name')), h('span', null, t('reportDesigner', 'Function')), h('span', null, t('reportDesigner', 'Field')), h('span', null, t('reportDesigner', 'Title'))) : null,
      rows,
      button(t('reportDesigner', 'Add a measure'), {
        icon: 'plus',
        onClick: () =>
          void this.change((x) => {
            const numeric = this.paths(x, { numeric: true })[0]?.[0];
            let name = numeric ? (numeric.split('.').pop() ?? 'value') : 'count';
            for (let n = 2; x.measures.some((m) => m.name === name) || x.groupBy.includes(name); n++) name = `${numeric ? 'value' : 'count'}${n}`;
            x.measures.push(numeric ? { name, fn: 'sum', field: numeric } : { name, fn: 'count' });
          }),
      }),
    );
  }

  /** Columns worked out from each grouped row: expressions over its groups and measures. */
  private computedColumns(r: ReportDef): HTMLElement {
    const set = (i: number, fn: (c: NonNullable<ReportDef['columns']>[number]) => void) =>
      void this.change((x) => {
        const c = x.columns?.[i];
        if (c) fn(c);
      });
    const rows = (r.columns ?? []).map((c, i) => {
      const name = h('input', { class: 'input mono', value: c.name });
      name.addEventListener('change', () => IDENT.test(name.value.trim()) && set(i, (x) => (x.name = name.value.trim())));
      const expr = h('input', { class: 'input mono', value: c.expr, placeholder: 'total / count' });
      expr.addEventListener('change', () => set(i, (x) => (x.expr = expr.value.trim())));
      const title = h('input', { class: 'input', value: c.title ?? '', placeholder: t('reportDesigner', 'Title') });
      title.addEventListener('change', () => set(i, (x) => (title.value.trim() ? (x.title = title.value.trim()) : delete x.title)));
      return h('div', { class: 'rd-row rd-col' }, name, expr, title, button(null, { icon: 'x', title: t('reportDesigner', 'Remove'), onClick: () => void this.change((x) => (x.columns!.splice(i, 1), x.columns!.length || delete x.columns)) }));
    });
    return h(
      'fieldset',
      { class: 'f-group rd-section' },
      h('legend', null, t('reportDesigner', 'Computed columns')),
      rows.length ? rows : h('div', { class: 'muted rd-none' }, t('reportDesigner', 'Worked out from each row of the result: an expression over its measures.')),
      button(t('reportDesigner', 'Add a column'), { icon: 'plus', onClick: () => void this.change((x) => (x.columns = [...(x.columns ?? []), { name: `col${(x.columns?.length ?? 0) + 1}`, expr: x.measures[0]?.name ?? '0' }])) }),
    );
  }

  /* ------------------------------ sort ------------------------------ */

  private sorting(r: ReportDef): HTMLElement {
    const labels = new Map(this.paths(r, { buckets: true }));
    const options: [string, string][] = [...r.groupBy.map((g) => [g, labels.get(g) ?? g] as [string, string]), ...r.measures.map((m) => [m.name, m.title ?? m.name] as [string, string])];
    const sort = r.sort ?? [];
    const rows = sort.map((s, i) =>
      h(
        'div',
        { class: 'rd-row', 'data-sort': s.field },
        h('span', { class: 'n muted' }, String(i + 1)),
        select(s.field, options, (v) => void this.change((x) => (x.sort![i]!.field = v))),
        select(s.desc ? 'desc' : 'asc', [['asc', t('reportDesigner', 'Ascending')], ['desc', t('reportDesigner', 'Descending')]], (v) => void this.change((x) => (v === 'desc' ? (x.sort![i]!.desc = true) : delete x.sort![i]!.desc)), { cls: 'rd-dir' }),
        button(null, {
          icon: 'x',
          title: t('reportDesigner', 'Remove'),
          onClick: () =>
            void this.change((x) => {
              x.sort!.splice(i, 1);
              if (!x.sort!.length) delete x.sort;
            }),
        }),
      ),
    );
    return h(
      'fieldset',
      { class: 'f-group rd-section' },
      h('legend', null, t('reportDesigner', 'Sort')),
      rows.length ? rows : h('div', { class: 'muted rd-none' }, t('reportDesigner', 'In the order the groups come.')),
      button(t('reportDesigner', 'Add a sort'), {
        icon: 'plus',
        disabled: !options.length,
        onClick: () => void this.change((x) => (x.sort = [...(x.sort ?? []), { field: options.find(([v]) => !(x.sort ?? []).some((s) => s.field === v))?.[0] ?? options[0]![0] }])),
      }),
    );
  }

  /* ------------------------------ chart ------------------------------ */

  private chart(r: ReportDef): HTMLElement {
    const labels = new Map(this.paths(r, { buckets: true }));
    const c = r.chart;
    const type = select(c?.type ?? '', CHARTS.map((x) => [x, chartTitle(x)]), (v) =>
      void this.change((x) => {
        if (!v) delete x.chart;
        else if (x.chart) x.chart.type = v as ChartType;
        else x.chart = { type: v as ChartType, x: x.groupBy[0] ?? '', series: x.measures.slice(0, 1).map((m) => m.name) };
      }),
    { empty: t('reportDesigner', 'No chart') });
    type.dataset.prop = 'chart';
    const body: Node[] = [h('label', { class: 'rd-inline' }, h('span', null, t('reportDesigner', 'Type')), type)];
    if (c) {
      body.push(
        h('label', { class: 'rd-inline' }, h('span', null, t('reportDesigner', 'Categories')), select(c.x, [...(r.mode === 'series' ? [[`${r.dateField ?? 'date'}:${r.bucket ?? 'day'}`, t('reportDesigner', 'Date')] as [string, string]] : []), ...r.groupBy.map((g) => [g, labels.get(g) ?? g] as [string, string])], (v) => void this.change((x) => x.chart && (x.chart.x = v)))),
        h(
          'div',
          { class: 'rd-inline rd-series' },
          h('span', null, t('reportDesigner', 'Values')),
          ...r.measures.map((m) => {
            const box = h('input', { type: 'checkbox' });
            box.checked = c.series.includes(m.name);
            box.addEventListener('change', () =>
              void this.change((x) => {
                if (!x.chart) return;
                const on = new Set(x.chart.series);
                if (box.checked) on.add(m.name);
                else on.delete(m.name);
                // Keep the order of the measures, not of the clicks.
                x.chart.series = x.measures.map((mm) => mm.name).filter((n) => on.has(n));
              }),
            );
            return h('label', { class: 'row' }, box, m.title ?? m.name);
          }),
        ),
      );
      const title = h('input', { class: 'input', value: c.title ?? '', placeholder: r.title });
      title.addEventListener('change', () => void this.change((x) => x.chart && (title.value.trim() ? (x.chart.title = title.value.trim()) : delete x.chart.title)));
      body.push(h('label', { class: 'rd-inline rd-grow' }, h('span', null, t('reportDesigner', 'Title')), title));
      body.push(this.levels(r));
      if (c.type === 'stacked' && r.groupBy.length < 2) body.push(h('div', { class: 'muted rd-note' }, t('reportDesigner', 'Stacked columns split each column by the second grouping.')));
    }
    return h('fieldset', { class: 'f-group rd-section' }, h('legend', null, t('reportDesigner', 'Chart')), h('div', { class: 'rd-chart' }, body));
  }

  /** Levels across the chart: a value, or one per row of a table (each goal's price). */
  private levels(r: ReportDef): HTMLElement {
    const config = this.shell.session.config;
    const lines = r.chart?.refLines ?? [];
    const set = (i: number, fn: (l: RefLine) => void) =>
      void this.change((x) => {
        const l = x.chart?.refLines?.[i];
        if (l) fn(l);
      });
    const input = (value: string | undefined, placeholder: string, apply: (v: string) => void) => {
      const el = h('input', { class: 'input mono', value: value ?? '', placeholder });
      el.addEventListener('change', () => apply(el.value.trim()));
      return el;
    };
    return h(
      'div',
      { class: 'rd-levels' },
      h('span', { class: 'muted' }, t('reportDesigner', 'Levels across the chart')),
      ...lines.map((l, i) =>
        h(
          'div',
          { class: 'rd-row rd-level' },
          select(l.from ?? '', config.tables.filter((x) => x.kind !== 'register').map((x) => [x.name, x.title] as [string, string]), (v) => set(i, (x) => (v ? (x.from = v) : delete x.from)), { empty: t('reportDesigner', 'one value') }),
          input(l.value, l.from ? 'price' : '0', (v) => set(i, (x) => (x.value = v || '0'))),
          input(l.title, l.from ? 'name' : t('reportDesigner', 'Title'), (v) => set(i, (x) => (v ? (x.title = v) : delete x.title))),
          l.from ? input(l.where, t('reportDesigner', 'only where…'), (v) => set(i, (x) => (v ? (x.where = v) : delete x.where))) : h('span'),
          button(null, { icon: 'x', title: t('reportDesigner', 'Remove'), onClick: () => void this.change((x) => x.chart?.refLines && (x.chart.refLines.splice(i, 1), x.chart.refLines.length || delete x.chart.refLines)) }),
        ),
      ),
      button(t('reportDesigner', 'Add a level'), { icon: 'plus', onClick: () => void this.change((x) => x.chart && (x.chart.refLines = [...(x.chart.refLines ?? []), { value: '0' }])) }),
    );
  }

  /* ------------------------------ preview ------------------------------ */

  private async runPreview(): Promise<void> {
    const r = this.report();
    if (!r) return;
    const no = ++this.runNo;
    const kind = (r.params?.find((p) => p.type === 'period')?.default as PeriodKind | undefined) ?? 'all';
    let result: ReportResult;
    try {
      result = await runReport(this.shell.data, r, { period: { kind } });
    } catch (error) {
      if (no === this.runNo) clear(this.preview, h('div', { class: 'form-errors' }, error instanceof Error ? error.message : String(error)));
      return;
    }
    // A newer run started while this one read the data: its result wins.
    if (no !== this.runNo) return;
    const parts: Node[] = [h('div', { class: 'muted rd-note' }, t('reportDesigner', 'Period: {period} · {n} rows', { period: periodTitle(kind), n: result.rows.length }))];
    const data = reportChartData(r, result);
    if (data && r.chart) parts.push(h('div', { class: 'chart-box', 'data-chart': r.chart.type }, h('h4', null, r.chart.title ?? r.title), renderChart(r.chart.type, data, { height: 220 })));
    const label = (key: string, v: unknown) => result.labels[key]?.get(v) ?? (v === null || v === undefined || v === '' ? '—' : String(v));
    parts.push(
      h(
        'div',
        { class: 'rd-table' },
        h(
          'table',
          { class: 'design-table' },
          h('thead', null, h('tr', null, result.columns.map((c) => h('th', { class: c.measure ? 'num' : '' }, c.title)))),
          h(
            'tbody',
            null,
            result.rows.slice(0, PREVIEW_ROWS).map((row) => h('tr', null, result.columns.map((c) => h('td', { class: c.measure ? 'num' : '' }, c.measure ? formatValue(c.field, row[c.key]) : label(c.key, row[c.key]))))),
          ),
        ),
        result.rows.length > PREVIEW_ROWS ? h('div', { class: 'muted rd-note' }, t('reportDesigner', 'The first {n} of {total} rows', { n: PREVIEW_ROWS, total: result.rows.length })) : null,
        !result.rows.length ? h('div', { class: 'muted rd-none' }, t('reportDesigner', 'No rows for this period')) : null,
      ),
    );
    clear(this.preview, ...parts);
  }

  /* ------------------------------ the report's own properties ------------------------------ */

  private renderProps(r: ReportDef): void {
    const config = this.shell.session.config;
    const set = (fn: (x: ReportDef) => void) => void this.change((x) => fn(x));
    const src = this.source(r);
    const sources: [string, string][] = [];
    for (const tb of config.tables) {
      sources.push([tb.name, tb.title]);
      for (const p of tb.parts ?? []) sources.push([`${tb.name}.${p.name}`, `${tb.title} → ${p.title ?? p.name}`]);
    }
    const register = src?.table.kind === 'register';
    const modes: ['rows' | 'balance' | 'turnover' | 'series', string][] = [['rows', t('reportDesigner', 'Rows of the source')]];
    if (register) modes.push(['balance', t('reportDesigner', 'Balances at the end of the period')], ['turnover', t('reportDesigner', 'Turnover in the period')]);
    if (register || r.dateField) modes.push(['series', t('reportDesigner', 'The balance at the end of each step')]);
    const dates: [string, string][] = [];
    if (src) {
      for (const f of allFields(src.table)) if (f.type === 'date' || f.type === 'datetime') dates.push([f.name, f.title ?? f.name]);
      for (const f of src.owner ? allFields(src.owner) : []) if (f.type === 'date' || f.type === 'datetime') dates.push([`doc.${f.name}`, `${t('reportDesigner', 'Document')}: ${f.title ?? f.name}`]);
    }
    const names = () => {
      const s = this.source(this.report() ?? r);
      return s ? [...allFields(s.table).map((f) => f.name), 'id', ...(s.owner ? ['doc'] : [])] : [];
    };
    const period = r.params?.find((p) => p.type === 'period');
    clear(
      this.props,
      section(
        t('reportDesigner', 'Report'),
        textProp(t('reportDesigner', 'Title'), r.title, (v) => set((x) => (x.title = v || x.title))),
        textProp(t('reportDesigner', 'Name'), r.name, (v) => void this.rename(r, v), { mono: true }),
        iconProp(t('reportDesigner', 'Icon'), r.icon, (v) => set((x) => (x.icon = v))),
        textProp(t('reportDesigner', 'Description'), r.description, (v) => set((x) => (v ? (x.description = v) : delete x.description)), { multiline: true, hint: t('reportDesigner', 'Shown above the report') }),
      ),
      section(
        t('reportDesigner', 'Data'),
        this.pluginChoice(r),
        r.plugin ? null : selectProp(t('reportDesigner', 'Source'), r.source, sources, (v) =>
          set((x) => {
            x.source = v;
            const s = this.source(x);
            if (s?.table.kind !== 'register') delete x.mode;
            if (x.dateField && !(x.dateField.startsWith('doc.') ? s?.owner : s?.table)) delete x.dateField;
          }),
        ),
        register || r.mode || r.dateField ? selectProp(t('reportDesigner', 'Mode'), r.mode ?? 'rows', modes, (v) => set((x) => (v === 'rows' ? delete x.mode : (x.mode = v)))) : null,
        r.mode === 'series' ? selectProp(t('reportDesigner', 'Step'), r.bucket ?? 'day', [['day', t('reportDesigner', 'A day')], ['week', t('reportDesigner', 'A week')], ['month', t('reportDesigner', 'A month')]], (v) => set((x) => (v === 'day' ? delete x.bucket : (x.bucket = v as 'week' | 'month')))) : null,
        selectProp(t('reportDesigner', 'Date field'), r.dateField ?? '', dates, (v) => set((x) => (v ? (x.dateField = v) : delete x.dateField)), true),
        exprProp(t('reportDesigner', 'Only rows where'), r.where, names, (v) => set((x) => (v ? (x.where = v) : delete x.where)), { placeholder: 'posted', hint: t('reportDesigner', 'An expression over a row; may use $params') }),
      ),
      section(
        t('reportDesigner', 'Parameters'),
        checkProp(t('reportDesigner', 'Period'), !!period, (v) =>
          set((x) => {
            const others = (x.params ?? []).filter((p) => p.type !== 'period');
            x.params = v ? [{ name: 'period', type: 'period', title: t('reportDesigner', 'Period'), default: 'all' }, ...others] : others;
            if (!x.params.length) delete x.params;
          }),
          t('reportDesigner', 'A period chooser above the report; it filters by the date field'),
        ),
        period
          ? selectProp<PeriodKind>(t('reportDesigner', 'By default'), (period.default?.startsWith('=') ? ('' as PeriodKind) : (period.default as PeriodKind | undefined)) ?? 'all', [...PERIODS.filter((p) => p !== 'custom'), ...(register || r.mode === 'series' ? PERIODS_AHEAD : [])].map((p) => [p, periodTitle(p)]), (v) =>
              set((x) => {
                const p = x.params?.find((pp) => pp.type === 'period');
                if (p) p.default = v;
              }),
            )
          : null,
        period
          ? textProp(t('reportDesigner', 'Or worked out'), period.default?.startsWith('=') ? period.default : '', (v) =>
              set((x) => {
                const p = x.params?.find((pp) => pp.type === 'period');
                if (p) p.default = v ? (v.startsWith('=') ? v : `=${v}`) : 'all';
              }),
            { mono: true, placeholder: "='next:' & $const.horizonYears & 'y'" })
          : null,
        period && !r.dateField && src?.table.kind !== 'document' && src?.table.kind !== 'register' ? h('p', { class: 'muted rd-note' }, t('reportDesigner', 'Choose a date field, or the period filters nothing.')) : null,
      ),
    );
  }

  /** A report a plugin computes: chosen among the reports of the plugins that run here. */
  private pluginChoice(r: ReportDef): HTMLElement {
    const current = r.plugin ? `${r.plugin.plugin}/${r.plugin.report}` : '';
    const select = h('select', { class: 'input', 'data-prop': 'plugin' }, h('option', { value: '' }, t('reportDesigner', 'The studio, from the source below')), current ? h('option', { value: current }, current) : null);
    select.value = current;
    void this.shell.registry.reports().then((list) => {
      for (const x of list) {
        const value = `${x.plugin}/${x.name}`;
        if (value !== current) select.appendChild(h('option', { value }, `${x.pluginName}: ${x.title}`));
        else (select.querySelector(`option[value="${CSS.escape(value)}"]`) as HTMLOptionElement | null)?.replaceChildren(`${x.pluginName}: ${x.title}`);
      }
    });
    select.addEventListener('change', () =>
      void this.change((x) => {
        if (!select.value) return void delete x.plugin;
        const [plugin, report] = select.value.split('/') as [string, string];
        x.plugin = { plugin, report };
      }),
    );
    return h('div', { class: 'prop' }, h('label', null, t('reportDesigner', 'Computed by')), select);
  }

  /** Renames the report and the dashboard widgets, menu items and steps that open it. */
  private async rename(r: ReportDef, to: string): Promise<void> {
    const from = r.name;
    if (to === from) return;
    if (!IDENT.test(to)) return toast(t('reportDesigner', 'The name must be a Latin identifier'), 'error');
    if (this.shell.session.config.reports.some((x) => x.name === to)) return toast(t('reportDesigner', 'There is already a report named “{name}”', { name: to }), 'error');
    await this.change((x, c) => {
      x.name = to;
      for (const d of c.dashboards) for (const w of d.widgets) if (w.report === from) w.report = to;
      const walkMenu = (nodes: MenuNode[]) => {
        for (const n of nodes) {
          if (n.target?.kind === 'report' && n.target.name === from) n.target.name = to;
          if (n.children) walkMenu(n.children);
        }
      };
      walkMenu(c.menu);
      const walkSteps = (steps: Step[]) => {
        for (const s of steps) {
          if (s.type === 'open' && s.target.kind === 'report' && s.target.name === from) s.target.name = to;
          if (s.type === 'if') [s.steps, s.else ?? []].forEach(walkSteps);
        }
      };
      for (const a of [...c.actions, ...c.triggers]) walkSteps(a.steps);
    });
  }

  private async deleteReport(): Promise<void> {
    const r = this.report();
    if (!r) return;
    const widgets = this.shell.session.config.dashboards.reduce((n, d) => n + d.widgets.filter((w) => w.report === r.name).length, 0);
    const text = widgets
      ? tn('reportDesigner', 'Delete “{title}”? Its dashboard widget and its menu items go too.', 'Delete “{title}”? Its {count} dashboard widgets and its menu items go too.', widgets, { title: r.title })
      : t('reportDesigner', 'Delete “{title}”? Its menu items go too.', { title: r.title });
    if (!(await confirm(t('reportDesigner', 'Delete the report'), text, t('reportDesigner', 'Delete'), true))) return;
    await this.shell.session
      .change((c) => {
        c.reports = c.reports.filter((x) => x.key !== r.key);
        for (const d of c.dashboards) d.widgets = d.widgets.filter((w) => w.report !== r.name);
        const strip = (nodes: MenuNode[]): MenuNode[] => nodes.filter((n) => !(n.target?.kind === 'report' && n.target.name === r.name)).map((n) => (n.children ? { ...n, children: strip(n.children) } : n));
        c.menu = strip(c.menu);
      })
      .catch((e: unknown) => this.shell.fail(e));
  }
}
