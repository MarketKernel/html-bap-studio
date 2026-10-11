# BAP Studio

A business application builder in **one HTML file**. Describe catalogs, documents with their lines,
registers, forms, lists, actions, reports and dashboards — and work in the application at once, in the
same window. Warehouse, trade, a service desk, simple accounting: the core knows none of them, the
configuration does.

- Opens from disk (`build/bap.html`), no installation, no server; works offline.
- Data sources are **plugins**: the built-in browser database, a REST server
  (`tools/dev-server.mjs` is one), or anything a plugin connects to — a plugin is one `.js` file.
- Two modes, switched with **F12**: *Application* (work with data) and *Designer* (change the
  application). Changes apply at once; **Ctrl/⌘+Z** undoes them.

## Try it

```bash
./build.sh             # npm ci on the first run, then → build/bap.html and build/pages/
open build/bap.html    # or double-click it
```

On the start screen pick **Warehouse and sales**: products in groups, counterparties, receipts and sales
with their lines, a stock register filled by posting, reports with charts, an overview dashboard, an
invoice print form. Sell more than there is in stock and the posting is refused.

Or pick **Personal finances**: accounts and debts in several currencies, recurring operations (a salary on
the 10th, rent on the last day, groceries every evening), one-off ones, reconciliations that find the money
spent without a record, a forecast five years ahead, the day the money runs out, goals with the day they
become affordable. Press **R** to reconcile, **N** for an operation (type `1200+350` into the amount, Enter
to the end). It is the same studio with a different configuration: nothing in the core knows about money
(`src/app/templates-finance.ts`, checked against the numbers of [Cashflow](https://cash.marketkernel.com) in
`tests/finance.mjs`).

The same build also writes **`build/finance.html`**: Personal finances on its own — a *distribution* of the
studio that opens on its application, offers only its own templates and databases, and keeps the designer
hidden until it is switched on in the settings. A distribution is a template built in, nothing more
(`DISTRIBUTIONS` in `build.mjs`).

Then press **F12**: the configuration tree on the left; open a table, a form (drag fields around), a
view (columns, filters, colour rules), an action (its steps), a report, the schema diagram. In the
application, right-click a column header for its field's properties.

### Working together over the network

```bash
node tools/dev-server.mjs --port 8787 --file data/server.json --token secret
```

Start screen → **Connect to a data source** → *REST server* → `http://127.0.0.1:8787/api`, the token.
An empty server offers to create an application in it. Several browsers then share the same data;
a record changed by someone else since you opened it is detected (load theirs / overwrite).

## What is in it

- **Lists**: a virtual grid for 100 000 rows; sorting (Shift for more keys); the auto-filter row
  (`>100`, `10..20`, `abc*`, `=exact`, `!not`, dates `>=01.10.2026`, `2026-10`); grouping by dragging a
  header; totals; conditional formatting; multi-select and group actions; detail tabs of linked
  records under a splitter; a group tree for hierarchical catalogs; CSV export; printing a list.
- **Cards**: automatic or designed forms; reference fields with search, a selection list and "create";
  document lines edited in cells (Insert adds, Enter moves on); computed fields recomputed as you type;
  checks by the fields; posting; print forms.
- **Expressions** everywhere — defaults, computed fields, checks, colour rules, action steps:
  `round(qty * price, 2)`, `sum(lines.amount)`, `coalesce(customer.discount, 0)`,
  `balance('Stock', 'qty', 'product', id)`, `dateDiff('year', birthday, today())`. Over other tables:
  `sumOf('Accounts', 'value', "kind = 'debt'")`, `countOf`, `minOf`, `maxOf`, `lastOf('Sales', 'price',
  "product = $this.product")`, register balances on a date (`balanceAt`); the application's constants as
  `$const.name`. Their own interpreter: no `eval`; what they reach is loaded in one batch before they run.
- **Registers and posting**: a document's posting rules turn its lines into register movements, written
  in one batch with the document; balances can be kept from going negative. Rules may hold only when a
  condition does (an income goes in, an expense out, a transfer both); catalogs post too (an opening
  balance); a closed period keeps what is posted there as it is.
- **Time**: a schedule field (every day at a time, a weekday, a day or the last day of a month, a date of a
  year); a rule by a schedule plans a movement each time it comes round — never stored, counted once its
  moment has passed, and the future ones are a forecast. Versioned tables: an edit opens a new version from
  now, so the past stays as it was.
- **Input**: a document can start with a line for each record of another table (every account for a
  reconciliation, every product for a stocktaking); shortcuts on actions and menu items; quick-entry forms
  (the cursor in a chosen field, Enter to the next and to save); sums typed into number fields; records in
  an order set by hand; application-wide constants (`$const.name`).
- **Actions and triggers**: steps — ask, confirm, create, change the selected records, open, post,
  print, call a plugin, message, stop, if.
- **Reports**: from a table, a document's lines or a register (balances at a date, turnover, or the balance
  at the end of every day, week or month of a period — ahead too); measures from expressions with their own
  conditions; computed columns; groupings by day, week, month or year; charts (bars, stacked, line, area,
  pie, donut) with levels across them; drill-down. `reach()` finds the first step where a measure meets a
  condition: when the money runs out.
