/**
 * Editors for every field type, the reference field with its lookup, and the
 * grid columns made from a table's fields — shared by lists, cards, parts and
 * dialogs, so a field looks and behaves the same everywhere.
 */
import { language, t } from '../core/i18n';
import { enumValues, fieldAtPath, fieldTitle, isNumeric, table as tableOf } from '../core/config/model';
import type { ColumnDef, Config, FieldDef, TableDef } from '../core/config/types';
import type { DataService } from '../core/data';
import { evalArithmetic, formatNumber, formatValue, parseNumber, scaled, scheduleText, weekdayName } from '../core/format';
import { readSchedule } from '../core/schedule';
import type { Row } from '../core/query/types';
import type { QuickKind } from '../core/query/index';
import { button, clear, h, icon } from './dom';
import type { App } from './app';
import type { GridColumn } from './grid';

export interface Editor {
  el: HTMLElement;
  /** The input to focus. */
  focus(): void;
  set(value: unknown): void;
  setError(message: string | null): void;
  setReadonly(readonly: boolean): void;
}

export function quickKind(f: FieldDef | undefined): QuickKind {
  if (!f) return 'text';
  if (isNumeric(f)) return 'number';
  if (f.type === 'date' || f.type === 'datetime') return 'date';
  if (f.type === 'boolean') return 'boolean';
  return 'text';
}

