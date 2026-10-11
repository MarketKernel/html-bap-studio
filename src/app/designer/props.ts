/**
 * Property panel controls for the designers: each reads a value and calls
 * back with the new one when the user is done (change, not every keystroke),
 * so every edit is one step in the undo history.
 */
import { t } from '../../core/i18n';
import { checkExpr } from '../../core/expr/index';
import { HOST_FUNCTIONS } from '../../core/scope';
import { ICON_NAMES } from '../icons';
import { h, icon } from '../dom';
import { popupMenu } from '../ui';

const HOST = Object.keys(HOST_FUNCTIONS);

export function section(title: string, ...children: (Node | null | false)[]): HTMLElement {
  return h('div', { class: 'prop-section' }, h('h4', null, title), ...children.filter((c): c is Node => !!c));
}

function row(label: string, control: HTMLElement, stack = false, hint?: string): HTMLElement {
  return h('div', { class: `prop${stack ? ' stack' : ''}`, title: hint ?? '' }, h('label', null, label), control);
}

export function textProp(label: string, value: string | undefined, set: (v: string) => void, opts: { mono?: boolean; placeholder?: string; hint?: string; multiline?: boolean } = {}): HTMLElement {
  const input = opts.multiline ? h('textarea', { class: `input${opts.mono ? ' expr-input' : ''}`, rows: 4 }) : h('input', { class: `input${opts.mono ? ' mono' : ''}`, placeholder: opts.placeholder ?? '' });
  input.value = value ?? '';
  input.dataset.prop = label;
  input.addEventListener('change', () => set(input.value));
  return row(label, input, opts.multiline, opts.hint);
}

export function numberProp(label: string, value: number | undefined, set: (v: number | undefined) => void): HTMLElement {
  const input = h('input', { class: 'input', type: 'number', value: value === undefined ? '' : String(value) });
  input.dataset.prop = label;
  input.addEventListener('change', () => set(input.value === '' ? undefined : Number(input.value)));
  return row(label, input);
}

export function checkProp(label: string, value: boolean | undefined, set: (v: boolean) => void, hint?: string): HTMLElement {
  const box = h('input', { type: 'checkbox' });
  box.checked = value === true;
  box.dataset.prop = label;
  box.addEventListener('change', () => set(box.checked));
  return row(label, h('div', null, box), false, hint);
}

export function selectProp<T extends string>(label: string, value: T | undefined, options: [T, string][], set: (v: T) => void, allowEmpty = false): HTMLElement {
  const select = h('select', { class: 'input' }, allowEmpty ? h('option', { value: '' }, '—') : null, options.map(([v, title]) => h('option', { value: v }, title)));
  select.value = value ?? '';
  select.dataset.prop = label;
  select.addEventListener('change', () => set(select.value as T));
  return row(label, select);
}

/**
 * An expression field that checks itself as you type against the names in
 * scope, and shows the error under it.
 */
export function exprProp(label: string, value: string | undefined, names: () => string[], set: (v: string) => void, opts: { placeholder?: string; hint?: string } = {}): HTMLElement {
  const input = h('textarea', { class: 'input expr-input', rows: 2, placeholder: opts.placeholder ?? '', spellcheck: 'false' });
  input.value = value ?? '';
  input.dataset.prop = label;
  const error = h('div', { class: 'field-error' });
  const check = () => {
    const v = input.value.trim();
    const r = v ? checkExpr(v, names(), HOST) : {};
    error.textContent = r.error?.message ?? '';
    input.classList.toggle('invalid', !!r.error);
    return !r.error;
  };
  input.addEventListener('input', check);
  input.addEventListener('change', () => {
    if (check() || !input.value.trim()) set(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      input.dispatchEvent(new Event('change'));
    }
  });
  check();
  return h('div', { class: 'prop stack', title: opts.hint ?? '' }, h('label', null, label), input, error);
}

export function iconProp(label: string, value: string | undefined, set: (v: string) => void): HTMLElement {
  const b = h('button', { type: 'button', class: 'btn outline' }, icon(value ?? 'dot'), value ?? t('props', 'none'));
  b.addEventListener('click', () => {
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(8, 32px)', gap: '4px', padding: '6px' } });
    for (const name of ICON_NAMES) {
      const cell = h('button', { type: 'button', class: 'btn icon-only', title: name }, icon(name, 18));
      cell.addEventListener('click', () => {
        set(name);
        document.querySelector('.popup')?.remove();
      });
      grid.appendChild(cell);
    }
    popupMenu(b, []);
    document.querySelector('.popup')?.appendChild(grid);
  });
  return row(label, b);
}

export const TYPE_OPTIONS: [import('../../core/config/types').FieldType, string][] = [
  ['string', 'Text'],
  ['text', 'Long text'],
  ['integer', 'Whole number'],
  ['decimal', 'Decimal number'],
  ['boolean', 'Yes / no'],
  ['date', 'Date'],
  ['datetime', 'Date and time'],
  ['time', 'Time'],
  ['enum', 'List of values'],
  ['ref', 'Reference to a table'],
  ['email', 'E-mail'],
  ['phone', 'Phone'],
  ['url', 'Link'],
  ['color', 'Colour'],
  ['schedule', 'Schedule'],
  ['json', 'JSON'],
];

export function typeTitle(type: string): string {
  switch (type) {
    case 'string':
      return t('props', 'Text');
    case 'text':
      return t('props', 'Long text');
    case 'integer':
      return t('props', 'Whole number');
    case 'decimal':
      return t('props', 'Decimal number');
    case 'boolean':
      return t('props', 'Yes / no');
    case 'date':
      return t('props', 'Date');
    case 'datetime':
      return t('props', 'Date and time');
    case 'time':
      return t('props', 'Time');
    case 'enum':
      return t('props', 'List of values');
    case 'ref':
      return t('props', 'Reference to a table');
    case 'email':
      return t('props', 'E-mail');
    case 'phone':
      return t('props', 'Phone');
    case 'url':
      return t('props', 'Link');
    case 'color':
      return t('props', 'Colour');
    case 'schedule':
      return t('props', 'Schedule');
    case 'json':
      return 'JSON';
    default:
      return type;
  }
}
