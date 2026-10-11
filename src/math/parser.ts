import { MathSyntaxError, type Token } from './lexer';

export type Node =
  | { type: 'num'; value: number }
  | { type: 'var'; name: string }
  | { type: 'neg'; arg: Node }
  | { type: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { type: 'call'; name: string; args: Node[] }
  | { type: 'list'; items: Node[] }
  | { type: 'index'; target: Node; index: Node }
  | { type: 'piecewise'; branches: Branch[]; otherwise: Node | null };

export interface Branch {
  cond: Cond;
  /** null means "{cond}" with no value, which is 1 where cond holds. */
  value: Node | null;
}

export interface Cond {
  ops: string[];
  operands: Node[];
}

const CMP = ['<', '>', '<=', '>=', '='];

/**
 * Recursive-descent parser. `isFunction` says which words are callable, which
 * matters for implicit multiplication: "f(x)" is a call, "a(x)" is a·x.
 */
export class Parser {
  private i = 0;

  constructor(
    private tokens: Token[],
    private isFunction: (name: string) => boolean,
  ) {}

  static parse(tokens: Token[], isFunction: (name: string) => boolean): Node {
    const p = new Parser(tokens, isFunction);
    const node = p.expr();
    if (p.peek().type !== 'end') p.fail(`Unexpected '${p.peek().value}'`);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.i];
  }

  private next(): Token {
    return this.tokens[this.i++];
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t.type === 'op' && t.value === value;
  }

  private expect(value: string): void {
    if (!this.isOp(value)) {
      const t = this.peek();
      this.fail(t.type === 'end' ? `Missing '${value}'` : `Expected '${value}' but found '${t.value}'`);
    }
    this.i++;
  }

  private fail(msg: string): never {
    throw new MathSyntaxError(msg);
  }

  expr(): Node {
    let left = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value as '+' | '-';
      left = { type: 'bin', op, left, right: this.term() };
    }
    return left;
  }

  /** Can the next token start an implicitly multiplied factor? */
  private startsFactor(): boolean {
    const t = this.peek();
    if (t.type === 'num' || t.type === 'word') return true;
    return t.type === 'op' && (t.value === '(' || t.value === '[' || t.value === '{');
  }

  private term(): Node {
    let left = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = this.next().value as '*' | '/';
        left = { type: 'bin', op, left, right: this.unary() };
      } else if (this.startsFactor()) {
        left = { type: 'bin', op: '*', left, right: this.power() };
      } else {
        return left;
      }
    }
  }

  private unary(): Node {
    if (this.isOp('-')) {
      this.i++;
      return { type: 'neg', arg: this.unary() };
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): Node {
    const base = this.postfix();
    if (this.isOp('^')) {
      this.i++;
      return { type: 'bin', op: '^', left: base, right: this.exponent() };
    }
    return base;
  }

  private exponent(): Node {
    if (this.isOp('-')) {
      this.i++;
      return { type: 'neg', arg: this.exponent() };
    }
    if (this.isOp('{')) {
      // LaTeX-style grouping: e^{-3x}
      this.i++;
      const inner = this.expr();
      this.expect('}');
      return inner;
    }
    return this.power();
  }

  private postfix(): Node {
    let node = this.primary();
    while (this.isOp('[')) {
      this.i++;
      const index = this.expr();
      this.expect(']');
      node = { type: 'index', target: node, index };
    }
    return node;
  }

  private primary(): Node {
    const t = this.next();
    if (t.type === 'num') return { type: 'num', value: parseFloat(t.value) };
    if (t.type === 'word') {
      if (this.isFunction(t.value)) return this.call(t.value);
      return { type: 'var', name: t.value };
    }
    if (t.type === 'op') {
      if (t.value === '(') {
        const inner = this.expr();
        this.expect(')');
        return inner;
      }
      if (t.value === '[') return this.list();
      if (t.value === '{') return this.piecewise();
    }
    if (t.type === 'end') this.fail('Expression is incomplete');
    this.fail(`Unexpected '${t.value}'`);
  }

  private call(name: string): Node {
    if (this.isOp('(')) {
      this.i++;
      const args: Node[] = [];
      if (!this.isOp(')')) {
        args.push(this.expr());
        while (this.isOp(',')) {
          this.i++;
          args.push(this.expr());
        }
      }
      this.expect(')');
      return { type: 'call', name, args };
    }
    // "sin 2πx" → sin(2πx): the argument runs until an operator or another function.
    if (!this.startsFactor()) this.fail(`${name} needs an argument, like ${name}(x)`);
    let arg = this.power();
    while (this.startsFactor() && !(this.peek().type === 'word' && this.isFunction(this.peek().value))) {
      arg = { type: 'bin', op: '*', left: arg, right: this.power() };
    }
    return { type: 'call', name, args: [arg] };
  }

  private list(): Node {
    const items: Node[] = [];
    if (!this.isOp(']')) {
      items.push(this.expr());
      while (this.isOp(',')) {
        this.i++;
        items.push(this.expr());
      }
    }
    this.expect(']');
    return { type: 'list', items };
  }

  /** Desmos piecewise: {x<1: a, x<2: b, c} or {x>0} */
  private piecewise(): Node {
    const branches: Branch[] = [];
    let otherwise: Node | null = null;
    for (;;) {
      const first = this.expr();
      const t = this.peek();
      if (t.type === 'op' && CMP.includes(t.value)) {
        const cond: Cond = { ops: [], operands: [first] };
        while (this.peek().type === 'op' && CMP.includes(this.peek().value)) {
          cond.ops.push(this.next().value);
          cond.operands.push(this.expr());
        }
        let value: Node | null = null;
        if (this.isOp(':')) {
          this.i++;
          value = this.expr();
        }
        branches.push({ cond, value });
        if (this.isOp(',')) {
          this.i++;
          continue;
        }
        this.expect('}');
        break;
      }
      if (branches.length === 0) this.fail('A piecewise {…} needs a condition, like {x<1: a, b}');
      otherwise = first;
      this.expect('}');
      break;
    }
    return { type: 'piecewise', branches, otherwise };
  }
}
