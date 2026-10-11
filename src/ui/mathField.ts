// A typeset equation editor, styled like Desmos (MathQuill): italic serif
// variables, upright numbers and function names, spaced operators, raised
// exponents. The text itself is never rewritten, only wrapped in styled spans,
// so the caret, selection and copy/paste work on exactly what you typed.

import { BUILTIN_FUNCS } from '../math/builtins';

const FUNCS = new Set(Object.keys(BUILTIN_FUNCS));
const CONSTS = new Set(['pi', 'tau']);
const SPACED = new Set(['+', '=', '<', '>', '≤', '≥', ':', '-', '−']);

// ---------- typesetting ----------

function span(cls: string, text: string | Node[]): HTMLElement {
  const s = document.createElement('span');
  s.className = cls;
  if (typeof text === 'string') s.textContent = text;
  else s.append(...text);
  return s;
}

/** Index just past the bracket that closes the one at `open`. */
function matchClose(s: string, open: number, end: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const want = pairs[s[open]];
  let depth = 0;
  for (let i = open; i < end; i++) {
    if (s[i] === s[open]) depth++;
    else if (s[i] === want && --depth === 0) return i + 1;
  }
  return end;
}

/**
 * How far an italic letter's top leans past its box, for italic correction:
 * tall letters with a right-leaning stem need more room before an upright neighbour.
 */
function leanClass(letter: string): string {
  if (letter === 'f') return ' m-lean-f';
  return /[bdhkltA-Z]/.test(letter) ? ' m-lean' : '';
}

/** Split a run of letters the way the parser does: "sinx" is sin·x, "pix" is π·x. */
function splitLetters(run: string): { text: string; cls: string }[] {
  if (FUNCS.has(run)) return [{ text: run, cls: 'm-fn' }];
  const out: { text: string; cls: string }[] = [];
  let i = 0;
  while (i < run.length) {
    let len = 0;
    for (let j = run.length; j > i + 1; j--) {
      const w = run.slice(i, j);
      if (FUNCS.has(w) || CONSTS.has(w)) {
        len = j - i;
        break;
      }
    }
    if (len) {
      const w = run.slice(i, i + len);
      out.push({ text: w, cls: FUNCS.has(w) ? 'm-fn' : 'm-const' });
      i += len;
    } else {
      out.push({ text: run[i], cls: `m-var${leanClass(run[i])}` });
      i++;
    }
  }
  return out;
}

function typeset(s: string, start: number, end: number): Node[] {
  const out: Node[] = [];
  let operand = false; // was the previous token a value? (decides binary vs unary minus)
  let i = start;
  while (i < end) {
    const c = s[i];
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]*/.exec(s.slice(i, end))![0];
      out.push(span('m-num', m));
      i += m.length;
      operand = true;
    } else if (/[A-Za-z]/.test(c)) {
      const run = /^[A-Za-z]+/.exec(s.slice(i, end))![0];
      const sub = /^_[A-Za-z0-9]+/.exec(s.slice(i + run.length, end));
      if (sub) {
        // a_1: the whole name is one variable, with a lowered subscript.
        out.push(span(`m-var${leanClass(run[run.length - 1])}`, run), span('m-subscript', [span('m-hat', '_'), document.createTextNode(sub[0].slice(1))]));
        i += run.length + sub[0].length;
      } else {
        for (const piece of splitLetters(run)) out.push(span(piece.cls, piece.text));
        i += run.length;
      }
      operand = true;
    } else if (c === '^') {
      // The exponent is raised; the ^ itself stays (faintly) so editing is unchanged.
      out.push(span('m-hat', '^'));
      i++;
      let j = i;
      if (s[j] === '{') {
        // LaTeX-style grouping braces are syntax, not maths: they fade out like Desmos hides them.
        const close = matchClose(s, j, end);
        const closed = s[close - 1] === '}';
        const inner = typeset(s, j + 1, closed ? close - 1 : close);
        out.push(span('m-sup', [span('m-brace', '{'), ...inner, ...(closed ? [span('m-brace', '}')] : [])]));
        i = close;
        operand = true;
        continue;
      }
      if (j < end && '(['.includes(s[j])) j = matchClose(s, j, end);
      else {
        if (s[j] === '-' || s[j] === '−') j++;
        const m = /^([0-9]*\.?[0-9]+|[A-Za-zπτ])/.exec(s.slice(j, end));
        j += m ? m[0].length : 0;
      }
      if (j > i) out.push(span('m-sup', typeset(s, i, j)));
      i = j;
      operand = true;
    } else if (c === 'π' || c === 'τ') {
      out.push(span('m-const', c));
      i++;
      operand = true;
    } else if (SPACED.has(c) && (operand || !(c === '-' || c === '−'))) {
      out.push(span(c === '-' ? 'm-op m-minus' : 'm-op', c));
      i++;
      operand = false;
    } else if ('([{'.includes(c)) {
      out.push(span('m-paren', c));
      i++;
      operand = false;
    } else if (')]}'.includes(c)) {
      out.push(span('m-paren', c));
      i++;
      operand = true;
    } else if (c === ',') {
      out.push(span('m-comma', c));
      i++;
      operand = false;
    } else if (c === '-') {
      out.push(span('m-minus', c)); // unary minus: no spacing
      i++;
      operand = false;
    } else if (c === '*' || c === '·' || c === '/') {
      out.push(span(c === '*' ? 'm-mul m-star' : 'm-mul', c));
      i++;
      operand = false;
    } else {
      // Everything else (spaces, unary minus, stray symbols) is plain text.
      const last = out[out.length - 1];
      if (last instanceof Text) last.data += c;
      else out.push(document.createTextNode(c));
      i++;
      if (c !== ' ') operand = false;
    }
  }
  return out;
}