/** An editor for one field; `onChange` gets the parsed value (null for empty). */
export function editorFor(app: App, f: FieldDef, value: unknown, onChange: (v: unknown) => void, opts: { compact?: boolean } = {}): Editor {
  const config = app.data.config;
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  let root: HTMLElement;
  let set: (v: unknown) => void;
  const cls = `input${opts.compact ? ' cell-edit' : ''}`;
  // How far along: shown, not typed.
  if (f.display === 'progress' && (f.computed || f.readonly === true)) {
    const el = progressBar(value);
    const holder = h('div', { class: 'progress-field', 'data-field': f.name }, el);
    return { el: holder, focus: () => {}, set: (v) => clear(holder, progressBar(v)), setError: () => {}, setReadonly: () => {} };
  }
  switch (f.type) {
    case 'boolean': {
      const box = h('input', { type: 'checkbox', 'data-field': f.name });
      box.checked = value === true;
      box.addEventListener('change', () => onChange(box.checked));
      input = box;
      root = h('div', { style: { paddingTop: opts.compact ? '0' : '5px' } }, box);
      set = (v) => (box.checked = v === true);
      break;
    }
    case 'enum': {
      const select = h('select', { class: cls, 'data-field': f.name });
      select.appendChild(h('option', { value: '' }, ''));
      for (const e of enumValues(config, f)) select.appendChild(h('option', { value: e.value }, e.title));
      select.value = value === null || value === undefined ? '' : String(value);
      select.addEventListener('change', () => onChange(select.value || null));
      input = select;
      root = select;
      set = (v) => (select.value = v === null || v === undefined ? '' : String(v));
      break;
    }
    case 'ref': {
      const target = tableOf(config, f.ref);
      if (!target) {
        root = input = h('input', { class: cls, readonly: true, value: String(value ?? '') });
        set = () => {};
        break;
      }
      const lookup = new Lookup(app, target, value === null || value === undefined ? null : String(value), (id) => onChange(id), opts.compact ?? false);
      lookup.input.dataset.field = f.name;
      input = lookup.input;
      root = lookup.el;
      set = (v) => lookup.set(v === null || v === undefined ? null : String(v));
      break;
    }
    case 'text':
    case 'json': {
      const area = h('textarea', { class: cls, rows: 3, 'data-field': f.name });
      area.value = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      area.addEventListener('input', () => onChange(area.value === '' ? null : area.value));
      input = area;
      root = area;
      set = (v) => (area.value = v === null || v === undefined ? '' : String(v));
      break;
    }
    case 'integer':
    case 'decimal': {
      const box = h('input', { class: `${cls} num`, inputmode: 'decimal', 'data-field': f.name, autocomplete: 'off' });
      const show = (v: unknown) => (box.value = typeof v === 'number' ? formatNumber(v, f.type === 'integer' ? 0 : (f.scale ?? 2), f.money === true) : '');
      show(value);
      box.addEventListener('input', () => {
        const n = parseNumber(box.value);
        if (n === null) onChange(null);
        else if (!Number.isNaN(n)) onChange(f.type === 'integer' ? Math.trunc(n) : Number(n.toFixed(f.scale ?? 2)));
        else onChange(box.value);
      });
      box.addEventListener('focus', () => box.select());
      const round = (n: number) => (f.type === 'integer' ? Math.trunc(n) : Number(n.toFixed(f.scale ?? 2)));
      // A sum typed in (1200+350-50*2) becomes its result when the field is left or Enter is pressed.
      const settle = () => {
        const sum = evalArithmetic(box.value);
        if (sum !== null) {
          onChange(round(sum));
          show(round(sum));
          return;
        }
        const n = parseNumber(box.value);
        if (n !== null && !Number.isNaN(n)) show(f.type === 'integer' ? Math.trunc(n) : n);
      };
      box.addEventListener('blur', settle);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') settle();
      });
      input = box;
      root = box;
      set = show;
      break;
    }
    case 'date':
    case 'datetime':
    case 'time': {
      const type = f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : 'datetime-local';
      const box = h('input', { class: cls, type, 'data-field': f.name, step: f.type === 'datetime' ? 1 : undefined });
      const show = (v: unknown) => (box.value = typeof v === 'string' ? (f.type === 'datetime' ? v.slice(0, 19) : v) : '');
      show(value);
      box.addEventListener('change', () => onChange(box.value ? (f.type === 'datetime' && box.value.length === 16 ? `${box.value}:00` : box.value) : null));
      input = box;
      root = box;
      set = show;
      break;
    }
    case 'schedule': {
      const ed = scheduleEditor(f.name, value, onChange, cls);
      input = ed.first;
      root = ed.el;
      set = ed.set;
      break;
    }
    case 'color': {
      const box = h('input', { class: cls, type: 'color', 'data-field': f.name, style: { width: '60px', padding: '2px' } });
      box.value = typeof value === 'string' ? value : '#000000';
      box.addEventListener('input', () => onChange(box.value));
      input = box;
      root = box;
      set = (v) => (box.value = typeof v === 'string' ? v : '#000000');
      break;
    }
    default: {
      const type = f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : f.type === 'phone' ? 'tel' : 'text';
      const box = h('input', { class: cls, type, 'data-field': f.name, maxlength: f.maxLength, autocomplete: 'off' });
      box.value = value === null || value === undefined ? '' : String(value);
      box.addEventListener('input', () => onChange(box.value === '' ? null : box.value));
      input = box;
      root = box;
      set = (v) => (box.value = v === null || v === undefined ? '' : String(v));
    }
  }
  const error = h('div', { class: 'field-error hidden' });
  const wrap = opts.compact ? root : h('div', null, root, error);
  return {
    el: wrap,
    focus: () => input.focus(),
    set,
    setError: (message) => {
      input.classList.toggle('invalid', !!message);
      error.textContent = message ?? '';
      error.classList.toggle('hidden', !message);
    },
    setReadonly: (ro) => {
      if (input instanceof HTMLSelectElement || (input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'color'))) input.disabled = ro;
      else input.readOnly = ro;
      root.querySelectorAll?.('button').forEach((b) => ((b as HTMLButtonElement).disabled = ro));
    },
  };
}

/**
 * The reference field: type to search by the referenced table's display
 * field, pick from the list; … opens the selection list, ↗ the record, × clears.
 */
export class Lookup {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private id: string | null;
  private popup: HTMLElement | null = null;
  private matches: Row[] = [];
  private active = 0;

