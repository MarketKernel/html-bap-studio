/**
 * The ER diagram of the configuration (Task.md 9.7), drawn as SVG: a box per
 * table with its fields and parts, an arrow from each reference field to the
 * table it refers to, dashed arrows from part fields, and green dotted arrows
 * from a document to the registers it posts to.
 *
 * Positions live in the configuration (`config.diagram`, by table key). When
 * there are none, a layered layout is computed — catalogs on the left, then
 * documents, registers on the right — and kept in memory until the person
 * moves a node or asks for "Auto layout": opening the diagram changes nothing.
 * A node is dragged by its body, the background pans, the wheel zooms around
 * the cursor. Dragging the small handle at the right of a row onto another
 * table creates a reference field to it.
 */
import { t } from '../../core/i18n';
import { allFields, newKey } from '../../core/config/model';
import type { Config, FieldDef, PartDef, TableDef } from '../../core/config/types';
import { button, clear, download, h, rafThrottle, svg } from '../dom';
import { prompt, toast } from '../ui';
import type { Page } from '../app';
import type { Shell } from '../shell';
import { identFrom, openDesigner } from './index';

const W = 220;
const HEAD = 28;
const ROW = 18;
const PART_HEAD = 22;
const PAD = 8;
const COL_GAP = 130;
const ROW_GAP = 32;

interface Pos {
  x: number;
  y: number;
}

/** A row of a node, relative to its top: a field (of the table or of a part) or a part's header. */
interface RowBox {
  y: number;
  field?: FieldDef;
  part?: PartDef;
}

interface NodeBox {
  tb: TableDef;
  h: number;
  rows: RowBox[];
}

function nodeBox(tb: TableDef): NodeBox {
  const rows: RowBox[] = [];
  let y = HEAD + 4;
  for (const f of tb.fields) {
    rows.push({ y, field: f });
    y += ROW;
  }
  for (const part of tb.parts ?? []) {
    rows.push({ y, part });
    y += PART_HEAD;
    for (const f of part.fields) {
      rows.push({ y, field: f, part });
      y += ROW;
    }
  }
  return { tb, h: y + PAD, rows };
}

