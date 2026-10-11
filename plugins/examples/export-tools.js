/**
 * Example of exporters and actions — the other two kinds of plugin
 * contributions. Install it from a file; the list's Print menu then offers
 * "JSON" and "Markdown table", and an action step "plugin" can call
 * `export-tools` / `summary`.
 *
 * It reaches no host at all: everything happens on the data the studio passes.
 */
export const manifest = {
  id: 'export-tools',
  name: 'Export tools',
  version: '1.0.0',
  apiVersion: 1,
  author: 'BAP Studio examples',
  description: 'Exports a list as JSON or as a Markdown table; an action that sums a field of the selected records.',
  contributes: { exporters: ['json', 'markdown'], actions: ['summary'] },
  permissions: { hosts: [] },
};

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export const exporters = {
  json: {
    title: 'JSON',
    extension: 'json',
    async export({ rows, columns }) {
      const out = rows.map((row) => Object.fromEntries(columns.map((c) => [c.title, row[c.field] ?? null])));
      return new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    },
  },
  markdown: {
    title: 'Markdown table',
    extension: 'md',
    async export({ table, rows, columns }) {
      const head = `| ${columns.map((c) => cell(c.title)).join(' | ')} |`;
      const line = `| ${columns.map(() => '---').join(' | ')} |`;
      const body = rows.map((row) => `| ${columns.map((c) => cell(row[c.field])).join(' | ')} |`);
      return new Blob([`# ${table}\n\n${[head, line, ...body].join('\n')}\n`], { type: 'text/markdown' });
    },
  },
};

export const actions = {
  summary: {
    title: 'Sum of a field',
    async run(args) {
      const values = Array.isArray(args.values) ? args.values : [];
      const total = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
      return `${values.length} values, total ${Math.round(total * 100) / 100}`;
    },
  },
};
