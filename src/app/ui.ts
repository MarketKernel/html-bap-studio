/**
 * The page's own toasts, dialogs and pop-up menus — never alert() or confirm():
 * those block the page, cannot be styled or translated, and a test cannot
 * answer them.
 */
import { t } from '../core/i18n';
import { button, h, icon } from './dom';

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'ok' | 'error' | 'warning' = 'info', action?: { label: string; run: () => void }, ms = kind === 'error' || kind === 'warning' ? 7000 : 3500): void {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast ${kind}` }, h('span', null, message));
  if (action) {
    el.appendChild(
      h('button', {
        type: 'button',
        onclick: () => {
          action.run();
          el.remove();
        },
      }, action.label),
    );
  }
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
  left?: boolean;
  /** Return false to keep the dialog open (a failed check). */
  check?: () => boolean | Promise<boolean>;
}

export interface DialogOptions<T> {
  title: string;
  body: Node | string;
  buttons: DialogButton<T>[];
  /** What Escape and the close button answer. */
  cancel: T;
  wide?: boolean;
  flush?: boolean;
  /** Called once the dialog is in the page: focus a field, start loading. */
  onOpen?: (close: (value: T) => void, root: HTMLElement) => void;
  /** Asked before Escape or the close button close it (unsaved changes); false keeps it open. */
  canCancel?: () => Promise<boolean>;
  /** Width and height of the box, for a record's form shown as a window. */
  size?: { width?: number; height?: number };
}

const openDialogs: HTMLElement[] = [];
export const dialogOpen = () => openDialogs.length > 0;

export function dialog<T>(options: DialogOptions<T>): Promise<T> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = h('div', { class: 'overlay' });
    const finish = (value: T) => {
      overlay.remove();
      openDialogs.splice(openDialogs.indexOf(overlay), 1);
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const cancel = async () => {
      if (options.canCancel && !(await options.canCancel())) return;
      finish(options.cancel);
    };
    const onKey = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== overlay) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        void cancel();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const primary = options.buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          void press(primary);
        }
      }
    };
    const press = async (b: DialogButton<T>) => {
      if (b.check && !(await b.check())) return;
      finish(b.value);
    };
    const box = h('div', { class: `dialog${options.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title });
    if (options.size?.width) box.style.width = `min(${options.size.width}px, 100%)`;
    if (options.size?.height) box.style.height = `min(${options.size.height}px, calc(100vh - 32px))`;
    const head = h('div', { class: 'dialog-head' }, h('span', { class: 'title' }, options.title), button(null, { icon: 'x', title: t('dialog', 'Close'), onClick: () => void cancel() }));
    const body = h('div', { class: `dialog-body${options.flush ? ' flush' : ''}` }, options.body);
    box.append(head, body);
    if (options.buttons.length) {
      box.appendChild(
        h(
          'div',
          { class: 'dialog-foot' },
          options.buttons.map((b) =>
            button(b.label, { class: `${b.primary ? 'primary' : 'outline'}${b.danger ? ' danger' : ''}${b.left ? ' left' : ''}`, onClick: () => void press(b) }),
          ),
        ),
      );
    }
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay && !options.wide) finish(options.cancel);
    });
    document.body.appendChild(overlay);
    openDialogs.push(overlay);
    document.addEventListener('keydown', onKey, true);
    draggable(box, head);
    options.onOpen?.(finish, box);
    if (!box.contains(document.activeElement)) {
      const first = box.querySelector<HTMLElement>('.dialog-body input:not([type=checkbox]), .dialog-body select, .dialog-body textarea') ?? box.querySelector<HTMLElement>('.dialog-foot .primary');
      first?.focus();
    }
  });
}

export function confirm(title: string, text: string, ok = t('dialog', 'OK'), danger = false): Promise<boolean> {
  return dialog({
    title,
    body: h('p', { style: { margin: '0', whiteSpace: 'pre-wrap', maxWidth: '520px' } }, text),
    buttons: [
      { label: t('dialog', 'Cancel'), value: false },
      { label: ok, value: true, primary: true, danger },
    ],
    cancel: false,
  });
}