/** Beyond this length (data lists), lines are shown as plain text rather than typeset. */
export const LONG_LINE = 4000;

export function typesetLine(text: string): Node[] {
  if (/^\s*(\/\/|")/.test(text)) return [span('m-note', text)];
  if (text.length > LONG_LINE) return [document.createTextNode(text)];
  return typeset(text, 0, text.length);
}

// ---------- caret <-> character offset ----------

function offsetOf(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, offset);
  return r.toString().length;
}

function pointAt(root: Node, target: number): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (seen + n.data.length >= target) return [n, target - seen];
    seen += n.data.length;
    last = n;
  }
  return last ? [last, last.data.length] : [root, 0];
}

// ---------- the field ----------

interface Snapshot {
  value: string;
  caret: number;
}

export class MathField {
  readonly el: HTMLDivElement;
  onChange: (value: string) => void = () => {};
  private composing = false;
  /** Edit history: states after each edit, with `at` pointing at the current one. */
  private past: Snapshot[] = [{ value: '', caret: 0 }];
  private at = 0;
  private lastEdit = 0;
  private lastKind: 'insert' | 'delete' | null = null;

  constructor(placeholder: string) {
    const el = document.createElement('div');
    el.className = 'expr';
    // plaintext-only keeps pasted formatting out; older browsers fall back to true (paste is handled below).
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.spellcheck = false;
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-label', 'Expression');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
    el.dataset.placeholder = placeholder;
    this.el = el;

    el.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') e.preventDefault();
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        this.history(e.inputType === 'historyUndo');
      }
    });
    el.addEventListener('compositionstart', () => (this.composing = true));
    el.addEventListener('compositionend', () => {
      this.composing = false;
      this.afterNativeEdit();
    });
    el.addEventListener('input', () => {
      if (!this.composing) this.afterNativeEdit();
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\s*\n\s*/g, ' ');
      this.setRangeText(text, this.selectionStart, this.selectionEnd);
      this.commit();
    });
    el.addEventListener('drop', (e) => e.preventDefault());
    el.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.history(!e.shiftKey);
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.history(false);
      }
    });
  }

  get value(): string {
    return this.el.textContent ?? '';
  }

  /** Read-only fields can still be selected and copied, just not changed. */
  setEditable(on: boolean): void {
    if (!on) {
      this.el.contentEditable = 'false';
    } else {
      this.el.contentEditable = 'plaintext-only';
      if (this.el.contentEditable !== 'plaintext-only') this.el.contentEditable = 'true';
    }
    this.el.setAttribute('aria-readonly', String(!on));
  }

  /** Replace the whole text (from outside, e.g. a slider). Keeps the caret if focused. */
  set value(v: string) {
    if (v === this.value) return;
    const caret = this.focused ? Math.min(this.selectionEnd, v.length) : null;
    this.render(v, caret === null ? null : [caret, caret]);
    if (this.past.length === 1 && this.past[0].value === '') {
      // First load: this is where history starts, not an undoable step.
      this.past = [{ value: v, caret: v.length }];
      this.at = 0;
    } else {
      this.record(true);
    }
  }

  get focused(): boolean {
    return document.activeElement === this.el;
  }

  get selectionStart(): number {
    return this.selection()[0];
  }

  get selectionEnd(): number {
    return this.selection()[1];
  }

  set inputMode(mode: string) {
    this.el.inputMode = mode;
  }

  focus(options?: FocusOptions): void {
    this.el.focus(options);
  }

  setSelectionRange(start: number, end: number): void {
    const sel = getSelection();
    if (!sel) return;
    const [a, ao] = pointAt(this.el, start);
    const [b, bo] = pointAt(this.el, end);
    const r = document.createRange();
    r.setStart(a, ao);
    r.setEnd(b, bo);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** Replace characters [start, end) and put the caret after the new text. Call commit() after. */
  setRangeText(text: string, start: number, end: number): void {
    const v = this.value;
    const next = v.slice(0, start) + text + v.slice(end);
    const caret = start + text.length;
    this.render(next, [caret, caret]);
    this.record(false);
  }

  commit(): void {
    this.onChange(this.value);
  }

  private selection(): [number, number] {
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return [this.value.length, this.value.length];
    const r = sel.getRangeAt(0);
    if (!this.el.contains(r.startContainer)) return [this.value.length, this.value.length];
    return [offsetOf(this.el, r.startContainer, r.startOffset), offsetOf(this.el, r.endContainer, r.endOffset)];
  }

  private render(text: string, caret: [number, number] | null): void {
    this.el.replaceChildren(...typesetLine(text));
    this.el.classList.toggle('empty', text === '');
    this.el.classList.toggle('long', text.length > LONG_LINE);
    if (text.length > LONG_LINE) this.el.dataset.count = `${(text.match(/,/g)?.length ?? 0) + 1}`;
    if (caret) this.setSelectionRange(caret[0], caret[1]);
  }

  /** The browser just edited the DOM; re-typeset around the caret and report. */
  private afterNativeEdit(): void {
    let v = this.value;
    const [s, e] = this.selection();
    if (v.includes('\n')) v = v.replace(/\s*\n\s*/g, ' ');
    this.render(v, [Math.min(s, v.length), Math.min(e, v.length)]);
    this.record(true);
    this.commit();
  }

  /**
   * Record the state after an edit. Quick consecutive typing (or slider drags)
   * merges into one undo step; keypad presses and pastes are always their own.
   */
  private record(mergeable: boolean): void {
    const snap = { value: this.value, caret: this.selectionEnd };
    if (snap.value === this.past[this.at].value) return;
    const now = performance.now();
    const prev = this.past[this.at];
    const kind = snap.value.length >= prev.value.length ? 'insert' : 'delete';
    // Merge only a continuous run: same kind of edit, at the spot the last one left off.
    const continuous = kind === this.lastKind && Math.abs(snap.caret - prev.caret) <= 1;
    this.past.length = this.at + 1; // a new edit discards the redo branch
    this.lastKind = mergeable ? kind : null;
    if (mergeable && continuous && this.at > 0 && now - this.lastEdit < 1000) {
      this.past[this.at] = snap;
    } else {
      this.past.push(snap);
      if (this.past.length > 200) this.past.shift();
      this.at = this.past.length - 1;
    }
    this.lastEdit = mergeable ? now : 0;
  }

  private history(undo: boolean): void {
    const next = this.at + (undo ? -1 : 1);
    if (next < 0 || next >= this.past.length) return;
    this.at = next;
    const snap = this.past[next];
    this.render(snap.value, [snap.caret, snap.caret]);
    this.lastEdit = 0;
    this.lastKind = null;
    this.commit();
  }
}
