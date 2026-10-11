/**
 * A report on screen: its parameters above, the chart and the table below.
 * A click on a row of the table opens the records it was made of
 * (drill-down, Task.md 11.1).
 */
import { t } from '../../core/i18n';
import { formatValue } from '../../core/format';
import type { ReportDef } from '../../core/config/types';
import { defaultPeriod, PERIODS, PERIODS_AHEAD, periodTitle, runReport, reportSourceTable, type Period, type PeriodKind, type ReportResult } from '../../core/reports';
import type { Filter, Row } from '../../core/query/types';
import { toCsv } from '../../core/csv';
import { button, clear, download, h } from '../dom';
import { Grid, type GridColumn } from '../grid';
import { renderChart, type ChartData } from '../charts';
import type { App, Page } from '../app';

/** The chart a report draws: its own, or the one its plugin gave. */
export function chartOf(report: ReportDef, result: ReportResult | null): ReportDef['chart'] {
  return report.chart ?? result?.chart;
}

export function reportChartData(report: ReportDef, result: ReportResult): ChartData | null {
  const chart = chartOf(report, result);
  if (!chart) return null;
  const x = chart.x;
  const series = chart.series;
  const others = report.groupBy.filter((g) => g !== x);
  const label = (key: string, v: unknown) => result.labels[key]?.get(v) ?? (v === null || v === undefined || v === '' ? t('reports', '(empty)') : String(v));
  const labels: string[] = [];
  const index = new Map<string, number>();
  for (const r of result.rows) {
    const l = label(x, r[x]);
    if (!index.has(l)) {
      index.set(l, labels.length);
      labels.push(l);
    }
  }
  // A second grouping becomes the series of a stacked chart.
  if (chart.type === 'stacked' && others.length) {
    const by = others[0]!;
    const names = [...new Set(result.rows.map((r) => label(by, r[by])))];
    return {
      labels,
      series: names.map((name) => {
        const values: (number | null)[] = labels.map(() => null);
        for (const r of result.rows) if (label(by, r[by]) === name) values[index.get(label(x, r[x]))!] = ((values[index.get(label(x, r[x]))!] ?? 0) as number) + (Number(r[series[0]!]) || 0);
        return { name, values };
      }),
    };
  }
  return {
    labels,
    series: series.map((s) => {
      const col = result.columns.find((c) => c.key === s);
      const values: (number | null)[] = labels.map(() => null);
      for (const r of result.rows) {
        const i = index.get(label(x, r[x]))!;
        values[i] = ((values[i] ?? 0) as number) + (Number(r[s]) || 0);
      }
      return { name: col?.title ?? s, values };
    }),
  };
}

export class ReportPage implements Page {
  readonly id: string;
  title: string;
  icon?: string;
  readonly el: HTMLElement;
  private period: Period;
  private body: HTMLElement;
  private grid: Grid<Row>;
  private result: ReportResult | null = null;
  private unsubscribe: () => void;

  constructor(
    private readonly app: App,
    private report: ReportDef,
  ) {
    this.id = `report:${report.name}`;
    this.title = report.title;
    this.icon = report.icon ?? 'chart';
    this.period = { kind: 'all' };
    this.grid = new Grid<Row>({ columns: [], idOf: (r) => r.id, groupBar: true, onOpen: (r) => this.drill(r) });
    this.body = h('div', { class: 'report-body' });
    this.el = h('div', { class: 'page' }, h('div', { class: 'toolbar' }), report.description ? h('div', { class: 'info-bar' }, report.description) : null, this.params(), this.body);
    this.renderToolbar();
    this.unsubscribe = app.data.onChange(() => void this.run());
    // The period it opens with may be worked out (`='next:' & $const.horizonYears & 'y'`).
    void defaultPeriod(app.data, report).then((p) => {
      this.period = p;
      this.periodSelect?.(p);
      void this.run();
    });
  }

  private periodSelect: ((p: Period) => void) | null = null;

  dispose(): void {
    this.unsubscribe();
  }

  configChanged(): void {
    const r = this.app.data.config.reports.find((x) => x.key === this.report.key);
    if (r) {
      this.report = r;
      void this.run();
    }
  }

  private renderToolbar(): void {
    clear(
      this.el.querySelector('.toolbar')!,
      button(t('reports', 'Build'), { icon: 'play', class: 'primary', onClick: () => void this.run() }),
      button(t('reports', 'Export to CSV'), { icon: 'download', onClick: () => this.csv() }),
      h('span', { class: 'spacer' }),
      this.app.isDesign() ? button(t('reports', 'Design'), { icon: 'wrench', onClick: () => (this.app as App & { openDesigner(x: unknown): void }).openDesigner({ kind: 'report', name: this.report.name }) }) : null,
    );
  }

