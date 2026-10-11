# Brief for designer modules (shared by the agents writing them)

Project: BAP Studio, /Users/dmytro/Documents/GitHub/business-application-platform. Read Task.md sections 8–9
first, then these files to learn the conventions — copy their style:

- `src/core/config/types.ts` — the configuration model (ViewDef, FormDef/FormNode, MenuNode, ActionDef,
  Step, TriggerDef, ReportDef, ConnectionDef…). Do not change existing types; additive optional fields only
  if truly needed (say so in your report).
- `src/core/config/model.ts` — lookups (`table()`, `allFields()`, `field()`, `fieldAtPath()`, `newKey()`,
  `defaultView()`, `defaultForm()`, `formFor()`, `menuOf()`).
- `src/app/designer/table.ts` — **the reference designer**: a `Page` with toolbar, main area and a `.props`
  panel on the right; every edit goes through `this.shell.session.change((draft) => …)` (a copy of the
  config: mutate it; the session validates, applies schema changes, saves a revision; undo/redo work);
  `configChanged()` is called on every page after any change — re-render there.
- `src/app/designer/props.ts` — property controls: `section`, `textProp`, `numberProp`, `checkProp`,
  `selectProp`, `exprProp` (expression with live checking), `iconProp`, `typeTitle`.
- `src/app/designer/index.ts` — `openDesigner(shell, target)`, the designer tree, helpers `identFrom`,
  `uniqueName`, `createView`, `createForm`.
- `src/app/dom.ts` (`h`, `svg`, `icon`, `button`, `clear`), `src/app/ui.ts` (`dialog`, `confirm`, `prompt`,
  `toast`, `popupMenu`), `src/app/grid.ts` (the data grid), `src/app/pages/card.ts` (`renderLayout` +
  `LayoutRenderers` — the form designer must render its canvas with the same function, passing `wrap`),
  `src/app/pages/list.ts`, `src/app/fields.ts` (`editorFor`, `gridColumns`).
- `src/app/shell.ts` — `Shell` (implements `App` from `src/app/app.ts`): `session`, `data`, `openPage`,
  `closePage`, `updateTab`, `openTarget`, `openRecord`, `fail(error)`, `status(text)`.

Rules:
- TypeScript strict (noUncheckedIndexedAccess, verbatimModuleSyntax → `import type`), no dependencies, DOM by hand.
- Every user-visible string: `t('<context>', 'English text {name}', { name })` from `src/core/i18n`,
  single-quoted literal only (a regex extracts them). English in code.
- Comments: sparse prose explaining *why*, file header comment explaining what the module is.
- CSS: put your styles in your own file `src/app/designer/<module>.css` (the build concatenates every .css
  under src/app after styles.css). Use the existing tokens (`var(--surface)`, `--border`, `--accent`,
  `--text-2`…) and existing classes (`.toolbar`, `.props`, `.prop`, `.designer`, `.designer-main`, `.canvas`,
  `.canvas-form`, `.d-node`, `.d-label`, `.palette-items`, `.chip-list`, `.steps`, `.step`, `.f-group`,
  `.design-table`, `.er …`) — they are already in styles.css. Use logical properties (inline-start/end).
- Each designer class keeps its constructor signature as in the current placeholder file
  (`constructor(shell: Shell, ...args)`) because `designer/index.ts` constructs it; its `id` must be the
  same string index.ts expects: `design:<kind>:<key>` (see openDesigner in index.ts).
- Only edit the files you own. Other agents are editing other designer files at the same time.
- Done = `npx tsc --noEmit -p .` has no errors in your files, `node build.mjs` succeeds, and a browser check
  with `tools/chrome.mjs` (see the snippet below) shows your page working without page errors. Look at a
  screenshot of your page (Read the PNG) and fix what looks wrong.

Browser check snippet (write it to a temp file outside the repo, e.g. /tmp/<you>-check.mjs):

```js
import { launch, sleep } from '/Users/dmytro/Documents/GitHub/business-application-platform/tools/chrome.mjs';
const c = await launch();
await c.navigate('file:///Users/dmytro/Documents/GitHub/business-application-platform/build/bap.html');
await c.until(`document.querySelector('.tile')`, 10000);
await c.click('[data-template="warehouse"]');               // creates the demo app with data
await c.until(`document.querySelector('.shell') && !document.querySelector('.overlay')`, 60000);
await c.evaluate(`bap.setMode('design')`);                   // window.bap is the Shell
await c.evaluate(`bap.openDesigner({ kind: 'form', name: 'Sales' })`); // or view / action / report / menu / diagram / connections
await sleep(1000);
await c.screenshot('/tmp/<you>-1.png');
console.log(c.errors);                                       // page errors; must be empty
await c.close();
```
Selectors for the current page: `.page-host > .page:not(.hidden-page)`.
