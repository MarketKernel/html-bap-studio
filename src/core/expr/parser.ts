/**
 * Turns tokens into an AST of plain JSON objects — they can be cached, sent to
 * a worker or stored as they are. `pos`/`end` are source offsets (end exclusive).
 *
 * Precedence, low to high: or; and; not; comparison (= <> < <= > >=, in,
 * between); &; + -; * / %; unary -; .member and calls; literals and brackets.
 */
import { t } from '../i18n';
import { ExprError, tokenize, type Token } from './lexer';

interface Span {
  pos: number;
  end: number;
}

export type BinaryOp = 'or' | 'and' | '=' | '<>' | '<' | '<=' | '>' | '>=' | '&' | '+' | '-' | '*' | '/' | '%';

export type Expr =
  | (Span & { type: 'literal'; value: string | number | boolean | null })
  | (Span & { type: 'path'; path: string[] })
  | (Span & { type: 'member'; object: Expr; name: string })
  | (Span & { type: 'call'; name: string; args: Expr[] })
  | (Span & { type: 'unary'; op: '-' | 'not'; arg: Expr })
  | (Span & { type: 'binary'; op: BinaryOp; left: Expr; right: Expr })
  | (Span & { type: 'in'; arg: Expr; list: Expr[]; negated: boolean })
  | (Span & { type: 'between'; arg: Expr; low: Expr; high: Expr; negated: boolean });

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'between', 'true', 'false', 'null']);
const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);

export function parseExpr(source: string): Expr {
  return new Parser(tokenize(source)).parse();
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const tok = this.peek();
    if (tok.type === 'eof') throw new ExprError(t('expr', 'The expression is empty'), 0, 0);
    const expr = this.or();
    const rest = this.peek();
    if (rest.type !== 'eof') throw this.unexpected(rest);
    return expr;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)] as Token;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.type !== 'eof') this.i += 1;
    return tok;
  }

  private isOp(op: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.type === 'op' && tok.value === op;
  }

  private isKeyword(word: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.type === 'name' && String(tok.value).toLowerCase() === word;
  }

  private expectOp(op: string): Token {
    const tok = this.peek();
    if (tok.type === 'op' && tok.value === op) return this.next();
    if (tok.type === 'eof') throw new ExprError(t('expr', '“{token}” is expected at the end', { token: op }), tok.pos, tok.end);
    throw new ExprError(t('expr', '“{token}” is expected instead of “{found}”', { token: op, found: String(tok.value) }), tok.pos, tok.end);
  }

  private unexpected(tok: Token): ExprError {
    if (tok.type === 'eof') return new ExprError(t('expr', 'The expression ends unexpectedly'), tok.pos, tok.end);
    const text = tok.type === 'string' ? `'${tok.value}'` : String(tok.value);
    return new ExprError(t('expr', 'Unexpected “{token}”', { token: text }), tok.pos, tok.end);
  }

  private or(): Expr {
    let left = this.and();
    while (this.isKeyword('or')) {
      this.next();
      const right = this.and();
      left = { type: 'binary', op: 'or', left, right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.isKeyword('and')) {
      this.next();
      const right = this.not();
      left = { type: 'binary', op: 'and', left, right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private not(): Expr {
    if (this.isKeyword('not')) {
      const tok = this.next();
      const arg = this.not();
      return { type: 'unary', op: 'not', arg, pos: tok.pos, end: arg.end };
    }
    return this.comparison();
  }

  private comparison(): Expr {
    let left = this.concat();
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'op' && COMPARISONS.has(tok.value as string)) {
        this.next();
        const right = this.concat();
        left = { type: 'binary', op: tok.value as BinaryOp, left, right, pos: left.pos, end: right.end };
        continue;
      }
      const negated = this.isKeyword('not') && (this.isKeyword('in', 1) || this.isKeyword('between', 1));
      if (negated) this.next();
      if (this.isKeyword('in')) {
        this.next();
        this.expectOp('(');
        const list: Expr[] = [];
        if (!this.isOp(')')) {
          do list.push(this.or());
          while (this.isOp(',') && this.next());
        }
        const close = this.expectOp(')');
        left = { type: 'in', arg: left, list, negated, pos: left.pos, end: close.end };
        continue;
      }
      if (this.isKeyword('between')) {
        this.next();
        // The bounds sit above `and` in precedence, so the `and` between them is not taken as logic.
        const low = this.concat();
        if (!this.isKeyword('and')) throw new ExprError(t('expr', '“and” is expected after the lower bound of “between”'), this.peek().pos, this.peek().end);
        this.next();
        const high = this.concat();
        left = { type: 'between', arg: left, low, high, negated, pos: left.pos, end: high.end };
        continue;
      }
      return left;
    }
  }

  private concat(): Expr {
    let left = this.additive();
    while (this.isOp('&')) {
      this.next();
      const right = this.additive();
      left = { type: 'binary', op: '&', left, right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value as BinaryOp;
      const right = this.multiplicative();
      left = { type: 'binary', op, left, right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value as BinaryOp;
      const right = this.unary();
      left = { type: 'binary', op, left, right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private unary(): Expr {
    if (this.isOp('-')) {
      const tok = this.next();
      const arg = this.unary();
      // A negative number literal stays a literal, which keeps ASTs and previews simple.
      if (arg.type === 'literal' && typeof arg.value === 'number' && arg.pos === tok.end) {
        return { type: 'literal', value: arg.value === 0 ? 0 : -arg.value, pos: tok.pos, end: arg.end };
      }
      return { type: 'unary', op: '-', arg, pos: tok.pos, end: arg.end };
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let expr = this.primary();
    while (this.isOp('.')) {
      this.next();
      const tok = this.peek();
      // Any word may follow a dot, keywords included: `doc.in` is a field named "in".
      if (tok.type !== 'name') throw new ExprError(t('expr', 'A field name is expected after “.”'), tok.pos, tok.end);
      this.next();
      const name = tok.value as string;
      expr = expr.type === 'path'
        ? { type: 'path', path: [...expr.path, name], pos: expr.pos, end: tok.end }
        : { type: 'member', object: expr, name, pos: expr.pos, end: tok.end };
    }
    return expr;
  }

  private primary(): Expr {
    const tok = this.peek();
    switch (tok.type) {
      case 'number':
        this.next();
        return { type: 'literal', value: tok.value as number, pos: tok.pos, end: tok.end };
      case 'string':
      case 'date':
        this.next();
        return { type: 'literal', value: tok.value as string, pos: tok.pos, end: tok.end };
      case 'name': {
        const word = (tok.value as string).toLowerCase();
        if (word === 'true' || word === 'false' || word === 'null') {
          this.next();
          return { type: 'literal', value: word === 'null' ? null : word === 'true', pos: tok.pos, end: tok.end };
        }
        if (KEYWORDS.has(word)) throw this.unexpected(tok);
        this.next();
        if (this.isOp('(')) {
          this.next();
          const args: Expr[] = [];
          if (!this.isOp(')')) {
            do args.push(this.or());
            while (this.isOp(',') && this.next());
          }
          const close = this.expectOp(')');
          return { type: 'call', name: tok.value as string, args, pos: tok.pos, end: close.end };
        }
        return { type: 'path', path: [tok.value as string], pos: tok.pos, end: tok.end };
      }
      case 'op':
        if (tok.value === '(') {
          this.next();
          // Brackets leave no node behind; the inner span is kept, so a path still starts at its first name.
          const inner = this.or();
          this.expectOp(')');
          return inner;
        }
        throw this.unexpected(tok);
      default:
        throw this.unexpected(tok);
    }
  }
}
