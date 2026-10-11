/**
 * The dictionaries in src/locales against the strings the interface shows:
 * no stale keys, the same placeholders as the English text, a form for every
 * plural category of the language — and the lookup itself in src/core/i18n.ts.
 * A string a dictionary lacks is only reported: it is shown in English.
 */
import { checker, load } from '../tools/load.mjs';
import { compare, dictionaries, extract } from '../tools/i18n.mjs';

const { check, done } = checker();
const I = await load('core/i18n');
const strings = await extract();
const all = await dictionaries();
const placeholders = (text) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();

// Russian and Ukrainian came first (Task.md 17); the others are added at the translation stage.
check('dictionaries are known languages', Object.keys(all).every((code) => code in I.LANGUAGES && code !== 'en'), true);

for (const [language, dictionary] of Object.entries(all)) {
  const { missing, unused } = compare(strings, dictionary);
  check(`${language}: no unused strings`, unused, []);
  const lacking = Object.entries(missing).flatMap(([context, texts]) => Object.keys(texts).map((text) => `${context} / ${text}`));
  if (lacking.length) console.log(`  ${language}: ${lacking.length} strings not translated (shown in English)`);

  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories.slice().sort();
  const problems = [];
  for (const [context, texts] of Object.entries(dictionary)) {
    for (const [text, value] of Object.entries(texts)) {
      const forms = strings[context]?.[text];
      if (forms === undefined) continue;
      const expected = placeholders(text);
      if (forms === null || typeof value === 'string') {
        if (typeof value !== 'string' || !value.trim()) problems.push(`${context} / ${text}: not a text`);
        else if (JSON.stringify(placeholders(value)) !== JSON.stringify(expected)) problems.push(`${context} / ${text}: placeholders ${placeholders(value)}`);
        continue;
      }
      if (!value || typeof value !== 'object') {
        problems.push(`${context} / ${text}: neither a text nor plural forms`);
        continue;
      }
      if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(categories)) {
        problems.push(`${context} / ${text}: forms ${Object.keys(value)}, the language has ${categories}`);
      }
      for (const [category, form] of Object.entries(value)) {
        // A form may leave the number out ("one entry"), never anything else.
        const needed = expected.filter((name) => name !== '{count}');
        const got = placeholders(form);
        if (!got.every((name) => expected.includes(name)) || !needed.every((name) => got.includes(name))) {
          problems.push(`${context} / ${text} [${category}]: placeholders ${got}`);
        }
      }
    }
  }
  check(`${language}: well-formed translations`, problems, []);
}

// Each context object once: a second one with the same name would silently replace the first.
const { readFile, readdir } = await import('node:fs/promises');
const { join } = await import('node:path');
const { root } = await import('../tools/load.mjs');
for (const name of await readdir(join(root, 'src', 'locales'))) {
  const text = await readFile(join(root, 'src', 'locales', name), 'utf8');
  const contexts = [...text.matchAll(/^  "([^"]+)": \{/gm)].map((m) => m[1]);
  check(`${name}: each context once`, contexts.length, new Set(contexts).size);
}

// The lookup
check('english by default', I.t('list', 'Delete'), 'Delete');
check('placeholders filled', I.t('list', 'Delete “{name}”?', { name: 'X' }), 'Delete “X”?');
check('english plural: one', I.tn('grid', '{count} record', '{count} records', 1), '1 record');
check('english plural: other', I.tn('grid', '{count} record', '{count} records', 3), '3 records');
if (all.ru?.grid?.['{count} records']) {
  I.setLanguage('ru');
  check('translated', I.t('list', 'Delete'), all.ru.list.Delete);
  check('unknown text stays english', I.t('list', 'No such thing'), 'No such thing');
  const forms = all.ru.grid['{count} records'];
  check('russian plural: one', I.tn('grid', '{count} record', '{count} records', 21), forms.one.replace('{count}', '21'));
  check('russian plural: few', I.tn('grid', '{count} record', '{count} records', 3), forms.few.replace('{count}', '3'));
  check('russian plural: many', I.tn('grid', '{count} record', '{count} records', 11), forms.many.replace('{count}', '11'));
}
I.setLanguage('ar');
check('arabic is right to left', I.isRightToLeft(), true);
I.setLanguage('en');
check('browser language: ukrainian', I.detectLanguage(['uk-UA', 'ru', 'en']), 'uk');
check('browser language: none known', I.detectLanguage(['nl', 'sv']), 'en');
done('i18n');