  constructor(
    private readonly app: App,
    private readonly target: TableDef,
    id: string | null,
    private readonly onChange: (id: string | null) => void,
    compact: boolean,
  ) {
    this.id = id;
    this.input = h('input', { class: `input${compact ? ' cell-edit' : ''}`, autocomplete: 'off', role: 'combobox', 'aria-autocomplete': 'list', placeholder: compact ? '' : t('fields', 'Type to search…') });
    const choose = button(null, { icon: 'more', title: t('fields', 'Choose from the list'), onClick: () => void this.chooseFromList() });
    const open = button(null, { icon: 'external', title: t('fields', 'Open'), onClick: () => this.id && app.openRecord(target.name, this.id) });
    const clearBtn = button(null, { icon: 'x', title: t('fields', 'Clear'), onClick: () => this.pick(null) });
    for (const b of [choose, open, clearBtn]) b.tabIndex = -1;
    this.el = h('div', { class: 'lookup' }, this.input, compact ? null : choose, compact ? null : open, compact ? null : clearBtn);
    void this.showLabel();
    this.input.addEventListener('input', () => void this.search());
    this.input.addEventListener('focus', () => this.input.select());
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('blur', () =>
      setTimeout(() => {
        if (document.activeElement === this.input) return;
        this.close();
        void this.showLabel();
      }, 150),
    );
  }

  set(id: string | null): void {
    this.id = id;
    void this.showLabel();
  }

  private async showLabel() {
    this.input.value = this.id ? await this.app.data.label(this.target.name, this.id) : '';
  }

  private pick(row: Row | null) {
    this.id = row?.id ?? null;
    this.close();
    void this.showLabel();
    this.onChange(this.id);
  }

  private async search() {
    const text = this.input.value.trim().toLocaleLowerCase();
    const rows = [...(await this.app.data.rowsById(this.target.name)).values()].filter((r) => !r.isFolder);
    this.matches = rows
      .map((r) => ({ r, label: this.app.data.rowLabel(this.target, r) }))
      .filter((x) => !text || x.label.toLocaleLowerCase().includes(text))
      .sort((a, b) => {
        const sa = a.label.toLocaleLowerCase().startsWith(text) ? 0 : 1;
        const sb = b.label.toLocaleLowerCase().startsWith(text) ? 0 : 1;
        return sa - sb || a.label.localeCompare(b.label);
      })
      .slice(0, 50)
      .map((x) => x.r);
    this.active = 0;
    this.render(text);
  }

  private render(text: string) {
    if (!this.popup) {
      this.popup = h('div', { class: 'popup', role: 'listbox' });
      document.body.appendChild(this.popup);
    }
    const r = this.input.getBoundingClientRect();
    Object.assign(this.popup.style, { left: `${r.left}px`, top: `${r.bottom + 2}px`, minWidth: `${Math.max(220, r.width)}px` });
    const items: Node[] = this.matches.map((row, i) => {
      const item = h('div', { class: `popup-item${i === this.active ? ' active' : ''}`, role: 'option' }, this.app.data.rowLabel(this.target, row));
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.pick(row);
      });
      return item;
    });
    if (!this.matches.length) items.push(h('div', { class: 'popup-item disabled' }, t('fields', 'Nothing found')));
    if (this.app.data.writable(this.target)) {
      items.push(h('div', { class: 'popup-sep' }));
      const create = h('div', { class: 'popup-item' }, icon('plus'), text ? t('fields', 'Create “{text}”…', { text: this.input.value.trim() }) : t('fields', 'Create…'));
      create.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.close();
        const init: Record<string, unknown> = {};
        const display = this.target.fields.find((f) => f.name === 'name') ?? this.target.fields.find((f) => f.type === 'string');
        if (text && display) init[display.name] = this.input.value.trim();
        this.app.openRecord(this.target.name, null, init, (row) => this.pick(row));
      });
      items.push(create);
    }
    clear(this.popup, ...items);
  }

  private close() {
    this.popup?.remove();
    this.popup = null;
  }

  private key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' && !this.popup) {
      void this.search();
      e.preventDefault();
    } else if (this.popup && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      this.active = Math.max(0, Math.min(this.matches.length - 1, this.active + (e.key === 'ArrowDown' ? 1 : -1)));
      this.render(this.input.value.trim().toLocaleLowerCase());
      e.preventDefault();
    } else if (e.key === 'Enter' && this.popup) {
      const row = this.matches[this.active];
      if (row) this.pick(row);
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Escape' && this.popup) {
      this.close();
      void this.showLabel();
      e.stopPropagation();
    } else if (e.key === 'F4' || (e.key === 'ArrowDown' && e.altKey)) {
      void this.chooseFromList();
      e.preventDefault();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.input.selectionStart === 0 && this.input.selectionEnd === this.input.value.length && this.id) {
      this.pick(null);
      e.preventDefault();
    }
  }

  private async chooseFromList() {
    const rows = await this.app.choose(this.target);
    if (rows?.[0]) this.pick(rows[0]);
    this.input.focus();
  }
}

