/**
 * PNG icons of the PWA, rendered from assets/icon.svg by headless Chrome —
 * no image tools needed. Run when the icon changes: `node tools/icons.mjs`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './load.mjs';
import { launch } from './chrome.mjs';

const svg = await readFile(join(root, 'assets', 'icon.svg'), 'utf8');
const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const c = await launch({ width: 600, height: 600 });
await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
// Maskable: the platform cuts a circle or a squircle; the drawing keeps to the middle 80%.
for (const [name, size, pad, bg] of [['icon-192.png', 192, 0, ''], ['icon-512.png', 512, 0, ''], ['icon-maskable-512.png', 512, 0.12, '#2f5bd3'], ['apple-touch-icon.png', 180, 0.08, '#2f5bd3']]) {
  await c.viewport(size, size);
  await c.evaluate(`document.documentElement.innerHTML = '<body style="margin:0;background:${bg || 'transparent'}"><img src="${uri}" style="display:block;width:${size * (1 - 2 * pad)}px;height:${size * (1 - 2 * pad)}px;margin:${size * pad}px"></body>'; new Promise((r) => setTimeout(r, 100))`);
  const { data } = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  await writeFile(join(root, 'assets', 'pwa', name), Buffer.from(data, 'base64'));
  console.log(`assets/pwa/${name}`);
}
await c.close();
