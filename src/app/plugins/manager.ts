/**
 * The plugin manager (Task.md 9.6): what is installed, from where, which hosts
 * it may reach; installing from files or a `plugins` folder with the user's
 * approval of each plugin's manifest; switching off, removing, the log, and
 * the data source contract check.
 */
import { t } from '../../core/i18n';
import type { PluginDescription } from '../../core/plugin-protocol';
import { runContract } from '../../core/contract';
import { button, clear, h, icon, pickFile } from '../dom';
import { confirm, dialog, toast } from '../ui';
import { idb } from '../storage';
import { sha256, type InstalledPlugin } from './host';
import type { Shell } from '../shell';

/** Shows the manifest and asks to trust the plugin; true when approved. */
export async function approve(description: PluginDescription, hash: string, fileName: string, previous?: InstalledPlugin): Promise<boolean> {
  const m = description.manifest;
  const hosts = m.permissions?.hosts ?? [];
  const changedHosts = previous && JSON.stringify(previous.hosts) !== JSON.stringify(hosts);
  return dialog({
    title: previous ? t('plugins', 'Update the plugin “{name}”?', { name: m.name }) : t('plugins', 'Install the plugin “{name}”?', { name: m.name }),
    body: h(
      'div',
      { style: { maxWidth: '560px' } },
      h(
        'div',
        { class: 'kv' },
        h('span', null, t('plugins', 'Name')),
        h('strong', null, m.name),
        h('span', null, 'ID'),
        h('span', { class: 'mono' }, m.id),
        h('span', null, t('plugins', 'Version')),
        h('span', null, previous?.version && previous.version !== m.version ? `${previous.version} → ${m.version}` : m.version),
        h('span', null, t('plugins', 'Author')),
        h('span', null, m.author ?? '—'),
        h('span', null, t('plugins', 'File')),
        h('span', null, fileName),
        h('span', null, t('plugins', 'Provides')),
        h('span', null, [...description.dataSources.map((d) => `${t('plugins', 'data source')} “${d.title}”`), ...description.actions.map((a) => `${t('plugins', 'action')} “${a.title}”`), ...description.exporters.map((e) => `${t('plugins', 'export')} “${e.title}”`), ...(description.reports ?? []).map((r) => `${t('plugins', 'report')} “${r.title}”`)].join(', ') || '—'),
        h('span', null, t('plugins', 'Your data')),
        m.permissions?.data === 'read'
          ? h('strong', { style: !previous?.data ? { color: 'var(--warn)' } : {} }, t('plugins', 'reads the records of the application (does not change them)'))
          : h('span', null, t('plugins', 'does not read them')),
        h('span', null, t('plugins', 'May connect to')),
        h('span', { style: changedHosts ? { color: 'var(--warn)', fontWeight: '600' } : {} }, hosts.length ? hosts.join(', ') : t('plugins', 'nothing — works offline')),
        h('span', null, 'SHA-256'),
        h('span', { class: 'mono', style: { fontSize: '11px', wordBreak: 'break-all' } }, hash),
      ),
      m.description ? h('p', null, m.description) : null,
      h('p', { class: 'muted', style: { fontSize: '12px' } }, t('plugins', 'A plugin is code that runs in this browser, like an extension. Install only what you trust. It can reach only the sites listed above.')),
    ),
    buttons: [
      { label: t('dialog', 'Cancel'), value: false },
      { label: previous ? t('plugins', 'Update') : t('plugins', 'Install'), value: true, primary: true },
    ],
    cancel: false,
  });
}

async function installCode(shell: Shell, code: string, fileName: string, origin: 'file' | 'folder'): Promise<boolean> {
  const registry = shell.registry;
  let description: PluginDescription;
  try {
    description = await registry.inspect(code);
  } catch (error) {
    shell.fail(error, fileName);
    return false;
  }
  const previous = registry.plugins.get(description.manifest.id);
  const hash = await sha256(code);
  if (previous && previous.hash === hash && registry.trusted(previous)) return false;
  if (!(await approve(description, hash, fileName, previous))) return false;
  try {
    await registry.install(code, description, origin, fileName);
    toast(t('plugins', 'Plugin “{name}” installed', { name: description.manifest.name }), 'ok');
    return true;
  } catch (error) {
    shell.fail(error, fileName);
    return false;
  }
}

