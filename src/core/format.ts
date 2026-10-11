/**
 * Values as people see and type them: numbers with the locale's separators,
 * dates in the locale's order, enums by their titles. Stored values keep the
 * one convention of Task.md 5.4 (ISO dates, plain numbers); this is only the
 * surface.
 */
import { language, t } from './i18n';
import { readSchedule } from './schedule';
import type { EnumValue, FieldDef } from './config/types';

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(digits: number, min = digits): Intl.NumberFormat {
  const key = `${language()}:${digits}:${min}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(language(), { minimumFractionDigits: min, maximumFractionDigits: digits });
    numberFormats.set(key, f);
  }
  return f;
}

export function formatNumber(value: number, scale?: number, fixed = false): string {
  if (!Number.isFinite(value)) return '';
  if (scale === undefined) return nf(6, 0).format(value);
  return nf(scale, fixed ? scale : Math.min(scale, Number.isInteger(value) ? 0 : scale)).format(value);
}

let dateOrder: string | null = null;
let dateOrderLang = '';
/** 'dmy', 'mdy' or 'ymd' — read from the locale, so 08.10.2026, 10/8/2026 and 2026/10/08 each come out right. */
function order(): string {
  if (dateOrder && dateOrderLang === language()) return dateOrder;
  const parts = new Intl.DateTimeFormat(language(), { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(2026, 9, 8));
  dateOrder = parts.filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year').map((p) => p.type[0]).join('');
  dateOrderLang = language();
  return dateOrder;
}

export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Intl.DateTimeFormat(language(), { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function formatDateTime(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return formatDate(iso);
  return `${formatDate(iso)} ${m[4]}:${m[5]}`;
}

/**
 * The field with the precision its record gives it (`scaleFrom`): an amount
 * in a currency with its own number of decimals. The field itself otherwise.
 */
export function scaled<F extends Pick<FieldDef, 'scale' | 'scaleFrom'>>(f: F, row: Record<string, unknown> | null | undefined): F {
  if (!f.scaleFrom || !row) return f;
  const n = row[f.scaleFrom];
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 12 ? { ...f, scale: n } : f;
}

export function formatValue(f: Pick<FieldDef, 'type' | 'scale' | 'money'> | undefined, value: unknown, enumValues?: EnumValue[]): string {
  if (value === null || value === undefined || value === '') return '';
  if (!f) return typeof value === 'number' ? formatNumber(value) : String(value);
  switch (f.type) {
    case 'integer':
      return typeof value === 'number' ? formatNumber(value, 0) : String(value);
    case 'decimal':
      return typeof value === 'number' ? formatNumber(value, f.scale ?? 2, f.money === true || (f.scale ?? 2) === 2) : String(value);
    case 'date':
      return formatDate(String(value));
    case 'datetime':
      return formatDateTime(String(value));
    case 'boolean':
      return value ? '✓' : '';
    case 'enum':
      return enumValues?.find((e) => e.value === value)?.title ?? String(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'schedule':
      return scheduleText(value);
    default:
      return String(value);
  }
}

/** A value shown as a kind says (a dashboard's): money, a number, a share, a date; a dash for nothing. */
export function formatAs(value: unknown, kind: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') {
    if (kind === 'money') return formatNumber(value, 2, true);
    if (kind === 'integer') return formatNumber(value, 0);
    if (kind === 'percent') return `${formatNumber(value, 1)}%`;
    return formatNumber(value, 2);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return kind === 'datetime' || (!kind && value.length > 10) ? formatDateTime(value) : formatDate(value);
  if (typeof value === 'boolean') return value ? '✓' : '—';
  return String(value);
}

/** The name of a weekday (1 = Monday) or of a month (1 = January) in the interface's language. */
export function weekdayName(n: number): string {
  // 5 January 2026 is a Monday.
  return new Intl.DateTimeFormat(language(), { weekday: 'long' }).format(new Date(2026, 0, 4 + n));
}
export function monthDay(month: number, day: number): string {
  return new Intl.DateTimeFormat(language(), { month: 'long', day: 'numeric' }).format(new Date(2026, month - 1, day));
}

/** A schedule in words: “every month on the 15th at 09:00”. */
export function scheduleText(value: unknown): string {
  const s = readSchedule(value);
  if (!s) return '';
  const time = s.time && s.time !== '00:00' ? ` ${t('schedule', 'at {time}', { time: s.time })}` : '';
  let text: string;
  switch (s.every) {
    case 'day':
      text = t('schedule', 'Every day');
      break;
    case 'week':
      text = t('schedule', 'Every week on {weekday}', { weekday: weekdayName(s.weekday ?? 1) });
      break;
    case 'month':
      text = s.day === 'last' ? t('schedule', 'Every month on the last day') : t('schedule', 'Every month on day {day}', { day: s.day ?? 1 });
      break;
    case 'year':
      text = s.day === 'last' ? t('schedule', 'Every year on the last day of {month}', { month: new Intl.DateTimeFormat(language(), { month: 'long' }).format(new Date(2026, (s.month ?? 1) - 1, 1)) }) : t('schedule', 'Every year on {date}', { date: monthDay(s.month ?? 1, typeof s.day === 'number' ? s.day : 1) });
      break;
  }
  const bounds = s.from && s.until ? t('schedule', ', from {from} to {until}', { from: formatDate(s.from), until: formatDate(s.until) }) : s.from ? t('schedule', ', from {from}', { from: formatDate(s.from) }) : s.until ? t('schedule', ', until {until}', { until: formatDate(s.until) }) : '';
  return `${text}${time}${bounds}`;
}

/** A number as typed: spaces and the locale's grouping ignored, a comma or a point for the decimals. */
export function parseNumber(text: string): number | null {
  const s = text.replace(/[\s  ']/g, '').replace(/,(?=\d*$)/, '.').replace(/,/g, '');
  if (!s) return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

/**
 * A sum typed into a number field — `1200+350-50*2`, `(12,5 + 7,5) / 2` —
 * worked out: each number as parseNumber reads it, then + − × ÷ and
 * brackets by the usual rules. Null when the text is not such a sum (a plain
 * number included: parseNumber reads those) or cannot be worked out.
 */
export function evalArithmetic(text: string): number | null {
  const tokens = text.match(/[0-9][0-9\s\u00a0\u202f'.,]*|[-+*/×÷()]|\S/g);
  if (!tokens || !tokens.some((x, i) => /^[*/×÷()]$/.test(x) || (/^[-+]$/.test(x) && i > 0))) return null;
  let i = 0;
  const peek = () => tokens[i];
  const fail = (): never => {
    throw new Error('arithmetic');
  };
  const atom = (): number => {
    const tk = tokens[i++];
    if (tk === undefined) return fail();
    if (tk === '(') {
      const v = sum();
      if (tokens[i++] !== ')') fail();
      return v;
    }
    if (tk === '-') return -atom();
    if (tk === '+') return atom();
    const n = parseNumber(tk);
    return n === null || Number.isNaN(n) ? fail() : n;
  };
  const product = (): number => {
    let v = atom();
    while (peek() === '*' || peek() === '/' || peek() === '×' || peek() === '÷') {
      const op = tokens[i++];
      const w = atom();
      if ((op === '/' || op === '÷') && w === 0) fail();
      v = op === '*' || op === '×' ? v * w : v / w;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === '+' || peek() === '-') v = tokens[i++] === '+' ? v + product() : v - product();
    return v;
  };
  try {
    const v = sum();
    if (i !== tokens.length || !Number.isFinite(v)) return null;
    return Number(v.toPrecision(15));
  } catch {
    return null;
  }
}

/** A date as typed, in the locale's order or ISO; two-digit years are 20xx. Returns ISO or null. */
export function parseDate(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y: number;
  let m: number;
  let d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else {
    const parts = s.split(/[./\-\s]+/).map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return null;
    const o = order();
    const at = (c: string) => parts[o.indexOf(c)]!;
    [y, m, d] = [at('y'), at('m'), at('d')];
    if (y < 100) y += 2000;
  }
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Sum in words for invoices: Russian, Ukrainian and English (Task.md 11.4). */
export function amountInWords(amount: number, lang = language(), currency = 'UAH'): string {
  const whole = Math.floor(Math.abs(amount));
  const cents = Math.round((Math.abs(amount) - whole) * 100);
  if (lang === 'ru' || lang === 'uk') return `${slavic(whole, lang, currency)} ${String(cents).padStart(2, '0')} ${lang === 'ru' ? 'коп.' : 'коп.'}`;
  return `${englishWords(whole)} ${currency} ${String(cents).padStart(2, '0')}/100`;
}

function englishWords(n: number): string {
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const under1000 = (x: number): string => {
    const parts: string[] = [];
    if (x >= 100) {
      parts.push(`${ones[Math.floor(x / 100)]} hundred`);
      x %= 100;
    }
    if (x >= 20) parts.push(tens[Math.floor(x / 10)]! + (x % 10 ? `-${ones[x % 10]}` : ''));
    else if (x > 0 || !parts.length) parts.push(ones[x]!);
    return parts.join(' ');
  };
  if (n === 0) return 'zero';
  const scales = ['', ' thousand', ' million', ' billion'];
  const out: string[] = [];
  let i = 0;
  while (n > 0) {
    const chunk = n % 1000;
    if (chunk) out.unshift(under1000(chunk) + scales[i]);
    n = Math.floor(n / 1000);
    i++;
  }
  const text = out.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function slavic(n: number, lang: 'ru' | 'uk', currency: string): string {
  const ru = lang === 'ru';
  const onesM = ru ? ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'] : ['', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
  const onesF = ru ? ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'] : ['', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
  const teens = ru
    ? ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
    : ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
  const tens = ru ? ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'] : ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"];
  const hundreds = ru ? ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'] : ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"];
  const form = (x: number, forms: [string, string, string]) => {
    const a = x % 100;
    const b = x % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b === 1) return forms[0];
    if (b >= 2 && b <= 4) return forms[1];
    return forms[2];
  };
  const triple = (x: number, female: boolean) => {
    const out: string[] = [];
    if (x >= 100) out.push(hundreds[Math.floor(x / 100)]!);
    const r = x % 100;
    if (r >= 10 && r < 20) out.push(teens[r - 10]!);
    else {
      if (r >= 20) out.push(tens[Math.floor(r / 10)]!);
      if (r % 10) out.push((female ? onesF : onesM)[r % 10]!);
    }
    return out.join(' ');
  };
  const money: Record<string, { f: boolean; forms: [string, string, string] }> = ru
    ? { UAH: { f: true, forms: ['гривна', 'гривны', 'гривен'] }, RUB: { f: false, forms: ['рубль', 'рубля', 'рублей'] }, USD: { f: false, forms: ['доллар', 'доллара', 'долларов'] }, EUR: { f: false, forms: ['евро', 'евро', 'евро'] } }
    : { UAH: { f: true, forms: ['гривня', 'гривні', 'гривень'] }, USD: { f: false, forms: ['долар', 'долари', 'доларів'] }, EUR: { f: false, forms: ['євро', 'євро', 'євро'] } };
  const unit = money[currency] ?? money.UAH!;
  const scales: { f: boolean; forms: [string, string, string] }[] = [
    { f: true, forms: ru ? ['тысяча', 'тысячи', 'тысяч'] : ['тисяча', 'тисячі', 'тисяч'] },
    { f: false, forms: ru ? ['миллион', 'миллиона', 'миллионов'] : ['мільйон', 'мільйони', 'мільйонів'] },
    { f: false, forms: ru ? ['миллиард', 'миллиарда', 'миллиардов'] : ['мільярд', 'мільярди', 'мільярдів'] },
  ];
  if (n === 0) return `${ru ? 'ноль' : 'нуль'} ${unit.forms[2]}`;
  const parts: string[] = [];
  const low = n % 1000;
  let rest = Math.floor(n / 1000);
  let i = 0;
  while (rest > 0 && i < scales.length) {
    const chunk = rest % 1000;
    if (chunk) parts.unshift(`${triple(chunk, scales[i]!.f)} ${form(chunk, scales[i]!.forms)}`);
    rest = Math.floor(rest / 1000);
    i++;
  }
  if (low) parts.push(triple(low, unit.f));
  const text = `${parts.join(' ')} ${form(n, unit.forms)}`.replace(/\s+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