/** A bar 0–100 with the number beside it. */
export function progressBar(value: unknown): HTMLElement {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  return h('span', { class: 'progress', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, ...(n !== null ? { 'aria-valuenow': n } : {}) }, h('span', { class: 'progress-track' }, h('span', { class: 'progress-fill', style: { width: `${n ?? 0}%` } })), h('span', { class: 'progress-text' }, n === null ? '' : `${formatNumber(n, 0)}%`));
}

/**
 * A schedule as a row of choices: how often, which weekday or day, which
 * month, the time — and, folded behind “from… until…”, its first and last date.
 */
function scheduleEditor(name: string, value: unknown, onChange: (v: unknown) => void, cls: string): { el: HTMLElement; first: HTMLSelectElement; set: (v: unknown) => void } {
  const every = h('select', { class: cls, 'data-field': name, 'data-part': 'every' }, h('option', { value: '' }, '—'), h('option', { value: 'day' }, t('schedule', 'every day')), h('option', { value: 'week' }, t('schedule', 'every week')), h('option', { value: 'month' }, t('schedule', 'every month')), h('option', { value: 'year' }, t('schedule', 'every year')));
  const weekday = h('select', { class: cls, 'data-part': 'weekday' }, [1, 2, 3, 4, 5, 6, 7].map((n) => h('option', { value: String(n) }, weekdayName(n))));
  const month = h('select', { class: cls, 'data-part': 'month' }, Array.from({ length: 12 }, (_, i) => h('option', { value: String(i + 1) }, new Intl.DateTimeFormat(language(), { month: 'long' }).format(new Date(2026, i, 1)))));
  const day = h('select', { class: cls, 'data-part': 'day' }, [...Array.from({ length: 31 }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))), h('option', { value: 'last' }, t('schedule', 'the last day'))]);
  const time = h('input', { class: cls, type: 'time', 'data-part': 'time' });
  const from = h('input', { class: cls, type: 'date', 'data-part': 'from' });
  const until = h('input', { class: cls, type: 'date', 'data-part': 'until' });
  const bounds = h('div', { class: 'schedule-bounds' }, h('span', { class: 'muted' }, t('schedule', 'from')), from, h('span', { class: 'muted' }, t('schedule', 'until')), until);
  const el = h('div', { class: 'schedule-edit' }, h('div', { class: 'schedule-row' }, every, weekday, day, month, time), bounds);
  const show = () => {
    const e = every.value;
    weekday.classList.toggle('hidden', e !== 'week');
    day.classList.toggle('hidden', e !== 'month' && e !== 'year');
    month.classList.toggle('hidden', e !== 'year');
    time.classList.toggle('hidden', !e);
    bounds.classList.toggle('hidden', !e);
  };
  const set = (v: unknown) => {
    const s = readSchedule(v);
    every.value = s?.every ?? '';
    weekday.value = String(s?.weekday ?? 1);
    day.value = String(s?.day ?? 1);
    month.value = String(s?.month ?? 1);
    time.value = s?.time ?? '';
    from.value = s?.from ?? '';
    until.value = s?.until ?? '';
    show();
  };
  const changed = () => {
    show();
    if (!every.value) return onChange(null);
    onChange(
      readSchedule({
        every: every.value,
        ...(time.value ? { time: time.value } : {}),
        weekday: Number(weekday.value),
        day: day.value === 'last' ? 'last' : Number(day.value),
        month: Number(month.value),
        ...(from.value ? { from: from.value } : {}),
        ...(until.value ? { until: until.value } : {}),
      }),
    );
  };
  for (const c of [every, weekday, day, month, time, from, until]) c.addEventListener('change', changed);
  set(value);
  return { el, first: every, set };
}

