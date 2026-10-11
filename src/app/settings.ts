/**
 * Settings that may be lost without harm — theme, language, widths, the list
 * of recent workspaces — in localStorage as one JSON. Every field is checked
 * on reading: a value that is unknown or broken becomes the default, so a
 * stale or hand-edited entry never breaks the start.
 */
import { detectLanguage, isLanguage, type Language } from '../core/i18n';

export interface Workspace {
  id: string;
  name: string;
  /** Where the configuration lives: a plugin's data source and its settings (secrets apart, in IndexedDB). */
  plugin: string;
  source: string;
  settings: Record<string, unknown>;
  openedAt: string;
  /** The starter template it was made from: a distribution lists only its own. */
  template?: string;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  density: 'compact' | 'comfortable';
  language: 'system' | Language;
  user: string;
  navWidth: number;
  navCollapsed: boolean;
  workspaces: Workspace[];
  lastWorkspace: string | null;
  /** Per workspace: the tabs that were open, to reopen them. */
  tabs: Record<string, string[]>;
  /** Personal grid layouts: `${workspace}:${view}` → columns widths/order, filters. */
  views: Record<string, unknown>;
  splits: Record<string, number>;
  /** In a distribution: the designer shown all the same. */
  designer: boolean;
}

const KEY = 'bap.settings';

const DEFAULTS: Settings = {
  theme: 'system',
  density: 'compact',
  language: 'system',
  user: 'admin',
  navWidth: 248,
  navCollapsed: false,
  workspaces: [],
  lastWorkspace: null,
  tabs: {},
  views: {},
  splits: {},
  designer: false,
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readWorkspace(raw: unknown): Workspace | null {
  if (!isObject(raw)) return null;
  const { id, name, plugin, source, settings, openedAt } = raw;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof plugin !== 'string' || typeof source !== 'string') return null;
  return { id, name, plugin, source, settings: isObject(settings) ? settings : {}, openedAt: typeof openedAt === 'string' ? openedAt : '', ...(typeof raw.template === 'string' ? { template: raw.template } : {}) };
}

export function readSettings(): Settings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    raw = null;
  }
  const r = isObject(raw) ? raw : {};
  const s = structuredClone(DEFAULTS);
  if (r.theme === 'light' || r.theme === 'dark' || r.theme === 'system') s.theme = r.theme;
  if (r.density === 'compact' || r.density === 'comfortable') s.density = r.density;
  if (r.language === 'system' || isLanguage(r.language)) s.language = r.language as Settings['language'];
  if (typeof r.user === 'string' && r.user.trim()) s.user = r.user.trim().slice(0, 80);
  if (typeof r.navWidth === 'number' && r.navWidth >= 160 && r.navWidth <= 600) s.navWidth = r.navWidth;
  if (typeof r.navCollapsed === 'boolean') s.navCollapsed = r.navCollapsed;
  if (Array.isArray(r.workspaces)) s.workspaces = r.workspaces.map(readWorkspace).filter((w): w is Workspace => w !== null);
  if (typeof r.lastWorkspace === 'string') s.lastWorkspace = r.lastWorkspace;
  if (isObject(r.tabs)) for (const [k, v] of Object.entries(r.tabs)) if (Array.isArray(v)) s.tabs[k] = v.filter((x): x is string => typeof x === 'string').slice(0, 30);
  if (isObject(r.views)) s.views = r.views;
  if (typeof r.designer === 'boolean') s.designer = r.designer;
  if (isObject(r.splits)) for (const [k, v] of Object.entries(r.splits)) if (typeof v === 'number' && v > 0 && v < 5000) s.splits[k] = v;
  return s;
}

export const settings: Settings = readSettings();

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or a full quota: the settings live for this session only.
  }
}

/** Another tab changed the settings: take them, so the next save does not overwrite theirs. */
addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  Object.assign(settings, readSettings());
});

/** The distribution this page is, if any (build.mjs). */
export const DISTRIBUTION = typeof __DISTRIBUTION__ === 'undefined' ? null : __DISTRIBUTION__;

/** The designer is there in the studio; in a distribution, when the person asked for it in the settings. */
export function designerShown(): boolean {
  return !DISTRIBUTION || settings.designer;
}

/** The workspaces this page offers: all of them in the studio, a distribution's own in a distribution. */
export function ownWorkspaces(): Workspace[] {
  return DISTRIBUTION ? settings.workspaces.filter((w) => w.template && DISTRIBUTION.templates.includes(w.template)) : settings.workspaces;
}

export function effectiveLanguage(): Language {
  return settings.language === 'system' ? detectLanguage() : settings.language;
}

export function applyTheme(): void {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.density = settings.density;
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