export function alertDialog(title: string, text: string): Promise<void> {
  return dialog({ title, body: h('p', { style: { margin: '0', whiteSpace: 'pre-wrap', maxWidth: '560px' } }, text), buttons: [{ label: t('dialog', 'OK'), value: undefined, primary: true }], cancel: undefined });
}

export function prompt(title: string, label: string, value = '', check?: (v: string) => string | null): Promise<string | null> {
  const input = h('input', { class: 'input', value });
  const error = h('div', { class: 'field-error' });
  return dialog<string | null>({
    title,
    body: h('div', { class: 'col', style: { minWidth: '340px' } }, h('label', null, label), input, error),
    buttons: [
      { label: t('dialog', 'Cancel'), value: null },
      {
        label: t('dialog', 'OK'),
        value: '',
        primary: true,
        check: () => {
          const problem = check?.(input.value.trim()) ?? null;
          error.textContent = problem ?? '';
          return problem === null;
        },
      },
    ],
    cancel: null,
    onOpen: () => {
      input.focus();
      input.select();
    },
  }).then((r) => (r === null ? null : input.value.trim()));
}

/** Lets a dialog or window be moved by its title bar. */
export function draggable(box: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const start = { x: e.clientX, y: e.clientY };
    const rect = box.getBoundingClientRect();
    const base = { x: Number(box.dataset.dx ?? 0), y: Number(box.dataset.dy ?? 0) };
    handle.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const dx = Math.max(-rect.left + base.x, Math.min(window.innerWidth - rect.right + base.x, base.x + m.clientX - start.x));
      const dy = Math.max(-rect.top + base.y, Math.min(window.innerHeight - 40 - rect.top + base.y, base.y + m.clientY - start.y));
      box.dataset.dx = String(dx);
      box.dataset.dy = String(dy);
      box.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

/* ------------------------------------------------------------------ *
 * Pop-up menus
 * ------------------------------------------------------------------ */

export type MenuItem =
  | { label: string; icon?: string; hint?: string; disabled?: boolean; run: () => void }
  | { separator: true }
  | { title: string };

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeMenu(): void {
  openMenu?.close();
}

/** Shows a menu at a point or under an element; arrows, Enter and Escape work. */
export function popupMenu(at: { x: number; y: number } | HTMLElement, items: MenuItem[]): void {
  closeMenu();
  const el = h('div', { class: 'popup', role: 'menu' });
  const actionable: HTMLElement[] = [];
  for (const item of items) {
    if ('separator' in item) el.appendChild(h('div', { class: 'popup-sep' }));
    else if ('title' in item) el.appendChild(h('div', { class: 'popup-title' }, item.title));
    else {
      const row = h('div', { class: `popup-item${item.disabled ? ' disabled' : ''}`, role: 'menuitem', tabindex: -1 }, item.icon ? icon(item.icon) : h('span', { style: { width: '16px' } }), h('span', null, item.label), item.hint ? h('span', { class: 'hint' }, item.hint) : null);
      if (!item.disabled) {
        row.addEventListener('click', () => {
          close();
          item.run();
        });
        actionable.push(row);
      }
      el.appendChild(row);
    }
  }
  document.body.appendChild(el);
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 2;
  } else {
    x = at.x;
    y = at.y;
  }
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
  el.style.top = `${y + hgt > window.innerHeight - 4 ? Math.max(4, y - hgt - (at instanceof HTMLElement ? at.offsetHeight + 4 : 0)) : y}px`;
  let active = -1;
  const focus = (i: number) => {
    actionable[active]?.classList.remove('active');
    active = (i + actionable.length) % actionable.length;
    actionable[active]?.classList.add('active');
    actionable[active]?.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') focus(active + 1);
    else if (e.key === 'ArrowUp') focus(active - 1);
    else if (e.key === 'Enter' && active >= 0) actionable[active]?.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  function close() {
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    if (openMenu?.el === el) openMenu = null;
  }
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  openMenu = { el, close };
}

/** A label + control row for dialogs and property panels. */
export function fieldRow(label: string, control: HTMLElement, cls = 'prop'): HTMLElement {
  return h('div', { class: cls }, h('label', null, label), control);
}
