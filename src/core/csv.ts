/**
 * CSV as spreadsheets write and read it (RFC 4180): fields with the
 * separator, quotes or line breaks are quoted, quotes doubled. Reading takes a
 * byte order mark, CRLF or LF, and guesses the separator — Excel in many
 * locales writes ';'.
 */

export function toCsv(rows: unknown[][], separator = ','): string {
  return `${rows.map((row) => row.map((v) => cell(v, separator)).join(separator)).join('\r\n')}\r\n`;
}

function cell(v: unknown, separator: string): string {
  const s = v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v);
  return s.includes(separator) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function guessSeparator(text: string): string {
  const line = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((s) => [s, line.split(s).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

export function parseCsv(text: string, separator = guessSeparator(text)): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === separator) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
