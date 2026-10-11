/**
 * Bundles src/ into ONE self-contained build/bap.html.
 *
 * Styles, the compiled TypeScript, the icon, the plugin worker's runtime and
 * the built-in plugins (plugins/builtin/<id>/index.ts, each bundled into an ES
 * module kept as a string) are all inlined, so the result opens from a file://
 * URL with no sibling files.
 *
 * The page's one inline script is pinned in the CSP by its hash instead of
 * 'unsafe-inline' (Task.md 3): HTML the user writes (print templates) can then
 * never run a handler of its own. blob: is allowed for scripts and workers —
 * that is how plugins run (docs/notes/platform.md) — and connect-src allows
 * https: for the data sources that plugins bring; the core itself fetches nothing.
 *
 * The version is package.json's and nowhere else.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const at = (...parts) => join(root, ...parts);
const watch = process.argv.includes('--watch');
const outFile = at('build', 'bap.html');

/**
 * Distributions: the studio built as one application — build/<id>.html opens
 * on its own templates and keeps the designer hidden until asked for. The
 * application is the template's configuration; nothing else differs.
 */
const DISTRIBUTIONS = [{ id: 'finance', templates: ['finance', 'finance-empty'] }];

async function readRelease() {
  const { version } = JSON.parse(await readFile(at('package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json: the version must be x.y.z, not ${version}`);
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const tagged = process.env.RELEASE_TAG === `v${version}` || git('tag', '--points-at', 'HEAD').split('\n').includes(`v${version}`);
  const commit = tagged ? '' : git('rev-parse', '--short', 'HEAD');
  return { version, label: commit ? `${version}+${commit}` : version };
}

let release;

/** `</script` inside a string literal would close the inline tag early. */
const guard = (code) => code.replace(/<\/(script|style)/gi, '<\\/$1');

/**
 * `<!--` followed by `<script` before any `-->` puts the HTML parser in the
 * "double escaped" state, where `</script>` no longer closes the tag and the
 * page runs nothing at all.
 */
function assertScriptCloses(code) {
  const open = code.indexOf('<!--');
  const end = open < 0 ? -1 : code.indexOf('-->', open);
  if (open >= 0 && /<script/i.test(code.slice(open, end < 0 ? undefined : end))) {
    throw new Error('The bundle has "<!--" followed by "<script": the inline script would never close');
  }
}

async function bundle(entry, { format = 'iife', define = {} } = {}) {
  const result = await build({
    entryPoints: [at(entry)],
    bundle: true,
    format,
    target: ['es2022'],
    platform: 'browser',
    minify: !watch,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    define: { __APP_VERSION__: JSON.stringify(release.label), ...define },
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild returned nothing for ${entry}`);
  return output.text;
}

/** plugins/builtin/<id>/index.ts → { id, code }: ES modules the page hands to workers as text. */
async function builtinPlugins() {
  const dir = at('plugins', 'builtin');
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    const entry = join('plugins', 'builtin', name, 'index.ts');
    if (!existsSync(at(entry))) continue;
    out.push({ id: name, code: await bundle(entry, { format: 'esm' }) });
  }
  return out;
}

/** src/app/styles.css first, then every other .css under src/app (a screen's own styles), in name order. */
async function appStyles() {
  const others = (await readdir(at('src/app'), { recursive: true })).filter((f) => f.endsWith('.css') && f !== 'styles.css').sort();
  const parts = [await readFile(at('src/app/styles.css'), 'utf8')];
  for (const f of others) parts.push(`/* ${f} */\n${await readFile(at('src/app', f), 'utf8')}`);
  return parts.join('\n');
}

function assertSelfContained(html) {
  const offenders = [
    [/<script[^>]+\ssrc=/i, '<script src=…>'],
    [/<link[^>]+href=["'](?!data:)/i, '<link href=…>'],
    [/@import\s+(url\()?["']?(?!data:)/i, '@import'],
    [/url\(\s*["']?https?:/i, 'url(http…)'],
  ];
  for (const [pattern, name] of offenders) {
    if (pattern.test(html)) throw new Error(`An external reference is left in the file: ${name}`);
  }
  if (!html.includes('http-equiv="Content-Security-Policy"')) throw new Error('The Content-Security-Policy meta tag is missing');
}

/** Replaces __SCRIPT_HASH__ in the CSP with the hash of the bytes between <script> and </script>. */
function pinScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error(`Expected exactly one inline script, found ${scripts.length}`);
  const hash = createHash('sha256').update(scripts[0][1], 'utf8').digest('base64');
  if (!html.includes("'__SCRIPT_HASH__'")) throw new Error('The CSP has no __SCRIPT_HASH__ to pin');
  return html.replace("'__SCRIPT_HASH__'", () => `'sha256-${hash}'`);
}

const PWA_FILES = ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

/**
 * The installed app needs its manifest, service worker and icons from its own
 * origin; everything else of the policy stays as in the single file.
 */
function allowPwa(html) {
  const pattern = /(http-equiv="Content-Security-Policy" content=")([^"]*)/;
  return html.replace(pattern, (_, attr, policy) => {
    const directives = new Map(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
    directives.get('img-src').push("'self'");
    directives.set('manifest-src', ["'self'"]);
    directives.get('worker-src').push("'self'");
    return attr + [...directives].map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
  });
}

/** build/pages/: the page as an installable PWA. Every path is relative, so it works under any prefix. */
async function buildPages(html) {
  const dir = at('build', 'pages');
  const head = [
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
    '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#1c1f26" media="(prefers-color-scheme: dark)">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    // The page registers the worker itself (update.ts): this is how it knows it is the PWA.
    '<meta name="service-worker" content="sw.js">',
  ].join('\n');
  const page = allowPwa(html).replace('</head>', () => `${head}\n</head>`);
  const cache = `${release.version}-${createHash('sha256').update(page).digest('hex').slice(0, 12)}`;
  const manifest = {
    name: 'BAP Studio',
    short_name: 'BAP Studio',
    description: 'Build business applications and work in them — offline, extensible with plugins',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#f4f5f7',
    theme_color: '#2f5bd3',
    icons: [
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  const { rm, copyFile } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const worker = (await readFile(at('src/pwa/sw.js'), 'utf8')).replaceAll('__CACHE__', cache).replaceAll('__VERSION__', release.label);
  await Promise.all([
    writeFile(join(dir, 'index.html'), page, 'utf8'),
    writeFile(join(dir, 'sw.js'), worker, 'utf8'),
    writeFile(join(dir, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(join(dir, '.nojekyll'), '', 'utf8'),
    ...PWA_FILES.map((name) => copyFile(at('assets', 'pwa', name), join(dir, name))),
  ]);
  console.log(`build/pages/ — PWA (cache ${cache})`);
}

async function buildOnce() {
  release = await readRelease();
  const runtime = await bundle('src/plugin-runtime/runtime.ts');
  const plugins = await builtinPlugins();
  const [template, styles, icon, appJs] = await Promise.all([
    readFile(at('src/app/template.html'), 'utf8'),
    appStyles(),
    readFile(at('assets/icon.svg'), 'utf8'),
    bundle('src/app/main.ts', {
      define: {
        __WORKER_RUNTIME__: JSON.stringify(runtime),
        __BUILTIN_PLUGINS__: JSON.stringify(plugins),
        __DISTRIBUTION__: 'null',
      },
    }),
  ]);
  assertScriptCloses(appJs);
  const svg = icon.replace(/<\?xml[\s\S]*?\?>/, '').trim();
  const iconUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

  const html = pinScript(
    template
      .replace('/*__STYLES__*/', () => styles)
      .replace('/*__APP__*/', () => guard(appJs))
      .replaceAll('__ICON__', () => iconUri),
  );
  assertSelfContained(html);

  await mkdir(at('build'), { recursive: true });
  await writeFile(outFile, html, 'utf8');
  const kb = (n) => (n / 1024).toFixed(1);
  console.log(
    `build/bap.html ${release.label} — ${kb(Buffer.byteLength(html, 'utf8'))} KB ` +
      `(code ${kb(appJs.length)} KB, styles ${kb(styles.length)} KB, plugins: ${plugins.map((p) => `${p.id} ${kb(p.code.length)} KB`).join(', ')})`,
  );
  await buildPages(html);
  for (const d of DISTRIBUTIONS) {
    const js = await bundle('src/app/main.ts', { define: { __WORKER_RUNTIME__: JSON.stringify(runtime), __BUILTIN_PLUGINS__: JSON.stringify(plugins), __DISTRIBUTION__: JSON.stringify(d) } });
    assertScriptCloses(js);
    const page = pinScript(
      template
        .replace('/*__STYLES__*/', () => styles)
        .replace('/*__APP__*/', () => guard(js))
        .replaceAll('__ICON__', () => iconUri),
    );
    assertSelfContained(page);
    await writeFile(at('build', `${d.id}.html`), page, 'utf8');
    console.log(`build/${d.id}.html — ${kb(Buffer.byteLength(page, 'utf8'))} KB (a distribution: ${d.templates.join(', ')})`);
  }
}

try {
  await buildOnce();
} catch (error) {
  console.error(error.errors ? error.errors.map((e) => `${e.location?.file}:${e.location?.line}: ${e.text}`).join('\n') : error);
  if (!watch) process.exit(1);
}

if (watch) {
  const { watch: watchDir } = await import('node:fs');
  let pending = null;
  for (const dir of ['src', 'assets', 'plugins', 'templates']) {
    watchDir(at(dir), { recursive: true }, () => {
      clearTimeout(pending);
      pending = setTimeout(() => buildOnce().catch((error) => console.error(error.message ?? error)), 150);
    });
  }
  console.log('watching src/, plugins/, templates/ …');
}
