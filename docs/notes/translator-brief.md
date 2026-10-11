# Brief for translators

Project: BAP Studio, a business application builder (catalogs, documents, registers, forms, reports,
plugins). Interface strings live in the code in English; a dictionary per language translates them.

1. Get the strings: `cd /Users/dmytro/Documents/GitHub/business-application-platform && node tools/i18n.mjs --strings`
   prints `{ context: { "English text": null | ["one form", "other form"] } }` after a first summary line.
2. Write `src/locales/<code>.json`: `{ "context": { "English text": "translation", … }, … }` — the same
   contexts and the same English keys, every string, nothing extra, each context object once.
   - `{name}` placeholders stay exactly as they are (same names), translated text around them.
   - A string with forms `[one, other]` (from `tn()`) is keyed by the English OTHER form and its value is an
     object of plural categories of the language per Intl.PluralRules — Russian and Ukrainian:
     `{ "one": "{count} запись", "few": "{count} записи", "many": "{count} записей", "other": "{count} записи" }`.
   - Keep typographic quotes as the language uses them (Russian/Ukrainian: «…» for quoted names where the
     English has “…”), keep symbols like →, …, ✓, keyboard names (Ctrl, Enter, Insert, F12), code-like tokens
     (JSON, CSV, SVG, PNG, SHA-256, IndexedDB, REST, HTTPS, $params, doc.x, field names in examples like
     `round(qty * price, 2)`, `today()`, `INV-{0000}`, `{000000}`) untouched.
   - Do NOT translate product names: "BAP Studio", "IndexedDB", "Chrome", "Edge".
   - Terminology is that of 1C / business accounting software in the language: catalog = справочник/довідник,
     document = документ, register = регистр/регістр, posting = проведение/проведення, post = провести,
     dimension = измерение/вимір, resource = ресурс, part (table part) = табличная часть/таблична частина,
     view = представление/подання, form = форма, action = действие/дія, trigger = триггер/тригер,
     designer = конструктор, workspace/application = приложение/застосунок, connection = подключение/підключення,
     data source = источник данных/джерело даних, record = запись/запис, field = поле.
   - Short UI labels stay short (buttons, column headers). Use the imperative for buttons as the language's
     software does ("Сохранить", "Зберегти").
   - The context "template" holds the demo application's texts (product names, customer names, report
     titles): translate them naturally, as a real shop in that country would name them; keep SKUs and codes.
3. Check: `node -e "JSON.parse(require('fs').readFileSync('src/locales/<code>.json','utf8'))"` and
   `node tools/i18n.mjs` — your language must show `0 missing, 0 unused`.
4. Only write your own file. Do not run git.
