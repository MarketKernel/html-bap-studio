/**
 * A dashboard (Task.md 11.3): a 12-column grid of widgets — KPI tiles, report
 * charts, short lists of a view — refreshed when their data changes.
 */
import { t } from '../../core/i18n';
import { formatAs, formatNumber } from '../../core/format';
import type { ActionDef, DashboardDef, WidgetDef } from '../../core/config/types';
import { kpi, runReport, defaultPeriod, evaluator, periodTitle, type Period, type PeriodKind } from '../../core/reports';
import { parseText, renderText, textExpressions } from '../../core/template';
import { truthy } from '../../core/data';
import { viewFor } from '../../core/config/model';
import { button, clear, h, icon } from '../dom';
import { renderChart } from '../charts';
import { chartOf, reportChartData } from './report';
import type { App, Page } from '../app';
import { ListPage } from './list';

export class DashboardPage implements Page {
  readonly id: string;
  title: string;
  icon = 'dashboard';
  readonly el: HTMLElement;
  private gridEl: HTMLElement;
  private lists: ListPage[] = [];
  private unsubscribe: () => void;
  private pending: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly app: App,
    private dash: DashboardDef,
  ) {
    this.id = `dashboard:${dash.name}`;
    this.title = dash.title;
    this.gridEl = h('div', { class: 'dash-grid' });
    this.el = h('div', { class: 'page' }, h('div', { class: 'toolbar' }, h('span', { class: 'page-title' }, dash.title), h('span', { class: 'spacer' }), button(t('dashboard', 'Refresh'), { icon: 'refresh', onClick: () => void this.render() })), h('div', { class: 'dash' }, this.gridEl));
    this.unsubscribe = app.data.onChange(() => {
      clearTimeout(this.pending);
      this.pending = setTimeout(() => void this.render(), 400);
    });
    void this.render();
  }

  dispose(): void {
    this.unsubscribe();
    for (const l of this.lists) l.dispose();
  }

  configChanged(): void {
    const d = this.app.data.config.dashboards.find((x) => x.key === this.dash.key);
    if (d) {
      this.dash = d;
      void this.render();
    }
  }

  private async render(): Promise<void> {
    for (const l of this.lists) l.dispose();
    this.lists = [];
    const widgets = await Promise.all(this.dash.widgets.map((w) => this.widget(w)));
    clear(this.gridEl, ...widgets);
  }

  private async widget(w: WidgetDef): Promise<HTMLElement> {
    const el = h('div', { class: 'widget', style: { gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }, 'data-widget': w.key }, w.title ? h('h4', null, w.title) : null);
    try {
      if (w.type === 'kpi' && w.value) {
        // A value worked out by an expression, with words under it; what it reaches is loaded once.
        const sub = w.text ? parseText(w.text) : [];
        const value = await evaluator(this.app.data, [w.value, ...textExpressions(sub)]);
        const v = value(w.value);
        el.classList.toggle('hero', w.size === 'hero');
        el.appendChild(h('div', { class: 'kpi', 'data-kpi': w.key }, formatAs(v, w.format ?? (typeof v === 'number' ? 'money' : ''))));
        if (sub.length) el.appendChild(h('div', { class: 'kpi-sub' }, renderText(sub, value, formatAs, truthy)));
        el.appendChild(await this.actions(w, v));
      } else if (w.type === 'kpi' && w.table) {
        const value = await kpi(this.app.data, w.table, w.fn ?? 'count', w.field, w.where);
        const f = w.field ? this.app.data.table(w.table).fields.find((x) => x.name === w.field) : undefined;
        el.classList.toggle('hero', w.size === 'hero');
        el.appendChild(h('div', { class: 'kpi' }, w.format ? formatAs(value, w.format) : formatNumber(value, w.fn === 'count' ? 0 : (f?.scale ?? 2), w.fn !== 'count')));
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => this.app.openTarget({ kind: 'table', name: w.table! }));
        el.appendChild(await this.actions(w, value));
      } else if (w.type === 'chart' && w.report) {
        const report = this.app.data.config.reports.find((r) => r.name === w.report);
        if (report) {
          const period = this.periods.get(w.key) ?? (await defaultPeriod(this.app.data, report));
          const result = await runReport(this.app.data, report, { period });
          const data = reportChartData(report, result);
          // The period chooser of a chart over time: a week, a month, … a year ahead.
          if (report.params?.some((p) => p.type === 'period')) {
            const ahead = report.mode === 'series' || report.mode === 'balance';
            const kinds = ahead ? (['next:7d', 'next:1m', 'next:3m', 'next:6m', 'next:1y'] as PeriodKind[]) : (['month', 'quarter', 'year', 'all'] as PeriodKind[]);
            if (!kinds.includes(period.kind)) kinds.push(period.kind);
            const pick = h('select', { class: 'input widget-period', 'data-period': w.key }, kinds.map((k) => h('option', { value: k }, periodTitle(k))));
            pick.value = period.kind;
            pick.addEventListener('change', () => {
              this.periods.set(w.key, { kind: pick.value as PeriodKind });
              void this.widget(w).then((fresh) => el.replaceWith(fresh));
            });
            const head = el.querySelector('h4');
            if (head) head.after(pick);
            else el.prepend(pick);
          }
          const chart = chartOf(report, result);
          if (data && chart) el.appendChild(renderChart(chart.type, data, { height: Math.max(160, w.h * 90 - 70), levels: result.refLines ?? [] }));
          el.style.overflow = 'auto';
          el.querySelector('h4')?.addEventListener('click', () => this.app.openTarget({ kind: 'report', name: report.name }));
          (el.querySelector('h4') as HTMLElement | null)?.style.setProperty('cursor', 'pointer');
        }
      } else if (w.type === 'list' && w.view) {
        const v = viewFor(this.app.data.config, w.view);
        if (v) {
          const list = new ListPage(this.app, v, { embedded: true });
          this.lists.push(list);
          el.style.padding = '8px 0 0';
          (el.querySelector('h4') as HTMLElement | null)?.style.setProperty('padding', '0 12px');
          el.appendChild(h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } }, list.el));
        }
      } else if (w.type === 'text') {
        // Plain text with expressions in it: set as text, never as HTML.
        const nodes = parseText(w.text ?? '');
        const value = await evaluator(this.app.data, textExpressions(nodes));
        el.appendChild(h('div', { class: 'widget-text' }, renderText(nodes, value, formatAs, truthy)));
        el.appendChild(await this.actions(w, null));
      }
    } catch (error) {
      el.appendChild(h('div', { class: 'muted' }, error instanceof Error ? error.message : String(error)));
    }
    return el;
  }

  /** The widget's actions as buttons; one that is not enabled for its value is not shown. */
  private async actions(w: WidgetDef, value: unknown): Promise<Node> {
    const defs = (w.actions ?? []).map((n) => this.app.data.config.actions.find((a) => a.name === n)).filter((a): a is ActionDef => !!a);
    if (!defs.length) return document.createTextNode('');
    const vars = { widget: { value } };
    const enabled = await evaluator(this.app.data, defs.map((a) => a.enabled).filter((x): x is string => !!x), vars);
    const shown = defs.filter((a) => !a.enabled || truthy(enabled(a.enabled)));
    if (!shown.length) return document.createTextNode('');
    return h(
      'div',
      { class: 'widget-actions' },
      shown.map((a) =>
        button(a.title, {
          icon: a.icon ?? 'bolt',
          class: 'outline',
          onClick: (e) => {
            e.stopPropagation();
            void this.app.runAction(a.name, { vars });
          },
        }),
      ),
    );
  }

  /** The period each chart widget was switched to, for as long as the page is open. */
  private periods = new Map<string, Period>();
}
