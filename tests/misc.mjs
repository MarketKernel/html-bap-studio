/**
 * The small pure modules: plugin protocol (manifests, hosts, errors), print
 * templates (escaping above all), CSV, number and date formats, sums in words.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const P = await load('core/plugin-protocol');
const { renderTemplate } = await load('core/template');
const { toCsv, parseCsv } = await load('core/csv');
const F = await load('core/format');

// Hosts.
const hosts = ['https://bank.gov.ua', 'https://*.example.com', 'http://localhost', 'http://127.0.0.1:8787'];
for (const [url, ok] of [
  ['https://bank.gov.ua/api?json', true],
  ['http://bank.gov.ua/api', false],
  ['https://evil.bank.gov.ua/', false],
  ['https://a.example.com/x', true],
  ['https://example.com/x', true],
  ['https://badexample.com/x', false],
  ['http://localhost:3000/api', true],
  ['http://127.0.0.1:8787/api', true],
  ['http://127.0.0.1:9999/api', false],
  ['not a url', false],
]) check(`host ${url}`, P.hostAllowed(url, hosts), ok);
check('any https', [P.hostAllowed('https://x.y/z', ['https://*']), P.hostAllowed('http://x.y/z', ['https://*'])], [true, false]);
check('normalizeHost rejects paths', P.normalizeHost('https://a.com/path'), null);

// Manifests.
check('good manifest', P.checkManifest({ id: 'a-b', name: 'A', version: '1.0.0', apiVersion: 1, contributes: {}, permissions: { hosts: ['https://a.com'] } }), []);
check('bad manifest', P.checkManifest({ id: 'A B', version: '1', apiVersion: 9, permissions: { hosts: ['ftp://x'] } }).length, 6);
check('no manifest', P.checkManifest(undefined).length, 1);
// Errors across the boundary.
check('wire error keeps code', P.toWireError(new P.PluginError('conflict', 'changed', { id: 'x' })), { code: 'conflict', message: 'changed', details: { id: 'x' } });
check('fetch failure is network', P.toWireError(new TypeError('Failed to fetch')).code, 'network');
check('anything else is internal', P.toWireError('oops'), { code: 'internal', message: 'oops' });
check('capabilities default to no', P.normalizeCapabilities({ write: true, query: { where: true } }).query, { where: true, orderBy: false, paging: false, count: false, aggregate: false });

// Templates: values are escaped, the template's own HTML is not.
const helpers = { format: (v, kind) => (kind === 'money' ? Number(v).toFixed(2) : String(v)), words: (v) => `words(${v})`, translate: (s) => `[${s}]` };
const rec = { number: 'SL-1', customer: { name: '<script>alert(1)</script> & Co' }, lines: [{ product: { name: 'A' }, qty: 2 }, { product: { name: 'B "q"' }, qty: 3 }], total: 12.5, empty: [] };
check('value escaped', renderTemplate('<b>{{customer.name}}</b>', rec, helpers), '<b>&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co</b>');
check('each with @number', renderTemplate('{{#each lines}}{{@number}}.{{product.name}}={{qty}};{{/each}}', rec, helpers), '1.A=2;2.B &quot;q&quot;=3;');
check('format and words', renderTemplate('{{format total "money"}} {{amountInWords total}} {{t "Total"}}', rec, helpers), '12.50 words(12.5) [Total]');
check('if / else', renderTemplate('{{#if empty}}yes{{else}}no{{/if}}{{#if number}}!{{/if}}', rec, helpers), 'no!');
check('outer scope inside each', renderTemplate('{{#each lines}}{{number}}{{/each}}', rec, helpers), 'SL-1SL-1');

// CSV.
const rows = [['a', 'b,c', 'd"e', 'line\nbreak', 1.5, null]];
const text = toCsv(rows);
check('csv quoting', text, 'a,"b,c","d""e","line\nbreak",1.5,\r\n');
check('csv round trip', parseCsv(text), [['a', 'b,c', 'd"e', 'line\nbreak', '1.5', '']]);
check('csv semicolons and BOM', parseCsv('﻿x;y\r\n1;2\r\n'), [['x', 'y'], ['1', '2']]);

// Numbers and dates as typed.
check('parse numbers', [F.parseNumber('1 234,5'), F.parseNumber('1,234.5'), F.parseNumber(''), Number.isNaN(F.parseNumber('abc'))], [1234.5, 1234.5, null, true]);
check('parse iso date', F.parseDate('2026-10-08'), '2026-10-08');
check('parse impossible date', F.parseDate('2026-02-30'), null);

// Sums in words.
check('words ru', F.amountInWords(1234.56, 'ru', 'UAH'), 'Одна тысяча двести тридцать четыре гривны 56 коп.');
check('words uk', F.amountInWords(21, 'uk', 'UAH'), 'Двадцять одна гривня 00 коп.');
check('words uk 11', F.amountInWords(11, 'uk', 'UAH'), 'Одинадцять гривень 00 коп.');
check('words en', F.amountInWords(1001.5, 'en', 'USD'), 'One thousand one USD 50/100');
check('words ru million', F.amountInWords(2000000, 'ru', 'RUB'), 'Два миллиона рублей 00 коп.');
done('misc');
