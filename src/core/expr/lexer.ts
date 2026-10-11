/**
 * Splits an expression into tokens. Every token keeps its source offsets, so a
 * syntax error can point at the exact characters that caused it.
 */
import { t } from '../i18n';

export class ExprError extends Error {
  pos: number;
  end: number;
  constructor(message: string, pos: number, end: number) {
    super(message);
    this.name = 'ExprError';
    this.pos = pos;
    this.end = end;
  }
}

export type TokenType = 'number' | 'string' | 'date' | 'name' | 'op' | 'eof';

export interface Token {
  type: TokenType;
  /** The number, the unescaped string, the date text, the name as written, or the operator. */
  value: string | number;
  pos: number;
  end: number;
}

const OPERATORS = ['<>', '!=', '<=', '>=', '(', ')', ',', '.', '+', '-', '*', '/', '%', '&', '=', '<', '>'];

const NAME_START = /[\p{L}_$]/u;
// Marks keep names in scripts like Devanagari whole.
const NAME_PART = /[\p{L}\p{M}\p{N}_]/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Whether text is a real calendar date or date-time in the literal form. */
export function validDateLiteral(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  if (d > daysInMonth(y, mo)) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59)) return false;
  return true;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in month `m` (1–12) of year `y`. */
export function daysInMonth(y: number, m: number): number {
  if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return 29;
  return MONTH_DAYS[m - 1] ?? 30;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i] as string;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const start = i;
    if (c >= '0' && c <= '9') {
      while (i < n && isDigit(source[i])) i += 1;
      // A dot is a decimal point only when a digit follows; otherwise it stays an operator.
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i += 1;
        while (i < n && isDigit(source[i])) i += 1;
      }
      tokens.push({ type: 'number', value: Number(source.slice(start, i)), pos: start, end: i });
      continue;
    }
    if (c === "'" || c === '"') {
      let text = '';
      i += 1;
      for (;;) {
        if (i >= n) throw new ExprError(t('expr', 'The text is not closed with a quote'), start, n);
        const ch = source[i] as string;
        if (ch === c) {
          // A doubled quote stands for one quote character inside the text.
          if (source[i + 1] === c) {
            text += c;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        text += ch;
        i += 1;
      }
      tokens.push({ type: 'string', value: text, pos: start, end: i });
      continue;
    }
    if (c === '#') {
      const close = source.indexOf('#', i + 1);
      if (close < 0) throw new ExprError(t('expr', 'The date is not closed with “#”'), start, n);
      const text = source.slice(i + 1, close).trim();
      i = close + 1;
      if (!validDateLiteral(text)) throw new ExprError(t('expr', 'Invalid date “{text}”', { text }), start, i);
      tokens.push({ type: 'date', value: text.length === 16 ? `${text}:00` : text, pos: start, end: i });
      continue;
    }
    const cp = String.fromCodePoint(source.codePointAt(i) as number);
    if (NAME_START.test(cp)) {
      i += cp.length;
      while (i < n) {
        const part = String.fromCodePoint(source.codePointAt(i) as number);
        if (!NAME_PART.test(part)) break;
        i += part.length;
      }
      tokens.push({ type: 'name', value: source.slice(start, i), pos: start, end: i });
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      i += op.length;
      tokens.push({ type: 'op', value: op === '!=' ? '<>' : op, pos: start, end: i });
      continue;
    }
    throw new ExprError(t('expr', 'Unexpected character “{char}”', { char: cp }), start, start + cp.length);
  }
  tokens.push({ type: 'eof', value: '', pos: n, end: n });
  return tokens;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}