/** Reads every `.js` file of a folder, and `index.js` of each subfolder. */
async function readFolder(dir: FileSystemDirectoryHandle): Promise<{ name: string; code: string }[]> {
  const out: { name: string; code: string }[] = [];
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind === 'file' && name.endsWith('.js')) out.push({ name, code: await (await (handle as FileSystemFileHandle).getFile()).text() });
    else if (handle.kind === 'directory') {
      try {
        const index = await (handle as FileSystemDirectoryHandle).getFileHandle('index.js');
        out.push({ name: `${name}/index.js`, code: await (await index.getFile()).text() });
      } catch {
        // Not a plugin folder.
      }
    }
  }
  return out;
}

/** Re-reads the remembered plugins folder; new or changed plugins are offered for approval. */
export async function rescanFolder(shell: Shell, ask: boolean): Promise<number> {
  const dir = await idb.get<FileSystemDirectoryHandle>('handles', 'plugins-folder').catch(() => undefined);
  if (!dir) return 0;
  const handle = dir as FileSystemDirectoryHandle & { queryPermission?(d: { mode: string }): Promise<string>; requestPermission?(d: { mode: string }): Promise<string> };
  let state = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
  if (state !== 'granted' && ask) state = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied';
  if (state !== 'granted') return 0;
  let installed = 0;
  for (const file of await readFolder(dir)) if (await installCode(shell, file.code, file.name, 'folder')) installed++;
  return installed;
}

export async function pluginManager(shell: Shell): Promise<void> {
  const registry = shell.registry;
  const list = h('div', { style: { minHeight: '200px' } });
  const render = () => {
    const rows = [...registry.plugins.values()].sort((a, b) => (a.origin === 'builtin' ? 0 : 1) - (b.origin === 'builtin' ? 0 : 1) || a.id.localeCompare(b.id));
    clear(
      list,
      ...rows.map((p) => {
        const worker = registry.running.get(p.id);
        const state = !p.enabled
          ? t('plugins', 'Switched off')
          : !registry.trusted(p)
            ? t('plugins', 'Changed — needs approval')
            : worker?.crashed
              ? t('plugins', 'Failed: {error}', { error: worker.crashed })
              : worker
                ? t('plugins', 'Running')
                : t('plugins', 'Ready');
        const origin = p.origin === 'builtin' ? t('plugins', 'Built in') : p.origin === 'folder' ? t('plugins', 'From the plugins folder') : t('plugins', 'From a file');
        const sources = worker?.description?.dataSources.map((d) => d.title).join(', ');
        return h(
          'div',
          { class: 'plugin-row', 'data-plugin': p.id },
          h('div', { class: 'tile-icon' }, icon(p.origin === 'builtin' ? 'database' : 'puzzle', 18)),
          h(
            'div',
            null,
            h('div', null, h('strong', null, p.name ?? p.id), ' ', h('span', { class: 'muted' }, p.version ? `v${p.version}` : ''), ' · ', h('span', { class: 'muted mono' }, p.id)),
            h('div', { class: 'muted', style: { fontSize: '12px' } }, `${origin} · ${state}${p.hosts.length ? ` · ${t('plugins', 'Hosts')}: ${p.hosts.join(', ')}` : ''}${sources ? ` · ${sources}` : ''}`),
          ),
          h(
            'div',
            { class: 'row' },
            !registry.trusted(p)
              ? button(t('plugins', 'Review'), {
                  icon: 'eye',
                  onClick: async () => {
                    if (await installCode(shell, p.code, p.fileName ?? p.id, p.origin === 'folder' ? 'folder' : 'file')) render();
                  },
                })
              : null,
            button(t('plugins', 'Check'), { icon: 'checkSquare', title: t('plugins', 'Run the data source contract check'), disabled: !p.enabled || !registry.trusted(p), onClick: () => void contractCheck(shell, p) }),
            button(null, { icon: 'list', title: t('plugins', 'Log'), onClick: () => showLog(shell, p) }),
            button(null, { icon: 'refresh', title: t('plugins', 'Restart'), onClick: () => (registry.stop(p.id), render()) }),
            button(p.enabled ? t('plugins', 'Switch off') : t('plugins', 'Switch on'), {
              icon: p.enabled ? 'eyeOff' : 'eye',
              onClick: async () => {
                await registry.setEnabled(p.id, !p.enabled);
                render();
              },
            }),
            p.origin !== 'builtin'
              ? button(null, {
                  icon: 'trash',
                  class: 'danger',
                  title: t('plugins', 'Remove'),
                  onClick: async () => {
                    if (await confirm(t('plugins', 'Remove the plugin'), t('plugins', 'Remove “{name}”? Connections that use it stop working.', { name: p.name ?? p.id }), t('plugins', 'Remove'), true)) {
                      await registry.remove(p.id);
                      render();
                    }
                  },
                })
              : null,
          ),
        );
      }),
    );
  };
  // Running plugins report their state: start the enabled ones to show it.
  void Promise.allSettled([...registry.plugins.values()].filter((p) => p.enabled && registry.trusted(p)).map((p) => registry.start(p.id))).then(render);
  render();
  const fromFiles = async () => {
    for (const file of await pickFile('.js,.mjs,text/javascript', true)) await installCode(shell, await file.text(), file.name, 'file');
    render();
  };
  const fromFolder = async () => {
    const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) {
      toast(t('plugins', 'This browser cannot remember a folder; choose the plugin files instead'), 'info');
      return fromFiles();
    }
    try {
      const dir = await picker({ id: 'bap-plugins', mode: 'read' });
      await idb.set('handles', 'plugins-folder', dir);
      const n = await rescanFolder(shell, true);
      toast(t('plugins', 'Plugins folder connected: {n} installed or updated', { n }), 'ok');
    } catch (error) {
      if ((error as Error).name !== 'AbortError') shell.fail(error);
    }
    render();
  };
  const body = h(
    'div',
    { class: 'col', style: { gap: '0' } },
    h(
      'div',
      { class: 'toolbar' },
      button(t('plugins', 'Install from a file…'), { icon: 'upload', class: 'primary', onClick: () => void fromFiles() }),
      button(t('plugins', 'Connect a plugins folder…'), { icon: 'folderOpen', onClick: () => void fromFolder() }),
      button(t('plugins', 'Rescan the folder'), { icon: 'refresh', onClick: () => void rescanFolder(shell, true).then(render) }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted', style: { fontSize: '12px', padding: '0 8px' } }, t('plugins', 'Drop .js files here')),
    ),
    list,
  );
  body.addEventListener('dragover', (e) => e.preventDefault());
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /\.m?js$/.test(f.name));
    void (async () => {
      for (const f of files) await installCode(shell, await f.text(), f.name, 'file');
      render();
    })();
  });
  await dialog({ title: t('plugins', 'Plugins'), body, flush: true, wide: true, buttons: [{ label: t('dialog', 'Close'), value: undefined, primary: true }], cancel: undefined });
}

