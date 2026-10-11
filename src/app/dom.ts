/**
 * The page is built by hand, without a framework: h() makes an element with
 * its attributes, listeners and children in one call. Text always goes in as
 * text nodes — nothing a user or a plugin typed is ever parsed as HTML.
 */
import { ICONS } from './icons';

type Child = Node | string | number | null | undefined | false | Child[];
type Listener = (event: never) => void;
export type Attrs = Record<string, string | number | boolean | null | undefined | Listener | Partial<CSSStyleDeclaration>>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) setAttrs(el, attrs);
  append(el, children);
  return el;
}

export function setAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
    } else if (name === 'style' && typeof value === 'object') {
      // Custom properties (--depth) are not style fields: only setProperty sets them.
      for (const [k, v] of Object.entries(value)) {
        if (k.startsWith('--')) el.style.setProperty(k, String(v));
        else (el.style as unknown as Record<string, unknown>)[k] = v;
      }
    } else if (name === 'class') {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(name, '');
    } else if (name === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(value);
    } else {
      el.setAttribute(name, String(value));
    }
  }
}

export function append(el: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(el: Node, ...children: Child[]): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  append(el, children);
}

const SVG = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, ...children: (SVGElement | string | null | undefined | false)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) el.setAttribute(name, String(value));
  for (const child of children) {
    if (!child) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** An icon from the built-in set; an unknown name draws a dot rather than nothing. */
export function icon(name: string | undefined, size = 16): SVGSVGElement {
  const el = svg('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'icon', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const paths = ICONS[name ?? ''] ?? ICONS.dot!;
  for (const d of paths) el.appendChild(svg('path', { d }));
  return el;
}

export function button(label: string | null, opts: { icon?: string; title?: string; class?: string; onClick?: (e: MouseEvent) => void; disabled?: boolean; kbd?: string } = {}): HTMLButtonElement {
  const b = h('button', {
    type: 'button',
    class: `btn ${opts.class ?? ''} ${label ? '' : 'icon-only'}`.trim(),
    title: opts.title ?? (label ? null : null),
    'aria-label': label ? null : (opts.title ?? null),
    disabled: opts.disabled ?? false,
  });
  if (opts.icon) b.appendChild(icon(opts.icon));
  if (label) b.appendChild(h('span', null, label));
  if (opts.onClick) b.addEventListener('click', opts.onClick as EventListener);
  return b;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = (e: KeyboardEvent | MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);
export const touchOnly = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches;

/** Downloads a Blob under a name — the one way out of file:// in every browser. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Calls `fn` at most once per animation frame, with the latest arguments. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let pending: A | null = null;
  return (...args: A) => {
    if (pending === null) {
      requestAnimationFrame(() => {
        const a = pending as A;
        pending = null;
        fn(...a);
      });
    }
    pending = args;
  };
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
