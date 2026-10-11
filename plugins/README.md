# Writing a plugin for BAP Studio

A plugin is **one ES module file** (`.js`). It exports a `manifest` and what it contributes:
`dataSources` (where the data lives — the main kind), `actions` (commands a button or an action step
can call) and `exporters` (records → a file). The studio runs every plugin in a worker of its own;
the plugin and the page exchange plain data (structured clone), never functions.

- `builtin/` — plugins built into `bap.html`: `local` (IndexedDB in the browser) and `rest` (a server
  speaking the REST protocol below). They are TypeScript, bundled by `build.mjs`.
- `examples/` — plugins to install from a file: `nbu-rates.js`, read-only exchange rates from the web.

Install a plugin: **Plugins → Install from a file…**, drop a `.js` on the plugin manager, or connect a
`plugins` folder (Chrome and Edge remember it and re-read it on start). The user sees the manifest —
name, version, the hosts it may reach, the SHA-256 of the code — and approves it. A plugin whose code
changes is not started again until approved again.

## The smallest data source

```js
export const manifest = {
  id: 'my-source',            // lowercase letters, digits, dashes; unique
  name: 'My source',
  version: '1.0.0',
  apiVersion: 1,              // the contract version
  contributes: { dataSources: ['main'] },
  permissions: { hosts: ['https://api.example.com'] },  // the only places fetch may go
};

export const dataSources = {
  main: {
    title: 'My source',
    settings: [                                     // the studio draws the form
      { key: 'url', type: 'url', title: 'Address', required: true },
      { key: 'token', type: 'password', title: 'Token', secret: true },  // kept apart, never exported
    ],
    async connect(settings, host) {
      return {
        capabilities: () => ({ write: false, schema: 'external' }),
        describe: async () => ({ tables: [{ name: 'Items', key: 'id', fields: [{ name: 'name', type: 'string' }] }] }),
        async query(q) {
          const res = await host.fetch(`${settings.url}/items`);
          const rows = await res.json();
          return { rows, total: rows.length };      // the studio filters, sorts and pages what you cannot
        },
      };
    },
  },
};
```

## The contract (apiVersion 1)

The types are in `src/core/plugin-protocol.ts`; the query types in `src/core/query/types.ts`.

**Capabilities** say what the source does itself; what it does not, the studio does on the client with
the same engine the built-in source uses — so a minimal source still gets filters, sorting, grouping,
totals and reports.

| Field | Meaning |
| --- | --- |
| `write` | false → its tables are read-only |
| `schema` | `managed`: stores whatever the configuration describes (`applySchema` is called on changes); `external`: has its own tables (`describe()`) |
| `query.where / orderBy / paging / count / aggregate` | does it filter, sort, page, count, aggregate itself |
| `batch` | `batch(ops)` is all-or-nothing (a document and its register movements are written together) |
| `config` | keeps the application's configuration (`loadConfig` / `saveConfig`) |
| `sequences` | atomic counters for document numbers (`nextNumber`) |
| `changes` | tells the page about changes made elsewhere (`host.emitChanges`) |

**Methods** (all async except `capabilities`): `query(q)`, `get(table, id)`, `insert(table, row)`,
`update(table, id, patch, expectedRev)`, `delete(table, id, expectedRev)`, `batch(ops)`, `aggregate(q)`,
`describe()`, `applySchema(changes)`, `loadConfig()`, `saveConfig(doc, expectedRev)`,
`nextNumber(sequence)`, `close()`. Only `capabilities` and `query` are required.

**Values**: numbers are numbers; a date is `'YYYY-MM-DD'`, a date-time `'YYYY-MM-DDTHH:mm:ss'` (local,
no zone); a reference is the referenced record's `id` string. Every record has `id` (string; new
records usually come with a UUID v7 made by the studio) and `_rev` (a revision string you assign).

**Optimistic locking**: `update` and `delete` get the `_rev` the user saw; if the record changed since,
throw `{ code: 'conflict' }` — the studio offers "load theirs / overwrite".

**Errors**: throw an object or Error with a `code`: `conflict`, `not_found`, `validation` (with
`details`), `auth`, `forbidden`, `network`, `timeout`, `unsupported`, `internal`. The studio shows a
message per code.