  private params(): HTMLElement {
    const bar = h('div', { class: 'params' });
    if (!this.report.params?.some((p) => p.type === 'period') && this.report.mode !== 'balance' && !this.report.dateField) return bar;
    // A register's balances and a series can look ahead: the planned movements make the future.
    const src = reportSourceTable(this.app.data, this.report.source);
    const ahead = this.report.mode === 'series' || (src?.table.kind === 'register' && this.report.mode === 'balance');
    const kinds = [...PERIODS.filter((p) => p !== 'custom'), ...(ahead ? PERIODS_AHEAD : []), 'custom' as PeriodKind];
    const select = h('select', { class: 'input', 'data-param': 'period' }, kinds.map((p) => h('option', { value: p }, periodTitle(p))));
    select.value = this.period.kind;
    this.periodSelect = (p) => {
      if (!kinds.includes(p.kind)) select.appendChild(h('option', { value: p.kind }, periodTitle(p.kind)));
      select.value = p.kind;
    };
    const from = h('input', { class: 'input', type: 'date' });
    const to = h('input', { class: 'input', type: 'date' });
    const sync = () => {
      const custom = select.value === 'custom';
      from.classList.toggle('hidden', !custom);
      to.classList.toggle('hidden', !custom);
    };
    select.addEventListener('change', () => {
      this.period = { kind: select.value as PeriodKind };
      sync();
      if (select.value !== 'custom') void this.run();
    });
    for (const d of [from, to])
      d.addEventListener('change', () => {
        this.period = { kind: 'custom', ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}) };
        void this.run();
      });
    sync();
    bar.append(h('label', null, this.report.mode === 'balance' ? t('reports', 'Balance at the end of') : t('reports', 'Period')), select, from, to);
    return bar;
  }

  async run(): Promise<void> {
    try {
      this.result = await runReport(this.app.data, this.report, { period: this.period });
      this.render();
    } catch (error) {
      this.app.fail(error, this.report.title);
    }
  }

  private render(): void {
    const result = this.result!;
    const chartData = reportChartData(this.report, result);
    const parts: Node[] = [];
    const chart = chartOf(this.report, result);
    if (chartData && chart) parts.push(h('div', { class: 'chart-box' }, h('h4', null, chart.title ?? this.report.title), renderChart(chart.type, chartData, { levels: result.refLines ?? [] })));
    const columns: GridColumn<Row>[] = result.columns.map((c) => ({
      key: c.key,
      title: c.title,
      width: c.measure ? 130 : 220,
      kind: c.measure ? 'number' : 'text',
      ...(c.measure ? { align: 'num' as const, ...(c.noTotal ? {} : { total: 'sum' as const }), scale: c.field?.type === 'integer' ? 0 : (c.field?.scale ?? 2) } : {}),
      value: (r) => (c.measure ? r[c.key] : (result.labels[c.key]?.get(r[c.key]) ?? r[c.key])),
      render: (_r, v) => (c.measure ? formatValue(c.field, v) : c.field ? formatValue(c.field, v) : String(v ?? '')),
    }));
    this.grid.setColumns(columns);
    this.grid.setRows(result.rows.map((r, i) => ({ ...r, id: String(i) })));
    parts.push(h('div', { class: 'chart-box', style: { padding: '0', display: 'flex', flexDirection: 'column', minHeight: '320px', flex: '1' } }, this.grid.el));
    clear(this.body, ...parts);
  }

  /** The records behind a row: the source list filtered by the row's group values. */
  private drill(row: Row): void {
    const src = reportSourceTable(this.app.data, this.report.source);
    if (!src || src.part) return;
    const filters: Filter[] = [];
    for (const g of this.report.groupBy) {
      const [path, unit] = g.split(':') as [string, string?];
      if (path.includes('.')) continue;
      const v = row[g];
      if (unit) {
        if (typeof v === 'string') filters.push({ field: path, op: 'startsWith', value: v });
      } else filters.push(v === null || v === undefined ? { field: path, op: 'isNull' } : { field: path, op: 'eq', value: v });
    }
    this.app.openTarget({ kind: 'table', name: src.table.name }, { filter: { and: filters }, title: `${this.report.title}: ${src.table.title}` });
  }

  private csv(): void {
    if (!this.result) return;
    const r = this.result;
    const rows = r.rows.map((row) => r.columns.map((c) => (c.measure ? row[c.key] : (r.labels[c.key]?.get(row[c.key]) ?? row[c.key] ?? ''))));
    download(new Blob(['﻿', toCsv([r.columns.map((c) => c.title), ...rows])], { type: 'text/csv;charset=utf-8' }), `${this.report.name}.csv`);
  }
}
