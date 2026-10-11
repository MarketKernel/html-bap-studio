/**
 * Charts, drawn as SVG by hand (Task.md 11.2): bars (vertical, horizontal,
 * stacked), line, area, pie and donut.
 *
 * The rules come from the dataviz method: categorical colours in a fixed,
 * colour-blind-checked order (never cycled — more series than slots fold into
 * "Other"), one value axis only, thin marks with rounded data ends, a hover
 * tooltip on every chart, a legend when there are two series or more, text in
 * text colours, and "no data" said in words rather than drawn as empty axes.
 */
import { t } from '../core/i18n';
import { formatNumber } from '../core/format';
import type { ChartType } from '../core/config/types';
import { clear, h, svg } from './dom';

export interface ChartData {
  /** Category labels, in order. */
  labels: string[];
  series: { name: string; values: (number | null)[] }[];
}

/** Slots 1–8 of the validated palette; light and dark steps live in styles.css as --series-n. */
const SLOTS = 8;
const color = (i: number) => `var(--series-${(i % SLOTS) + 1})`;

let tip: HTMLElement | null = null;
function showTip(e: MouseEvent, lines: (string | Node)[]) {
  tip ??= document.body.appendChild(h('div', { class: 'chart-tip', role: 'tooltip' }));
  clear(tip, ...lines.map((l) => h('div', null, l)));
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14);
  const y = Math.max(8, e.clientY - tip.offsetHeight - 10);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.style.display = 'block';
}
function hideTip() {
  if (tip) tip.style.display = 'none';
}

function niceTicks(max: number, min = 0, count = 5): number[] {
  if (max === min) max = min + 1;
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) out.push(Number(v.toPrecision(12)));
  if (out[out.length - 1]! < max) out.push(Number((out[out.length - 1]! + step).toPrecision(12)));
  return out;
}

