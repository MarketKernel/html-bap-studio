/**
 * Print preview (Task.md 11.4): the template filled for each record, one per
 * page, in a sandboxed iframe — no scripts run there, and the data was
 * escaped by core/template.ts. "Print" prints the iframe, and the browser's
 * dialog saves a PDF too.
 */
import { t } from '../../core/i18n';
import { allFields, table as tableOf } from '../../core/config/model';
import type { PrintTemplateDef, TableDef } from '../../core/config/types';
import type { DataService } from '../../core/data';
import { amountInWords, formatDate, formatDateTime, formatNumber } from '../../core/format';
import type { Row } from '../../core/query/types';
import { renderTemplate } from '../../core/template';
import { button, h } from '../dom';
import type { App, Page } from '../app';

const PRINT_CSS = `
  @page { size: A4; margin: 14mm; }
  body { font: 12px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #111; margin: 0; padding: 18px; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  h2 { font-size: 16px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .words { font-style: italic; }
  .page + .page { break-before: page; border-top: 1px dashed #bbb; margin-top: 24px; padding-top: 18px; }
  @media print { body { padding: 0; } .page + .page { border: 0; margin: 0; padding: 0; } }
`;

/** A record with its references replaced by the referenced records, for {{customer.name}}. */
export async function deepRecord(data: DataService, tb: TableDef, row: Row): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...row };
  for (const f of allFields(tb)) {
    if (f.type === 'ref' && f.ref && row[f.name]) out[f.name] = (await data.rowsById(f.ref)).get(String(row[f.name])) ?? { id: row[f.name] };
  }
  for (const part of tb.parts ?? []) {
    const lines = Array.isArray(row[part.name]) ? (row[part.name] as Record<string, unknown>[]) : [];
    const deep = [];
    for (const line of lines) {
      const copy: Record<string, unknown> = { ...line };
      for (const f of part.fields) if (f.type === 'ref' && f.ref && line[f.name]) copy[f.name] = (await data.rowsById(f.ref)).get(String(line[f.name])) ?? { id: line[f.name] };
      deep.push(copy);
    }
    out[part.name] = deep;
  }
  return out;
}

export function printRecords(app: App, template: PrintTemplateDef, tb: TableDef, rows: Row[], ready?: string): void {
  const frame = h('iframe', { class: 'print-frame', sandbox: 'allow-same-origin allow-modals', title: template.title });
  const page: Page = {
    id: `print:${template.key}:${rows.map((r) => r.id).join(',').slice(0, 200)}`,
    title: `${t('print', 'Print')}: ${template.title}`,
    icon: 'print',
    el: h(
      'div',
      { class: 'page' },
      h('div', { class: 'toolbar' }, button(t('print', 'Print'), { icon: 'print', class: 'primary', onClick: () => frame.contentWindow?.print() }), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, t('print', 'The browser’s print dialog can also save a PDF'))),
      frame,
    ),
  };
  app.openPage(page);
  void (async () => {
    let body = ready ?? '';
    if (!ready) {
      const data = app.data;
      const parts: string[] = [];
      const currency = data.config.app.currency ?? 'UAH';
      for (const row of rows) {
        const fresh = (await data.get(tb.name, row.id)) ?? row;
        await data.compute(tb, [fresh]);
        const deep = await deepRecord(data, tb, fresh);
        parts.push(
          `<section class="page">${renderTemplate(template.html, deep, {
            format: (v, kind) => {
              if (v === null || v === undefined) return '';
              if (kind === 'money' && typeof v === 'number') return formatNumber(v, 2, true);
              if (kind === 'number' && typeof v === 'number') return formatNumber(v);
              if (kind === 'date' && typeof v === 'string') return formatDate(v);
              if (kind === 'datetime' && typeof v === 'string') return formatDateTime(v);
              if (typeof v === 'number') return formatNumber(v);
              if (typeof v === 'boolean') return v ? '✓' : '';
              return String(v);
            },
            words: (v) => (typeof v === 'number' ? amountInWords(v, undefined, currency) : ''),
            // {{t "Text"}} in a template: the template's author chose the text, so it cannot be
            // extracted; the dictionaries may still carry it under "print".
            translate: (text) => t('print', text),
          })}</section>`,
        );
      }
      body = parts.join('\n');
    }
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
  })().catch((error: unknown) => app.fail(error, template.title));
  void tableOf;
}