/** Shortens text to about `px` pixels (an estimate: the diagram has no layout pass of its own). */
function fit(text: string, px: number, charW = 6.3): string {
  const max = Math.floor(px / charW);
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function typeLabel(f: FieldDef): string {
  if (f.type === 'ref') return `→ ${f.ref ?? '?'}`;
  if (f.type === 'enum') return f.enum ? `enum ${f.enum}` : 'enum';
  if (f.computed) return `= ${f.type}`;
  return f.type;
}

/**
 * The automatic layout: catalogs and plain tables in columns on the left (a
 * table referenced by another goes left of it), documents next, registers on
 * the right. Within a column, tables are ordered by where the tables they
 * refer to sit, which uncrosses most arrows. Deterministic for a configuration.
 */
function autoLayout(config: Config): Record<string, Pos> {
  const tables = config.tables;
  const byName = new Map(tables.map((tb) => [tb.name, tb]));
  const refsOf = (tb: TableDef) => [...tb.fields, ...(tb.parts ?? []).flatMap((p) => p.fields)].filter((f) => f.type === 'ref' && f.ref && f.ref !== tb.name).map((f) => byName.get(f.ref!)).filter((x): x is TableDef => !!x);
  const base = (tb: TableDef) => tb.kind === 'catalog' || tb.kind === 'table';
  const level = new Map<string, number>();
  const levelOf = (tb: TableDef, seen: Set<string>): number => {
    const known = level.get(tb.key);
    if (known !== undefined) return known;
    if (seen.has(tb.key)) return 0;
    seen.add(tb.key);
    const deps = refsOf(tb).filter(base);
    const v = deps.length ? 1 + Math.max(...deps.map((d) => levelOf(d, seen))) : 0;
    seen.delete(tb.key);
    level.set(tb.key, v);
    return v;
  };
  const columns: TableDef[][] = [];
  const put = (col: number, tb: TableDef) => (columns[col] ??= []).push(tb);
  const baseCols = tables.filter(base).reduce((m, tb) => Math.max(m, levelOf(tb, new Set()) + 1), 0);
  for (const tb of tables.filter(base)) put(level.get(tb.key)!, tb);
  for (const tb of tables.filter((x) => x.kind === 'document')) put(baseCols, tb);
  for (const tb of tables.filter((x) => x.kind === 'register')) put(baseCols + (tables.some((x) => x.kind === 'document') ? 1 : 0), tb);
  const heights = new Map(tables.map((tb) => [tb.key, nodeBox(tb).h]));
  const pos: Record<string, Pos> = {};
  const center = (tb: TableDef) => pos[tb.key]!.y + heights.get(tb.key)! / 2;
  const colHeights: number[] = [];
  columns.forEach((col, i) => {
    if (!col) return;
    const order = col.map((tb, index) => {
      const placed = [...refsOf(tb), ...tables.filter((x) => x.posting?.some((p) => p.register === tb.name))].filter((x) => pos[x.key]);
      return { tb, index, key: placed.length ? placed.reduce((s, x) => s + center(x), 0) / placed.length : Number.POSITIVE_INFINITY };
    });
    order.sort((a, b) => a.key - b.key || a.index - b.index);
    let y = 0;
    for (const { tb } of order) {
      pos[tb.key] = { x: i * (W + COL_GAP), y };
      y += heights.get(tb.key)! + ROW_GAP;
    }
    colHeights[i] = y - ROW_GAP;
  });
  // Columns centred on the tallest one.
  const tallest = Math.max(0, ...colHeights.filter((x) => x !== undefined));
  columns.forEach((col, i) => {
    const shift = Math.round((tallest - (colHeights[i] ?? tallest)) / 2);
    for (const tb of col ?? []) pos[tb.key]!.y += shift;
  });
  for (const p of Object.values(pos)) {
    p.x = Math.round(p.x);
    p.y = Math.round(p.y);
  }
  return pos;
}

/** Marks a toolbar button with what it does, for tests and for styling. */
function cmd(name: string, b: HTMLButtonElement): HTMLButtonElement {
  b.dataset.cmd = name;
  return b;
}

export class DiagramPage implements Page {
  readonly id = 'design:diagram';
  title = '';
  icon = 'diagram';
  readonly el: HTMLElement;
  private er: HTMLElement;
  private svgEl: SVGSVGElement;
  private viewport: SVGGElement;
  private edgesEl: SVGGElement;
  private nodesEl: SVGGElement;
  private pos = new Map<string, Pos>();
  private boxes = new Map<string, NodeBox>();
  private view = { x: 40, y: 40, k: 1 };
  private fitted = false;
  private front: string | null = null;

  constructor(private readonly shell: Shell) {
    this.title = t('diagram', 'Schema diagram');
    this.edgesEl = svg('g', { class: 'edges' });
    this.nodesEl = svg('g', { class: 'nodes' });
    this.viewport = svg('g', { class: 'viewport' }, this.edgesEl, this.nodesEl);
    this.svgEl = svg(
      'svg',
      { xmlns: 'http://www.w3.org/2000/svg', class: 'er-svg' },
      svg(
        'defs',
        {},
        svg('marker', { id: 'er-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M0,1 L9,5 L0,9 z', class: 'arrow' })),
        svg('marker', { id: 'er-arrow-posting', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M0,1 L9,5 L0,9 z', class: 'arrow posting' })),
      ),
      this.viewport,
    );
    this.er = h(
      'div',
      { class: 'er' },
      this.svgEl,
      h(
        'div',
        { class: 'er-legend' },
        h('span', null, h('i', { class: 'ln ref' }), t('diagram', 'reference')),
        h('span', null, h('i', { class: 'ln part' }), t('diagram', 'reference from a part')),
        h('span', null, h('i', { class: 'ln posting' }), t('diagram', 'posting to a register')),
        h('span', { class: 'muted' }, t('diagram', 'Drag the dot at the right of a row onto a table to add a reference')),
      ),
    );
    this.el = h(
      'div',
      { class: 'page diagram-page' },
      h(
        'div',
        { class: 'toolbar' },
        h('span', { class: 'page-title' }, this.title),
        h('span', { class: 'spacer' }),
        cmd('fit', button(t('diagram', 'Fit'), { icon: 'maximize', onClick: () => this.fit() })),
        cmd('layout', button(t('diagram', 'Auto layout'), { icon: 'diagram', onClick: () => void this.relayout() })),
        cmd('svg', button(t('diagram', 'Export SVG'), { icon: 'download', onClick: () => this.exportSvg() })),
        cmd('png', button(t('diagram', 'Export PNG'), { icon: 'download', onClick: () => void this.exportPng() })),
      ),
      this.er,
    );
    this.wire();
    this.render();
  }

  onShow(): void {
    if (!this.fitted) requestAnimationFrame(() => this.fit());
  }

  configChanged(): void {
    this.render();
  }

  /* ------------------------------ drawing ------------------------------ */

  private render(): void {
    const config = this.shell.session.config;
    this.boxes = new Map(config.tables.map((tb) => [tb.key, nodeBox(tb)]));
    this.pos = new Map();
    const saved = config.diagram ?? {};
    const missing = config.tables.filter((tb) => !saved[tb.key]);
    const auto = missing.length === config.tables.length ? autoLayout(config) : null;
    for (const tb of config.tables) {
      const p = saved[tb.key] ?? auto?.[tb.key];
      if (p) this.pos.set(tb.key, { x: p.x, y: p.y });
    }
    // Tables added after the diagram was arranged go in a row under it.
    if (!auto && missing.length) {
      const placed = [...this.pos.entries()];
      let x = Math.min(0, ...placed.map(([, p]) => p.x));
      const y = Math.max(0, ...placed.map(([k, p]) => p.y + (this.boxes.get(k)?.h ?? 0))) + ROW_GAP * 2;
      for (const tb of missing) {
        this.pos.set(tb.key, { x, y });
        x += W + ROW_GAP;
      }
    }
    // The node moved last stays on top of the ones it was dropped over.
    const order = [...config.tables.filter((tb) => tb.key !== this.front), ...config.tables.filter((tb) => tb.key === this.front)];
    clear(this.nodesEl, ...order.map((tb) => this.node(tb)));
    this.drawEdges();
    this.applyView();
  }

  private node(tb: TableDef): SVGGElement {
    const box = this.boxes.get(tb.key)!;
    const p = this.pos.get(tb.key)!;
    const g = svg('g', { class: `node ${tb.kind}`, 'data-key': tb.key, 'data-table': tb.name, transform: `translate(${p.x},${p.y})` });
    g.append(
      svg('title', {}, `${tb.title} (${tb.name}) — ${t('diagram', 'double click to design')}`),
      svg('rect', { class: 'box', x: 0, y: 0, width: W, height: box.h, rx: 7 }),
      svg('rect', { class: 'head', x: 0, y: 0, width: W, height: HEAD, rx: 7 }),
      svg('rect', { class: 'head', x: 0, y: HEAD - 8, width: W, height: 8 }),
      svg('text', { class: 'title', x: 10, y: 18 }, fit(tb.title, W - 70, 7.2)),
      svg('text', { class: 'kind', x: W - 10, y: 18, 'text-anchor': 'end' }, fit(tb.name, 60, 6)),
      svg('circle', { class: 'handle', cx: W, cy: HEAD / 2, r: 5, 'data-handle': '' }),
    );
    for (const row of box.rows) {
      if (!row.field && row.part) {
        g.append(
          svg('line', { class: 'sep', x1: 0, x2: W, y1: row.y + 3, y2: row.y + 3 }),
          svg('text', { class: 'part', x: 10, y: row.y + 16 }, fit(`▾ ${row.part.title ?? row.part.name}`, W - 20)),
          svg('text', { class: 'type', x: W - 10, y: row.y + 16, 'text-anchor': 'end' }, t('diagram', 'part')),
        );
        continue;
      }
      const f = row.field!;
      const indent = row.part ? 20 : 10;
      g.append(
        svg('rect', { class: 'row-hit', x: 0, y: row.y, width: W, height: ROW }),
        svg('text', { class: `fname${f.required ? ' req' : ''}`, x: indent, y: row.y + 13 }, fit(f.name, W / 2 - indent + 10)),
        svg('text', { class: `type${f.type === 'ref' ? ' ref' : ''}`, x: W - 12, y: row.y + 13, 'text-anchor': 'end' }, fit(typeLabel(f), W / 2 - 14)),
        svg('circle', { class: 'handle', cx: W, cy: row.y + ROW / 2, r: 4, 'data-handle': row.part ? row.part.name : '' }),
      );
    }
    return g;
  }

  private drawEdges(): void {
    const config = this.shell.session.config;
    const byName = new Map(config.tables.map((tb) => [tb.name, tb]));
    const edges: SVGElement[] = [];
    for (const tb of config.tables) {
      const box = this.boxes.get(tb.key)!;
      const from = this.pos.get(tb.key)!;
      for (const row of box.rows) {
        const f = row.field;
        if (!f || f.type !== 'ref' || !f.ref) continue;
        const target = byName.get(f.ref);
        if (!target) continue;
        // A catalog's own "parent" is drawn by its tree, not by an arrow back to itself.
        if (target.key === tb.key && f.name === 'parent') continue;
        const d = this.edgePath(from, from.y + row.y + ROW / 2, target);
        edges.push(svg('path', { class: `edge${row.part ? ' part' : ''}`, d, 'marker-end': 'url(#er-arrow)', 'data-from': tb.key, 'data-to': target.key }));
      }
      for (const register of new Set((tb.posting ?? []).map((p) => p.register))) {
        const target = byName.get(register);
        if (!target) continue;
        const d = this.edgePath(from, from.y + HEAD / 2, target);
        edges.push(svg('path', { class: 'edge posting', d, 'marker-end': 'url(#er-arrow-posting)', 'data-from': tb.key, 'data-to': target.key }));
      }
    }
    clear(this.edgesEl, ...edges);
  }

  /** A curve from a point on the side of a node to the side of the target's header. */
  private edgePath(from: Pos, sy: number, target: TableDef): string {
    const to = this.pos.get(target.key)!;
    const ty = to.y + HEAD / 2;
    if (to === from) {
      // To itself: a loop out of the right side and back into the header.
      const x = from.x + W;
      return `M${x},${sy} C${x + 60},${sy} ${x + 60},${ty} ${x},${ty}`;
    }
    const dx = to.x - from.x;
    const right = dx >= 0;
    const sx = right ? from.x + W : from.x;
    // Stacked nodes (columns overlap): leave and enter on the same side, as a bracket.
    const stacked = Math.abs(dx) < W * 0.75;
    const ex = stacked ? (right ? to.x + W : to.x) : right ? to.x : to.x + W;
    const bend = stacked ? 50 + Math.min(60, Math.abs(sy - ty) / 8) : Math.max(40, Math.abs(ex - sx) / 2);
    const c1 = sx + (right ? bend : -bend);
    const c2 = stacked ? ex + (right ? bend : -bend) : ex + (right ? -bend : bend);
    return `M${sx},${sy} C${c1},${sy} ${c2},${ty} ${ex},${ty}`;
  }

  private applyView(): void {
    this.viewport.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
  }

  /** The bounding box of every node, in diagram units. */
  private bounds(): { x: number; y: number; w: number; h: number } | null {
    if (!this.pos.size) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [key, p] of this.pos) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + W + 40);
      y1 = Math.max(y1, p.y + (this.boxes.get(key)?.h ?? 0));
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  fit(): void {
    const b = this.bounds();
    const r = this.svgEl.getBoundingClientRect();
    if (!b || !r.width || !r.height) return;
    this.fitted = true;
    const k = Math.min(1.25, (r.width - 48) / b.w, (r.height - 48) / b.h);
    this.view = { k, x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - b.h * k) / 2 - b.y * k };
    this.applyView();
  }

  /* ------------------------------ saving ------------------------------ */

  /** Writes every position (the computed ones too, so the layout stays as seen) in one change. */
  private save(): Promise<void> {
    const positions = Object.fromEntries([...this.pos].map(([k, p]) => [k, { x: Math.round(p.x), y: Math.round(p.y) }]));
    return this.shell.session
      .change((c) => {
        const keys = new Set(c.tables.map((tb) => tb.key));
        c.diagram = Object.fromEntries(Object.entries(positions).filter(([k]) => keys.has(k)));
      })
      .then(() => undefined)
      .catch((e: unknown) => this.shell.fail(e));
  }

  private async relayout(): Promise<void> {
    const layout = autoLayout(this.shell.session.config);
    this.pos = new Map(Object.entries(layout));
    await this.save();
    this.fit();
  }

  /* ------------------------------ mouse ------------------------------ */

  private wire(): void {
    const toDiagram = (e: { clientX: number; clientY: number }): Pos => {
      const r = this.svgEl.getBoundingClientRect();
      return { x: (e.clientX - r.left - this.view.x) / this.view.k, y: (e.clientY - r.top - this.view.y) / this.view.k };
    };
    const redrawEdges = rafThrottle(() => this.drawEdges());

    this.svgEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.svgEl.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const k = Math.min(3, Math.max(0.15, this.view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      // The point under the cursor stays under it.
      this.view = { k, x: cx - ((cx - this.view.x) * k) / this.view.k, y: cy - ((cy - this.view.y) * k) / this.view.k };
      this.applyView();
    }, { passive: false });

    this.svgEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      const nodeEl = target.closest<SVGGElement>('.node');
      const handle = target.closest('.handle');
      this.svgEl.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY };
      let move: (m: PointerEvent) => void;
      let up: (m: PointerEvent) => void;
      if (nodeEl && handle) {
        // Drawing a new reference from this table (or its part) to the table it is dropped on.
        const key = nodeEl.dataset.key!;
        const part = handle.getAttribute('data-handle') || undefined;
        const origin = toDiagram(e);
        const line = svg('path', { class: 'edge link-temp', 'marker-end': 'url(#er-arrow)' });
        this.viewport.appendChild(line);
        move = (m) => {
          const p = toDiagram(m);
          line.setAttribute('d', `M${origin.x},${origin.y} C${origin.x + 60},${origin.y} ${p.x - 60},${p.y} ${p.x},${p.y}`);
          this.er.querySelectorAll('.node.drop').forEach((n) => n.classList.remove('drop'));
          (document.elementFromPoint(m.clientX, m.clientY)?.closest('.node') as Element | null)?.classList.add('drop');
        };
        up = (m) => {
          line.remove();
          this.er.querySelectorAll('.node.drop').forEach((n) => n.classList.remove('drop'));
          const over = document.elementFromPoint(m.clientX, m.clientY)?.closest<SVGGElement>('.node');
          if (over && Math.hypot(m.clientX - start.x, m.clientY - start.y) > 6) void this.link(key, part, over.dataset.key!);
        };
      } else if (nodeEl) {
        const key = nodeEl.dataset.key!;
        const p0 = { ...this.pos.get(key)! };
        let moved = false;
        move = (m) => {
          const dx = (m.clientX - start.x) / this.view.k;
          const dy = (m.clientY - start.y) / this.view.k;
          if (!moved) {
            if (Math.hypot(m.clientX - start.x, m.clientY - start.y) < 3) return;
            // Bring the node to the front — only once it moves: re-inserting it on press would cancel a double click.
            moved = true;
            this.front = key;
            this.nodesEl.appendChild(nodeEl);
            nodeEl.classList.add('dragging');
          }
          const p = { x: Math.round(p0.x + dx), y: Math.round(p0.y + dy) };
          this.pos.set(key, p);
          nodeEl.setAttribute('transform', `translate(${p.x},${p.y})`);
          redrawEdges();
        };
        up = () => {
          nodeEl.classList.remove('dragging');
          if (moved) void this.save();
        };
      } else {
        const v0 = { ...this.view };
        this.er.classList.add('panning');
        move = (m) => {
          this.view = { ...v0, x: v0.x + m.clientX - start.x, y: v0.y + m.clientY - start.y };
          this.applyView();
        };
        up = () => this.er.classList.remove('panning');
      }
      const finish = (m: PointerEvent) => {
        this.svgEl.removeEventListener('pointermove', move);
        this.svgEl.removeEventListener('pointerup', finish);
        this.svgEl.removeEventListener('pointercancel', finish);
        up(m);
      };
      this.svgEl.addEventListener('pointermove', move);
      this.svgEl.addEventListener('pointerup', finish);
      this.svgEl.addEventListener('pointercancel', finish);
    });

    this.svgEl.addEventListener('dblclick', (e) => {
      // The pointer is captured by the svg while pressed, so the event's target is the svg: look under the pointer.
      const nodeEl = document.elementFromPoint(e.clientX, e.clientY)?.closest<SVGGElement>('.node');
      if (nodeEl?.dataset.table) openDesigner(this.shell, { kind: 'table', name: nodeEl.dataset.table });
    });

    // The arrows of the table under the mouse stand out.
    const highlight = (key: string | null) => this.edgesEl.querySelectorAll<SVGPathElement>('.edge').forEach((p) => p.classList.toggle('hl', !!key && (p.dataset.from === key || p.dataset.to === key)));
    this.svgEl.addEventListener('pointerover', (e) => highlight((e.target as Element).closest<SVGGElement>('.node')?.dataset.key ?? null));
    this.svgEl.addEventListener('pointerleave', () => highlight(null));
  }

  /** Adds a reference field to `fromKey` (or its part) pointing at `toKey`. */
  private async link(fromKey: string, part: string | undefined, toKey: string): Promise<void> {
    const config = this.shell.session.config;
    const from = config.tables.find((tb) => tb.key === fromKey);
    const to = config.tables.find((tb) => tb.key === toKey);
    if (!from || !to) return;
    const where = part ? `${from.title} → ${(from.parts ?? []).find((p) => p.name === part)?.title ?? part}` : from.title;
    const title = await prompt(t('diagram', 'New reference in “{table}” to “{target}”', { table: where, target: to.title }), t('diagram', 'Field title'), to.itemTitle ?? to.title);
    if (!title) return;
    const existing = part ? ((from.parts ?? []).find((p) => p.name === part)?.fields ?? []) : allFields(from);
    const base = identFrom(title, false);
    let name = base;
    for (let n = 2; existing.some((f) => f.name === name); n++) name = `${base}${n}`;
    const field: FieldDef = { key: newKey('f'), name, title, type: 'ref', ref: to.name };
    await this.shell.session
      .change((c) => {
        const tb = c.tables.find((x) => x.key === fromKey);
        if (!tb) return;
        if (part) (tb.parts ?? []).find((p) => p.name === part)?.fields.push(field);
        else tb.fields.push(field);
      })
      .then(() => toast(t('diagram', 'Field “{field}” added to “{table}”', { field: title, table: where }), 'ok'))
      .catch((e: unknown) => this.shell.fail(e));
  }

  /* ------------------------------ export ------------------------------ */

  /**
   * The diagram as a standalone SVG: the colours come from CSS variables of
   * the page, so every element gets its computed style inlined, and the view
   * is the whole diagram rather than the current pan and zoom.
   */
  private standalone(): { text: string; width: number; height: number } | null {
    const b = this.bounds();
    if (!b) return null;
    // Hover highlights are not part of the picture.
    this.edgesEl.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl'));
    const clone = this.svgEl.cloneNode(true) as SVGSVGElement;
    const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style'];
    const original = [...this.svgEl.querySelectorAll('*')];
    const copies = [...clone.querySelectorAll('*')];
    original.forEach((el, i) => {
      const copy = copies[i] as SVGElement | undefined;
      if (!copy || el.tagName === 'title') return;
      const cs = getComputedStyle(el);
      copy.setAttribute('style', props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
      copy.removeAttribute('class');
    });
    clone.querySelectorAll('[data-handle], .row-hit, title, .link-temp').forEach((el) => el.remove());
    const pad = 24;
    const width = Math.ceil(b.w + pad * 2);
    const height = Math.ceil(b.h + pad * 2);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${width} ${height}`);
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.removeAttribute('class');
    // The svg's only g child is the viewport, with the pan and zoom.
    clone.querySelector(':scope > g')?.removeAttribute('transform');
    clone.insertBefore(svg('rect', { x: b.x - pad, y: b.y - pad, width, height, fill: getComputedStyle(this.er).backgroundColor }), clone.querySelector(':scope > g'));
    return { text: new XMLSerializer().serializeToString(clone), width, height };
  }

  private fileName(ext: string): string {
    return `${identFrom(this.shell.session.config.app.name) || 'schema'}-schema.${ext}`;
  }

  private exportSvg(): void {
    const out = this.standalone();
    if (out) download(new Blob([out.text], { type: 'image/svg+xml' }), this.fileName('svg'));
  }

  private async exportPng(): Promise<void> {
    const out = this.standalone();
    if (!out) return;
    try {
      const url = URL.createObjectURL(new Blob([out.text], { type: 'image/svg+xml' }));
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(t('diagram', 'The picture could not be drawn')));
        img.src = url;
      });
      const scale = 2;
      const canvas = h('canvas', { width: out.width * scale, height: out.height * scale });
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, out.width, out.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) download(blob, this.fileName('png'));
    } catch (error) {
      this.shell.fail(error);
    }
  }
}