function showLog(shell: Shell, p: InstalledPlugin): void {
  const worker = shell.registry.running.get(p.id);
  const lines = worker?.log ?? [];
  void dialog({
    title: t('plugins', 'Log of “{name}”', { name: p.name ?? p.id }),
    body: h('div', { class: 'log', style: { minWidth: '560px', maxHeight: '60vh' } }, lines.length ? lines.map((l) => `${l.time.slice(11, 19)} ${l.level.toUpperCase()} ${l.message}`).join('\n') : t('plugins', 'Nothing yet')),
    buttons: [{ label: t('dialog', 'Close'), value: undefined, primary: true }],
    cancel: undefined,
  });
}

/** Runs the data source contract check against a scratch connection of each source of the plugin. */
async function contractCheck(shell: Shell, p: InstalledPlugin): Promise<void> {
  const out = h('div', { class: 'log contract-report', style: { minWidth: '600px', maxHeight: '60vh' } }, t('plugins', 'Starting…'));
  void dialog({ title: t('plugins', 'Contract check: {name}', { name: p.name ?? p.id }), body: out, buttons: [{ label: t('dialog', 'Close'), value: undefined, primary: true }], cancel: undefined });
  try {
    const worker = await shell.registry.start(p.id);
    const sources = worker.description?.dataSources ?? [];
    if (!sources.length) {
      out.textContent = t('plugins', 'This plugin has no data sources.');
      return;
    }
    clear(out);
    for (const s of sources) {
      // A scratch database for the built-in local source; other sources are checked as configured.
      const settings: Record<string, unknown> = Object.fromEntries(s.settings.map((d) => [d.key, d.default ?? null]));
      if (p.id === 'local') settings.name = `contract-check-${Date.now().toString(36)}`;
      const conn = await shell.registry.connect(`contract:${s.name}`, p.id, s.name, settings);
      out.appendChild(h('div', null, h('strong', null, s.title)));
      const report = await runContract(conn, (line) => out.appendChild(h('div', { class: line.ok ? 'ok' : 'fail' }, `${line.ok ? '✓' : '✗'} ${line.name}${line.message ? ` — ${line.message}` : ''}`)));
      out.appendChild(h('div', null, h('strong', null, t('plugins', '{passed} passed, {failed} failed, {skipped} skipped', { passed: report.passed, failed: report.failed, skipped: report.skipped }))));
      await conn.close();
    }
  } catch (error) {
    out.appendChild(h('div', { class: 'fail' }, error instanceof Error ? error.message : String(error)));
  }
}
