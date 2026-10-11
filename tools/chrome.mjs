/**
 * Headless Chrome over the DevTools protocol, with no dependencies beyond Node:
 * the protocol is spoken over Node's built-in WebSocket. Every browser test and
 * tools/shots.mjs share this file instead of copying the plumbing.
 *
 * launch() starts Chrome with a throwaway profile and attaches to its first tab;
 * the returned object has the helpers a test needs: evaluate, until, click,
 * press, type, screenshot, and the page's errors collected as they happen.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME =
  process.env.CHROME ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ].find((path) => existsSync(path));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
  Insert: { code: 'Insert', windowsVirtualKeyCode: 45 },
  F2: { code: 'F2', windowsVirtualKeyCode: 113 },
  F5: { code: 'F5', windowsVirtualKeyCode: 116 },
  F12: { code: 'F12', windowsVirtualKeyCode: 123 },
  k: { code: 'KeyK', windowsVirtualKeyCode: 75 },
  s: { code: 'KeyS', windowsVirtualKeyCode: 83 },
  z: { code: 'KeyZ', windowsVirtualKeyCode: 90 },
};

/** Ctrl on Linux and Windows, ⌘ on a Mac — the page reads either as the shortcut modifier. */
export const MOD = process.platform === 'darwin' ? 4 : 2;

export async function launch({ width = 1440, height = 900, args = [] } = {}) {
  if (!CHROME) return null;
  const profile = await mkdtemp(join(tmpdir(), 'bap-chrome-'));
  const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, ...args];
  if (process.platform === 'linux') flags.push('--no-sandbox');
  const chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let id = 0;
  const waiting = new Map();
  const errors = [];
  const console_ = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const line = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      console_.push(`${msg.params.type}: ${line}`);
      if (msg.params.type === 'error') errors.push(line);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      // A missing favicon is the browser's business, not the page's.
      if (!/favicon/.test(msg.params.entry.url ?? '')) errors.push(msg.params.entry.text);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`${expr.slice(0, 300)}\n${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  /** Polls `expr` until it is truthy; survives navigations. Parenthesise `a ?? b` inside it. */
  const until = async (expr, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (await evaluate(expr)) return true;
      } catch (error) {
        if (!/navigated or closed|Cannot find context|Execution context was destroyed/.test(error.message)) throw error;
      }
      await sleep(50);
    }
    return false;
  };
  const navigate = async (url) => {
    await evaluate('window.__beforeNavigate = true').catch(() => {});
    await send('Page.navigate', { url });
    return until(`!window.__beforeNavigate && document.readyState === 'complete'`, 15000);
  };
  const reload = async () => {
    await evaluate('window.__beforeNavigate = true');
    await send('Page.reload');
    return until(`!window.__beforeNavigate && document.readyState === 'complete'`, 15000);
  };
  const box = (selector) =>
    evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; n.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const mouse = async (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  const click = async (selector, { double = false, button = 'left' } = {}) => {
    const at = await box(selector);
    if (!at) throw new Error(`Nothing to click: ${selector}`);
    await mouse('mouseMoved', at[0], at[1]);
    for (const n of double ? [1, 2] : [1]) {
      await mouse('mousePressed', at[0], at[1], { clickCount: n, button });
      await mouse('mouseReleased', at[0], at[1], { clickCount: n, button });
    }
    await sleep(60);
  };
  const press = async (key, modifiers = 0) => {
    const k = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key };
    const withText = !modifiers && k.text;
    await send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', key, modifiers, ...k, text: withText ? k.text : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, ...k });
    await sleep(40);
  };
  const type = async (value) => {
    await send('Input.insertText', { text: value });
    await sleep(30);
  };
  const screenshot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(data, 'base64'));
  };
  const viewport = (w, h, mobile = false) =>
    send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const close = async () => {
    ws.close();
    chrome.kill();
    await new Promise((r) => chrome.once('exit', r)).catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return { send, evaluate, until, navigate, reload, click, press, type, screenshot, viewport, mouse, box, errors, console: console_, close };
}
