// The on-screen math keypad, laid out like Desmos: a tab of numbers and operators,
// a tab of functions, and a tab of letters, with editing keys always on the right.

import type { Panel } from './panel';

type Action = 'back' | 'left' | 'right' | 'enter' | 'shift';

interface Key {
  /** Static, trusted markup for the key face. */
  face: string;
  /** Text to insert; '|' marks where the caret lands (selection gets wrapped there). */
  insert?: string;
  action?: Action;
  title?: string;
  kind?: 'num' | 'op' | 'fn' | 'action';
  span?: number;
}

const k = (face: string, insert: string, kind: Key['kind'] = 'op', title?: string): Key => ({ face, insert, kind, title });
const n = (d: string): Key => k(d, d, 'num');
const fn = (name: string, title?: string): Key => k(name, `${name}(|)`, 'fn', title ?? name);
const v = (name: string): Key => k(`<i>${name}</i>`, name, 'op');

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7z"/><path d="M12 9.5l5 5M17 9.5l-5 5"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></svg>',
  enter: '<svg viewBox="0 0 24 24"><path d="M19 5v6a3 3 0 0 1-3 3H6"/><path d="M10 9.5L5.5 14l4.5 4.5"/></svg>',
  shift: '<svg viewBox="0 0 24 24"><path d="M12 4.5l7 7.5h-4v7H9v-7H5z"/></svg>',
};

const TABS: { id: string; label: string; cols: number; keys: Key[] }[] = [
  {
    id: 'main',
    label: '123',
    cols: 8,
    keys: [
      v('x'), v('y'), k('<i>a</i><sup>2</sup>', '^2', 'op', 'Squared'), k('<i>a</i><sup><i>b</i></sup>', '^(|)', 'op', 'Power'),
      n('7'), n('8'), n('9'), k('÷', '/'),
      k('(', '('), k(')', ')'), k('&lt;', '<'), k('&gt;', '>'),
      n('4'), n('5'), n('6'), k('×', '·'),
      k('|<i>a</i>|', 'abs(|)', 'op', 'Absolute value'), k(',', ', '), k('≤', '≤'), k('≥', '≥'),
      n('1'), n('2'), n('3'), k('−', '-'),
      k('√', 'sqrt(|)', 'op', 'Square root'), k('π', 'π'), k('<i>e</i><sup><i>x</i></sup>', 'e^(|)', 'op', 'Exponential'), k('{ : }', '{|: }', 'op', 'Piecewise'),
      n('0'), n('.'), k('=', ' = '), k('+', '+'),
    ],
  },
  {
    id: 'func',
    label: 'f(x)',
    cols: 8,
    keys: [
      fn('sin'), fn('cos'), fn('tan'), fn('sec'), fn('csc'), fn('cot'), fn('ln', 'Natural log'), fn('log', 'Log base 10'),
      fn('arcsin'), fn('arccos'), fn('arctan'), fn('sinh'), fn('cosh'), fn('tanh'), fn('exp'), k('∛', 'cbrt(|)', 'fn', 'Cube root'),
      fn('floor'), fn('ceil'), fn('round'), fn('abs'), fn('sign'), k('mod', 'mod(|, )', 'fn', 'mod: remainder'), k('min', 'min(|, )', 'fn', 'min'), k('max', 'max(|, )', 'fn', 'max'),
      k('[ ]', '[|]', 'fn', 'List'), fn('length'), fn('total'), fn('mean'), k('τ', 'τ', 'op', 'Tau = 2π'), k('<i>t</i>', 't', 'op'), k('//', '// ', 'fn', 'Note'), k(':', ': '),
    ],
  },
  {
    id: 'abc',
    label: 'abc',
    cols: 10,
    keys: [
      ...'qwertyuiop'.split('').map(v),
      ...'asdfghjkl'.split('').map(v), k('_', '_', 'op', 'Subscript, as in a_1'),
      { face: ICON.shift, action: 'shift', kind: 'action', title: 'Capital letters' },
      ...'zxcvbnm'.split('').map(v), n('.'), k('·', '·', 'op', 'Multiply'),
      k('(', '('), k(')', ')'), k(',', ', '), { face: 'space', insert: ' ', kind: 'num', span: 4 }, k('=', ' = '), k('[', '['), k(']', ']'),
    ],
  },
];

