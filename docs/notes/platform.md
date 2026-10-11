# Platform probe (stage 0)

`node tools/spike-workers.mjs` — Chrome 141, headless, page opened from `file://`, CSP
`default-src 'none'; script-src 'sha256-…' blob:; worker-src blob:; connect-src https: http://127.0.0.1:*`.

| What | Result |
| --- | --- |
| `new Worker(blobUrl, { type: 'module' })` | **Fails**: "Refused to cross-origin redirects of the top-level worker script" (opaque `null` origin). |
| Classic `new Worker(blobUrl)` | Works. |
| In it, `import(blobUrl)` of a blob made **by the page** | Fails: "Not allowed to load local resource". |
| In it, `import(blobUrl)` of a blob made **inside the worker** from the code string | **Works.** ES module plugins with `export`. |
| In it, `importScripts(blobUrl)` | Fails. |
| `fetch` from the worker to `http://127.0.0.1` with `Access-Control-Allow-Origin: *` | Works, `Origin: null`. |
| `fetch` to `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json` | Works: NBU answers CORS for `null`. |
| IndexedDB, `showDirectoryPicker` on `file://` | Available. |
| `eval` under this CSP | Blocked — as intended. |

Decision: every plugin runs in a **classic** worker made from a `blob:` URL; the page sends the
plugin's source as a string, the worker runtime turns it into its own `blob:` URL and `import()`s
it. Plugins stay ES modules.

Not verified automatically: Firefox and Safari (no driver in this setup). To check by hand: open
the probe's page in them; the same path is expected to work (classic blob workers and dynamic
`import()` in workers are supported in both). Recorded as a known gap.