/* ------------------------------------------------------------------ *
 * Grid columns from fields
 * ------------------------------------------------------------------ */

/** What a list needs loaded to show its columns: the tables referenced along every path. */
export async function columnMaps(data: DataService, tb: TableDef, columns: ColumnDef[]): Promise<Map<string, Map<string, Row>>> {
  const paths = columns.map((c) => c.field);
  const refFields = columns.map((c) => fieldAtPath(data.config, tb, c.field)).filter((x) => x?.field.type === 'ref').map((x) => x!.field.ref!);
  const maps = await data.refMaps(tb, paths);
  for (const name of refFields) if (!maps.has(name) && tableOf(data.config, name)) maps.set(name, await data.rowsById(name));
  return maps;
}

export function gridColumns(data: DataService, tb: TableDef, columns: ColumnDef[], maps: Map<string, Map<string, Row>>): GridColumn<Row>[] {
  const config: Config = data.config;
  const out: GridColumn<Row>[] = [];
  for (const c of columns) {
    const at = fieldAtPath(config, tb, c.field);
    if (!at) continue;
    const f = at.field;
    const path = c.field.split('.');
    const raw = (row: Row) => (path.length === 1 ? row[c.field] : data.walk(tb, row, path, maps));
    const target = f.type === 'ref' ? tableOf(config, f.ref) : undefined;
    const values = f.type === 'enum' ? enumValues(config, f) : undefined;
    const column: GridColumn<Row> = {
      key: c.field,
      title: c.title ?? (path.length > 1 ? `${fieldTitle(f)} (${fieldTitle(fieldAtPath(config, tb, path[0]!)!.field)})` : fieldTitle(f)),
      width: c.width ?? f.width ?? defaultWidth(f),
      kind: quickKind(f),
      ...(isNumeric(f) ? { align: 'num' as const, scale: f.type === 'integer' ? 0 : (f.scale ?? 2) } : {}),
      ...(f.type === 'boolean' ? { align: 'center' as const } : {}),
      ...(c.total ? { total: c.total } : {}),
      ...(c.hidden ? { hidden: true } : {}),
      value: (row) => {
        const v = raw(row);
        if (target) {
          if (v === null || v === undefined || v === '') return null;
          const ref = maps.get(target.name)?.get(String(v));
          return ref ? data.rowLabel(target, ref) : String(v);
        }
        if (values) return values.find((e) => e.value === v)?.title ?? v ?? null;
        // Filtered and sorted by what it says.
        if (f.type === 'schedule') return v ? scheduleText(v) : null;
        return v ?? null;
      },
      render: (row, v) => {
        if (v === null || v === undefined || v === '') return '';
        if (target) return h('span', { class: 'ref' }, String(v));
        if (values) {
          const e = values.find((x) => x.title === v);
          return e?.color ? h('span', { class: 'chip-enum', style: { background: `color-mix(in srgb, ${e.color} 16%, transparent)`, color: e.color } }, String(v)) : String(v);
        }
        if (f.type === 'boolean') return v ? h('span', { class: 'bool-yes' }, icon('check', 14)) : '';
        if (f.type === 'color') return h('span', { style: { display: 'inline-block', width: '14px', height: '14px', borderRadius: '3px', background: String(v), verticalAlign: 'middle' } });
        if (f.type === 'schedule') return String(v);
        if (f.display === 'progress') return progressBar(v);
        // The precision of a field of this very record; not through a path, which has its own record.
        return formatValue(path.length === 1 ? scaled(f, row) : f, v);
      },
    };
    out.push(column);
  }
  return out;
}

export function defaultWidth(f: FieldDef): number {
  switch (f.type) {
    case 'boolean':
      return 70;
    case 'integer':
    case 'decimal':
      return 110;
    case 'date':
      return 100;
    case 'datetime':
      return 140;
    case 'ref':
      return 200;
    case 'schedule':
      return 230;
    case 'text':
      return 260;
    default:
      return 160;
  }
}