const short = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${formatNumber(v / 1e9, 1)}B`;
  if (a >= 1e6) return `${formatNumber(v / 1e6, 1)}M`;
  if (a >= 1e4) return `${formatNumber(v / 1e3, 0)}k`;
  return formatNumber(v, a < 10 ? 1 : 0);
};

/** Folds the categories past `max` into "Other", summing — for pies and long bar lists. */
function fold(data: ChartData, max: number): ChartData {
  if (data.labels.length <= max) return data;
  return {
    labels: [...data.labels.slice(0, max - 1), t('chart', 'Other')],
    series: data.series.map((s) => ({ name: s.name, values: [...s.values.slice(0, max - 1), s.values.slice(max - 1).reduce<number>((a, b) => a + (b ?? 0), 0)] })),
  };
}

/** A level drawn across a line or bar chart: zero, a goal's price. */
export interface Level {
  value: number;
  title: string;
}

export function renderChart(type: ChartType, data: ChartData, opts: { height?: number; legend?: boolean; levels?: Level[] } = {}): HTMLElement {
  const box = h('div', { class: 'chart' });
  const total = data.series.reduce((sum, s) => sum + s.values.filter((v) => v !== null && v !== 0).length, 0);
  if (!data.labels.length || !total) {
    box.appendChild(h('div', { class: 'chart-empty' }, t('chart', 'No data for this period')));
    return box;
  }
  const hidden = new Set<number>();
  // Drawn for the width it has, so text stays at its size however wide the box is.
  let width = 640;
  const draw = () => {
    const shown: ChartData = { labels: data.labels, series: data.series.map((s, i) => (hidden.has(i) ? { ...s, values: s.values.map(() => null) } : s)) };
    let el: SVGSVGElement;
    if (type === 'pie' || type === 'donut') el = pie(fold(shown, SLOTS), type === 'donut', width);
    else if (type === 'hbar') el = hbars(fold(shown, 15), width);
    else el = cartesian(type, shown, opts.height ?? 260, width, opts.levels ?? []);
    clear(box, el, legend());
  };
  new ResizeObserver(() => {
    const w = Math.max(300, Math.round(box.clientWidth));
    if (Math.abs(w - width) > 4) {
      width = w;
      draw();
    }
  }).observe(box);
  const legend = (): HTMLElement | null => {
    if (opts.legend === false) return null;
    if (type === 'pie' || type === 'donut') return null;
    if (data.series.length < 2) return null;
    return h(
      'div',
      { class: 'chart-legend' },
      data.series.map((s, i) => {
        const item = h('span', { class: `item${hidden.has(i) ? ' off' : ''}`, role: 'button', tabindex: 0 }, h('span', { class: 'sw', style: { background: color(i) } }), s.name);
        item.addEventListener('click', () => {
          if (hidden.has(i)) hidden.delete(i);
          else if (hidden.size < data.series.length - 1) hidden.add(i);
          draw();
        });
        return item;
      }),
    );
  };
  draw();
  return box;
}

function cartesian(type: ChartType, data: ChartData, height: number, W: number, levels: Level[] = []): SVGSVGElement {
  const H = height;
  // Room on the right for the names of the levels, when there are any.
  const m = { top: 12, right: levels.some((l) => l.title) ? 96 : 12, bottom: 44, left: 52 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const stacked = type === 'stacked';
  const n = data.labels.length;
  let max = 0;
  let min = 0;
  for (let i = 0; i < n; i++) {
    if (stacked) {
      const pos = data.series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0);
      const neg = data.series.reduce((a, s) => a + Math.min(0, s.values[i] ?? 0), 0);
      max = Math.max(max, pos);
      min = Math.min(min, neg);
    } else
      for (const s of data.series) {
        max = Math.max(max, s.values[i] ?? 0);
        min = Math.min(min, s.values[i] ?? 0);
      }
  }
  // Levels inside the reach of the data widen the axis to show them; one far away would flatten the data.
  const span = Math.max(1, max - min);
  const shownLevels = levels.filter((l) => l.value >= min - span && l.value <= max + span);
  for (const l of shownLevels) {
    max = Math.max(max, l.value);
    min = Math.min(min, l.value);
  }
  const ticks = niceTicks(max, min);
  const top = ticks[ticks.length - 1]!;
  const bottom = ticks[0]!;
  const y = (v: number) => m.top + ih - ((v - bottom) / (top - bottom)) * ih;
  const root = svg('svg', { class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (const tick of ticks) {
    root.appendChild(svg('line', { class: tick === 0 ? 'axis' : 'gridline', x1: m.left, x2: W - m.right, y1: y(tick), y2: y(tick) }));
    root.appendChild(svg('text', { x: m.left - 6, y: y(tick) + 4, 'text-anchor': 'end' }, short(tick)));
  }
  const band = iw / n;
  const every = Math.max(1, Math.ceil(n / Math.floor(iw / 64)));
  data.labels.forEach((label, i) => {
    if (i % every) return;
    const text = label.length > 14 ? `${label.slice(0, 13)}…` : label;
    root.appendChild(svg('text', { x: m.left + band * i + band / 2, y: H - m.bottom + 16, 'text-anchor': 'middle' }, text));
  });
  // Levels: a hairline in muted ink, named at the right end in text colour — never in a series colour.
  // A name that would sit on the one before is left out: the tooltip of the line still has the value.
  let lastLabel = -Infinity;
  for (const l of [...shownLevels].sort((a, b) => b.value - a.value)) {
    if (l.value === 0 && !l.title) continue;
    root.appendChild(svg('line', { class: 'level', x1: m.left, x2: W - m.right, y1: y(l.value), y2: y(l.value) }));
    if (l.title && y(l.value) - lastLabel >= 13) {
      root.appendChild(svg('text', { class: 'level-label', x: W - m.right + 6, y: y(l.value) + 4 }, l.title.length > 14 ? `${l.title.slice(0, 13)}…` : l.title));
      lastLabel = y(l.value);
    }
  }
  const tipLines = (i: number) => [h('strong', null, data.labels[i] ?? ''), ...data.series.filter((s) => s.values[i] !== null).map((s) => `${data.series.length > 1 ? `${s.name}: ` : ''}${formatNumber(s.values[i] ?? 0)}`)];
  if (type === 'line' || type === 'area') {
    const x = (i: number) => m.left + band * i + band / 2;
    data.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => (v === null ? null : ([x(i), y(v)] as const)));
      const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), '');
      if (type === 'area' && data.series.length === 1) {
        const first = pts.findIndex((p) => p);
        const last = pts.length - 1 - [...pts].reverse().findIndex((p) => p);
        root.appendChild(svg('path', { d: `${d}L${x(last)},${y(Math.max(0, bottom))}L${x(first)},${y(Math.max(0, bottom))}Z`, fill: color(si), opacity: 0.16 }));
      }
      root.appendChild(svg('path', { d, fill: 'none', stroke: color(si), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (n <= 40) pts.forEach((p) => p && root.appendChild(svg('circle', { cx: p[0], cy: p[1], r: 3.5, fill: color(si), stroke: 'var(--surface)', 'stroke-width': 2 })));
    });
    const cross = svg('line', { class: 'axis', x1: 0, x2: 0, y1: m.top, y2: m.top + ih, opacity: 0 });
    root.appendChild(cross);
    // One hit area over the plot: the crosshair snaps to the nearest point, however many there are.
    const hit = svg('rect', { x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => {
      const box = root.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      const i = Math.min(n - 1, Math.max(0, Math.floor((px - m.left) / band)));
      cross.setAttribute('x1', String(x(i)));
      cross.setAttribute('x2', String(x(i)));
      cross.setAttribute('opacity', '1');
      showTip(e, tipLines(i));
    });
    hit.addEventListener('mouseleave', () => {
      cross.setAttribute('opacity', '0');
      hideTip();
    });
    root.appendChild(hit);
    return root;
  }
  // Bars: grouped side by side, or stacked; 2px gaps, 4px rounding at the data end.
  const groups = stacked ? 1 : data.series.length;
  const inner = Math.min(48, (band * 0.72) / groups);
  for (let i = 0; i < n; i++) {
    let pos = 0;
    let neg = 0;
    data.series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || v === undefined || v === 0) return;
      let from: number;
      let to: number;
      if (stacked) {
        from = v > 0 ? pos : neg;
        to = from + v;
        if (v > 0) pos = to;
        else neg = to;
      } else {
        from = 0;
        to = v;
      }
      const x0 = m.left + band * i + (band - inner * groups) / 2 + (stacked ? 0 : si * inner);
      const w = Math.max(2, inner - 2);
      const yTop = Math.min(y(from), y(to));
      const hgt = Math.max(1, Math.abs(y(to) - y(from)) - (stacked ? 2 : 0));
      root.appendChild(svg('path', { d: roundedBar(x0, stacked && v > 0 ? yTop + 2 : yTop, w, hgt, v > 0 ? 'top' : 'bottom'), fill: color(si) }));
    });
    const hit = svg('rect', { x: m.left + band * i, y: m.top, width: band, height: ih, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => showTip(e, tipLines(i)));
    hit.addEventListener('mouseleave', hideTip);
    root.appendChild(hit);
  }
  return root;
}

function roundedBar(x: number, y: number, w: number, hgt: number, end: 'top' | 'bottom' | 'right'): string {
  const r = Math.min(4, w / 2, hgt);
  if (end === 'top') return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  if (end === 'bottom') return `M${x},${y}V${y + hgt - r}Q${x},${y + hgt} ${x + r},${y + hgt}H${x + w - r}Q${x + w},${y + hgt} ${x + w},${y + hgt - r}V${y}Z`;
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}

/** Horizontal bars: long category names read better along the bar. One series, sorted as given. */
function hbars(data: ChartData, W: number): SVGSVGElement {
  const s = data.series[0]!;
  const rowH = 24;
  const labelW = Math.min(220, Math.max(110, W * 0.28));
  const H = data.labels.length * rowH + 8;
  const max = Math.max(...s.values.map((v) => v ?? 0), 0) || 1;
  const iw = W - labelW - 70;
  const root = svg('svg', { class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  data.labels.forEach((label, i) => {
    const v = s.values[i] ?? 0;
    const yy = i * rowH + 4;
    root.appendChild(svg('text', { x: labelW - 8, y: yy + 15, 'text-anchor': 'end' }, label.length > 26 ? `${label.slice(0, 25)}…` : label));
    const w = Math.max(2, (Math.max(0, v) / max) * iw);
    root.appendChild(svg('path', { d: roundedBar(labelW, yy + 3, w, rowH - 8, 'right'), fill: color(0) }));
    root.appendChild(svg('text', { x: labelW + w + 6, y: yy + 15 }, short(v)));
    const hit = svg('rect', { x: 0, y: yy, width: W, height: rowH, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => showTip(e, [h('strong', null, label), formatNumber(v)]));
    hit.addEventListener('mouseleave', hideTip);
    root.appendChild(hit);
  });
  return root;
}

function pie(data: ChartData, donut: boolean, W: number): SVGSVGElement {
  const s = data.series[0]!;
  const values = s.values.map((v) => Math.max(0, v ?? 0));
  const sum = values.reduce((a, b) => a + b, 0) || 1;
  const H = 260;
  const cx = 140;
  const cy = H / 2;
  const R = 110;
  const r0 = donut ? 62 : 0;
  const root = svg('svg', { class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  let a = -Math.PI / 2;
  values.forEach((v, i) => {
    if (!v) return;
    const a1 = a + (v / sum) * Math.PI * 2;
    const large = a1 - a > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${(cx + Math.cos(ang) * rad).toFixed(2)},${(cy + Math.sin(ang) * rad).toFixed(2)}`;
    const d =
      v === sum
        ? donut
          ? `M${cx - R},${cy}A${R},${R} 0 1 1 ${cx + R},${cy}A${R},${R} 0 1 1 ${cx - R},${cy}M${cx - r0},${cy}A${r0},${r0} 0 1 0 ${cx + r0},${cy}A${r0},${r0} 0 1 0 ${cx - r0},${cy}Z`
          : `M${cx - R},${cy}A${R},${R} 0 1 1 ${cx + R},${cy}A${R},${R} 0 1 1 ${cx - R},${cy}Z`
        : donut
          ? `M${p(a, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r0)}A${r0},${r0} 0 ${large} 0 ${p(a, r0)}Z`
          : `M${cx},${cy}L${p(a, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}Z`;
    const slice = svg('path', { d, fill: color(i), stroke: 'var(--surface)', 'stroke-width': 2 });
    slice.addEventListener('mousemove', (e) => showTip(e, [h('strong', null, data.labels[i] ?? ''), `${formatNumber(v)} · ${formatNumber((v / sum) * 100, 1)}%`]));
    slice.addEventListener('mouseleave', hideTip);
    root.appendChild(slice);
    a = a1;
  });
  if (donut) root.appendChild(svg('text', { x: cx, y: cy + 5, 'text-anchor': 'middle', style: 'font-size:15px;font-weight:600;fill:var(--text)' }, short(sum)));
  // The legend beside a pie names every slice with its share: identity is never colour alone.
  data.labels.forEach((label, i) => {
    const yy = 24 + i * 26;
    if (yy > H - 10) return;
    root.appendChild(svg('rect', { x: 290, y: yy - 10, width: 12, height: 12, rx: 3, fill: color(i) }));
    root.appendChild(svg('text', { x: 310, y: yy }, `${label.length > 30 ? `${label.slice(0, 29)}…` : label}`));
    root.appendChild(svg('text', { x: Math.min(W - 10, 600), y: yy, 'text-anchor': 'end' }, `${formatNumber(((values[i] ?? 0) / sum) * 100, 1)}%`));
  });
  return root;
}
