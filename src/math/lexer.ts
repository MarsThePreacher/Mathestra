// Tokenizer for Mathestra's Desmos-flavoured math syntax.

export type TokenType = 'num' | 'word' | 'op' | 'end';

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export class MathSyntaxError extends Error {}

const UNICODE: Record<string, string> = {
  'π': 'pi',
  'τ': 'tau',
  '·': '*',
  '×': '*',
  '⋅': '*',
  '÷': '/',
  '−': '-',
  '≤': '<=',
  '≥': '>=',
  '√': 'sqrt',
  '∛': 'cbrt',
  '²': '^2',
  '³': '^3',
};

/** Replace friendly unicode symbols with their ASCII spellings. */
export function normalize(src: string): string {
  let out = '';
  for (const ch of src) {
    // "πx" becomes "pix", which splitWords later separates into pi·x.
    out += UNICODE[ch] ?? ch;
  }
  return out;
}

const OPS2 = ['<=', '>='];
const OPS1 = '+-*/^()[]{},:<>=';

// Sticky patterns match at an exact position without copying the rest of the line,
// so lexing stays linear even for lines holding hundreds of thousands of numbers.
const NUMBER = /\d+\.?\d*|\.\d+/y;
const WORD = /[A-Za-z]+(?:_[A-Za-z0-9]+)?/y;

/** Lexes raw words. Splitting "pix" into "pi x" happens later, in splitWords. */
export function lex(src: string): Token[] {
  const s = normalize(src);
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      // No scientific notation: like Desmos, "2e3" means 2·e·3.
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(s);
      if (!m) throw new MathSyntaxError(`Unexpected '${ch}'`);
      const text = m[0];
      tokens.push({ type: 'num', value: text, pos: i });
      i += text.length;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      WORD.lastIndex = i;
      const m = WORD.exec(s)!;
      tokens.push({ type: 'word', value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (OPS2.includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if (OPS1.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }
    throw new MathSyntaxError(`Unexpected character '${ch}'`);
  }
  tokens.push({ type: 'end', value: '', pos: s.length });
  return tokens;
}

/**
 * Desmos-style implicit multiplication of letters: "pix" → pi·x, "sinx" → sin x,
 * "ab" → a·b. Words that are known names as a whole are kept intact.
 */
export function splitWords(tokens: Token[], isKnown: (name: string) => boolean): Token[] {
  const out: Token[] = [];
  for (const tok of tokens) {
    if (tok.type !== 'word' || tok.value.includes('_') || isKnown(tok.value)) {
      out.push(tok);
      continue;
    }
    const w = tok.value;
    let i = 0;
    while (i < w.length) {
      let len = 1;
      for (let j = w.length; j > i + 1; j--) {
        if (isKnown(w.slice(i, j))) {
          len = j - i;
          break;
        }
      }
      out.push({ type: 'word', value: w.slice(i, i + len), pos: tok.pos + i });
      i += len;
    }
  }
  return out;
}