- **Dashboards**: KPI tiles from aggregates or expressions, a hero number, text with expressions in it,
  buttons for actions under a widget, charts with a period switch, short lists.
- **Designer**: tables and fields, forms (WYSIWYG), views, menu, actions and triggers, reports,
  connections (import tables of an external source, copy all data to another source), the ER diagram,
  configuration export/import and backups with data.
- Light and dark themes, compact and comfortable density, a command palette (**Ctrl/⌘+K**), phone layout.
- Interface in English, Russian and Ukrainian (more to come).

## Plugins

See [plugins/README.md](plugins/README.md): the contract, the host API, the REST protocol, how to check
a source. Examples to install from a file:

- [plugins/examples/nbu-rates.js](plugins/examples/nbu-rates.js) — the official exchange rates of the
  National Bank of Ukraine as a read-only table (Designer → Connections → Add → Import tables);
- [plugins/examples/export-tools.js](plugins/examples/export-tools.js) — exporters (JSON, Markdown
  table) in every list's Print menu, and an action for the `plugin` step;
- [plugins/examples/forecast-exact.js](plugins/examples/forecast-exact.js) — a report computed by a
  plugin that reads the application's records (with the person's approval): for Personal finances, when
  the money runs out to the moment.

## Security

- The page's Content-Security-Policy pins its one script by hash, allows scripts and workers only from
  `blob:` (that is how plugins run), blocks `eval`, and allows connections to `https:` and to
  `localhost` — the core itself never fetches anything; only plugins do.
- Each plugin runs in a worker of its own and may reach only the hosts its manifest lists and the user
  approved; `fetch` is checked, `XMLHttpRequest`/`WebSocket`/`importScripts` are not available. This
  guards against mistakes, not against a plugin written to do harm: **a plugin is trusted code**, like a
  browser extension — install only what you trust. Changed code is not run until approved again.
- Print forms (HTML the user writes) are shown in a sandboxed iframe that runs no scripts, with every
  value escaped.
- Secrets of connections (tokens) are kept in IndexedDB, never in the configuration or its exports.
- Rights and roles in this version only shape the interface; real protection is the data source's
  (a server checks its token).

## Build and tests

```bash
npm run check     # typecheck, unit tests, build, browser test
npm test          # unit tests only (Node)
node tests/app.mjs --shots shots   # the browser scenario with screenshots (needs Chrome)
node tests/app-finance.mjs --shots shots   # the same for Personal finances
node tests/finance.mjs             # Personal finances against Cashflow's own core (../cashflow, if there)
node tools/i18n.mjs                # missing / unused strings per dictionary
```

## Layout

- `src/core/` — configuration model and checks, expressions, query engine, data service, registers,
  actions, reports, print templates, plugin protocol, contract check (no DOM; tested in Node).
- `src/app/` — the page: frame, lists, cards, reports, dashboards, designers, plugin host.
- `src/plugin-runtime/` — what runs around a plugin in its worker.
- `plugins/` — built-in and example plugins, and the guide for writing one.
- `tools/` — the REST dev server, the Chrome driver for tests, the string extractor.
- `Task.md` — the task this was built from; `docs/notes/` — decisions and probes.

## Limitations

- Firefox and Safari are not tested automatically yet (the plugin path was probed in Chrome; see
  `docs/notes/platform.md`).
- No accounting registers (debit/credit), no calendar views, no XLSX, no real-time collaboration yet.
- Interface dictionaries: Russian and Ukrainian; other languages show English.

## License

MIT