const SIDE: Key[] = [
  { face: ICON.back, action: 'back', kind: 'action', title: 'Delete', span: 2 },
  { face: ICON.left, action: 'left', kind: 'action', title: 'Move left' },
  { face: ICON.right, action: 'right', kind: 'action', title: 'Move right' },
  { face: ICON.enter, action: 'enter', kind: 'action', title: 'New line', span: 2 },
];

const REPEATS: Action[] = ['back', 'left', 'right'];

export class Keypad {
  private tab = 'main';
  private shift = false;
  private grid: HTMLElement;
  private tabButtons = new Map<string, HTMLButtonElement>();

  constructor(
    root: HTMLElement,
    private panel: Panel,
  ) {
    const bar = el('div', 'kp-tabs');
    bar.setAttribute('role', 'tablist');
    for (const t of TABS) {
      const b = el('button', 'kp-tab') as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.textContent = t.label;
      b.addEventListener('click', () => this.show(t.id));
      this.tabButtons.set(t.id, b);
      bar.append(b);
    }
    const body = el('div', 'kp-body');
    this.grid = el('div', 'kp-grid');
    const side = el('div', 'kp-side');
    for (const key of SIDE) side.append(this.button(key));
    body.append(this.grid, side);
    root.append(bar, body);

    // Keys must never take focus away from the line being edited.
    root.addEventListener('pointerdown', (e) => e.preventDefault());
    this.show('main');
  }

  private show(id: string): void {
    this.tab = id;
    this.shift = false;
    for (const [tid, b] of this.tabButtons) {
      b.classList.toggle('active', tid === id);
      b.setAttribute('aria-selected', String(tid === id));
    }
    this.renderGrid();
  }

  private renderGrid(): void {
    const tab = TABS.find((t) => t.id === this.tab)!;
    this.grid.style.setProperty('--cols', String(tab.cols));
    this.grid.replaceChildren(...tab.keys.map((key) => this.button(key)));
  }

  private button(key: Key): HTMLButtonElement {
    const b = el('button', `kp-key ${key.kind ?? 'op'}`) as HTMLButtonElement;
    b.type = 'button';
    const letter = this.shift && key.insert && /^[a-z]$/.test(key.insert);
    // One wrapper, so faces like a² stay on one line inside the grid-centred key.
    b.innerHTML = `<span class="kp-face">${letter ? key.face.toUpperCase() : key.face}</span>`;
    if (key.span) b.style.gridColumn = `span ${key.span}`;
    const label = key.title ?? (key.insert?.replace('|', '').trim() || key.action || '');
    b.title = label;
    b.setAttribute('aria-label', label);
    if (key.action === 'shift') b.classList.toggle('on', this.shift);

    let repeat = 0;
    const stop = () => {
      clearTimeout(repeat);
      clearInterval(repeat);
      b.classList.remove('down');
    };
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      b.classList.add('down');
      this.press(key);
      if (key.action && REPEATS.includes(key.action)) {
        repeat = window.setTimeout(() => (repeat = window.setInterval(() => this.press(key), 55)), 420);
      }
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
    // Keyboard activation (Enter/Space on a focused key) arrives as a click with no pointer.
    b.addEventListener('click', (e) => {
      if (e.detail === 0) this.press(key);
    });
    return b;
  }

  private press(key: Key): void {
    switch (key.action) {
      case 'back':
        return this.panel.backspace();
      case 'left':
        return this.panel.moveCaret(-1);
      case 'right':
        return this.panel.moveCaret(1);
      case 'enter':
        return this.panel.enter();
      case 'shift':
        this.shift = !this.shift;
        return this.renderGrid();
    }
    let text = key.insert ?? '';
    if (this.shift && /^[a-z]$/.test(text)) {
      text = text.toUpperCase();
      this.shift = false; // one-shot, like a phone keyboard
      this.renderGrid();
    }
    this.panel.insert(text);
  }
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