**The host** (`connect`'s second argument): `host.fetch(url, init)` — fetch limited to the manifest's
hosts (the global `fetch` is limited the same way; `XMLHttpRequest`, `WebSocket`, `EventSource`,
`importScripts` are not available); `host.settings`; `host.storage.get/set/delete` (a key-value store of
the plugin's own, in IndexedDB); `host.log(level, message)` (shown in the plugin manager);
`host.progress(fraction, text)`; `host.emitChanges([{ table, id, op }])`.

Host patterns: `https://api.example.com`, `https://*.example.com` (any subdomain), `http://localhost`
(any port), `http://localhost:8080`, `https://*` (any https host — for a source whose server the user
types in).

### Checking a source

**Plugins → Check** runs the contract check (`src/core/contract.ts`) against a scratch table of the
source: CRUD, revisions and conflicts, every filter operator, sorting, paging, batches, sequences,
types, 1000 rows. The same check runs in `tests/contract.mjs` for the built-in sources.

## The REST protocol

The `rest` data source talks to any server that answers these endpoints under a base address (e.g.
`https://example.com/api`). `tools/dev-server.mjs` is the reference implementation:

```bash
node tools/dev-server.mjs --port 8787 --file data/server.json [--token secret]
```

| Request | Answer |
| --- | --- |
| `GET /capabilities` | the Capabilities object (optional; without it the studio does queries itself) |
| `POST /query` — body: Query | `{ rows, total?, cursor? }` |
| `POST /aggregate` — body: AggregateQuery | `{ rows }` |
| `GET /tables/:table/:id` | the row, or 404 |
| `POST /tables/:table` — body: row | the stored row with `_rev` (201) |
| `PATCH /tables/:table/:id` — body: `{ patch, expectedRev }` | the stored row |
| `DELETE /tables/:table/:id?rev=…` | 204 |
| `POST /batch` — body: `{ ops }` | `{ results }`, all or nothing |
| `POST /schema` — body: `{ changes }` | `{ ok: true }` |
| `GET /config` | `{ doc, rev }`, or 404 when there is none |
| `PUT /config` — body: `{ doc, expectedRev }` | `{ rev }` |
| `POST /sequences/:name` | `{ value }` |
| `GET /whoami` | `{ user }` |

Errors: HTTP status and `{ "error": { "code", "message", "details"? } }` — 400 validation, 401 auth,
403 forbidden, 404 not_found, 409 conflict, 501 unsupported. Authorization: `Authorization: Bearer
<token>` when the user gives a token. CORS: the page may be opened from a file (`Origin: null`), so the
server must answer CORS for any origin it accepts, including `null`.

## Actions and exporters

```js
export const actions = {
  hello: { title: 'Say hello', async run(args, host) { return `Hello, ${args.name}`; } },
};
export const exporters = {
  json: { title: 'JSON', extension: 'json', async export({ table, rows, columns }) {
    return new Blob([JSON.stringify(rows)], { type: 'application/json' });
  } },
};
```

An action step `plugin` calls an action with arguments computed by expressions; a returned Blob is
offered to the user as a download.

## Reports over the application's data

A plugin may read the application's records — read-only — and compute a report of its own, for what
the studio's reports cannot say. It asks for it in the manifest; the person sees "reads the records of
the application" before approving it, and a plugin that did not ask gets `forbidden` from every call.

```js
export const manifest = {
  id: 'forecast-exact', name: 'Forecast to the moment', version: '1.0.0', apiVersion: 1,
  contributes: { reports: ['lastsUntil'] },
  permissions: { data: 'read' },
};
export const reports = {
  lastsUntil: {
    title: 'When the money runs out',
    async run(params, host) {
      const now = await host.data.evaluate('now()');                       // any expression of no record
      const accounts = (await host.data.query({ table: 'Accounts' })).rows; // rows with their computed fields
      const moves = await host.data.movements('Money', '2031-12-31');      // stored and planned, up to a date
      const config = await host.data.config();                             // the configuration
      return {
        columns: [{ key: 'what', title: 'What' }, { key: 'when', title: 'When', type: 'datetime' }],
        rows: [{ what: 'On the accounts', when: '2027-03-01T09:00:00' }],
        chart: undefined,                                                   // or { type, x, series }
      };
    },
  },
};
```

A report in the configuration names it with `plugin: { plugin: 'forecast-exact', report: 'lastsUntil' }`
(Designer → a report → "Computed by"); it gets the period chosen above it in `params.period` and is
shown like any other — table, chart, dashboard widget. A number column with `total: false` gets no sum
under it. The whole example is [examples/forecast-exact.js](examples/forecast-exact.js).
