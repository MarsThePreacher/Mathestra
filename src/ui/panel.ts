// The expression list. Rows are kept and patched in place (never rebuilt while
// you type or drag a slider), so focus and pointer captures survive updates.

import type { Instance, LineInfo, Program } from '../math/compiler';
import { COLORS, looksLikeTrack, makeItem, STYLE_DEFAULTS, type Item, type Store } from '../state';
import { MathField } from './mathField';
import { formatDuration, type Clips } from '../audio/clips';
import { BUILTIN_FUNCS, CONSTANTS, TIME_VARS } from '../math/builtins';

interface Row {
  root: HTMLElement;
  index: HTMLElement;
  dot: HTMLButtonElement;
  field: MathField;
  extra: HTMLElement;
  signature: string;
  refs: Record<string, HTMLElement>;
  /** Audio lines: sizes the clip-name box to its text. */
  fitName?: () => void;
}

const LONG_PRESS_MS = 450;

/** Dash pattern for a trace style, scaled to its thickness. Shared by the graph and the previews. */
export function dashPattern(dash: Item['dash'], width: number): number[] {
  if (dash === 'dashed') return [Math.max(5, width * 4.5), Math.max(4, width * 3.5)];
  if (dash === 'dotted') return [0.01, Math.max(3, width * 2.8)];
  return [];
}

export class Panel {
  private rows = new Map<string, Row>();
  private firstRender = true;
  private activeId: string | null = null;
  private keypadOpen = false;
  /** Viewing someone else's graph: everything can be read and played, nothing changed. */
  private readOnly = false;
  private touch = false;
  /** A line was tapped or focused (touch screens open the keypad then). */
  onLineTap: () => void = () => {};

  /** Long-press (or right-click) on a graph icon asks for the style editor. */
  onStyleRequest: (id: string, anchor: HTMLElement) => void = () => {};
  /** Imported audio, for drawing clip lines. Set by the page. */
  clips: Clips | null = null;

  constructor(
    private list: HTMLElement,
    private store: Store,
  ) {}

  /** Focus the row for this item, caret at the end. */
  focus(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.field.focus({ preventScroll: true });
    const n = row.field.value.length;
    row.field.setSelectionRange(n, n);
    reveal(row.root);
  }

  render(program: Program, instance: Instance | null): void {
    const items = this.store.doc.items;
    const alive = new Set(items.map((it) => it.id));
    for (const [id, row] of this.rows) {
      if (!alive.has(id)) {
        row.root.remove();
        this.rows.delete(id);
      }
    }
    items.forEach((item, i) => {
      let row = this.rows.get(item.id);
      if (!row) {
        row = this.createRow(item.id);
        // A short cascade on first load; later rows just appear where they're added.
        if (this.firstRender) row.root.style.animationDelay = `${Math.min(i, 14) * 22}ms`;
        this.rows.set(item.id, row);
      }
      if (this.list.children[i] !== row.root) this.list.insertBefore(row.root, this.list.children[i] ?? null);
      row.index.textContent = String(i + 1);
      this.updateRow(row, item, program.lines[i], instance);
      this.applyReadOnly(row);
    });
    this.firstRender = false;
  }

  // ---------- editing API used by the on-screen keypad ----------

  /** While the keypad is open, phones shouldn't also raise their own keyboard. */
  setKeypadOpen(open: boolean): void {
    this.keypadOpen = open;
    this.applyInputMode();
  }

  setReadOnly(on: boolean): void {
    this.readOnly = on;
    for (const row of this.rows.values()) this.applyReadOnly(row);
  }

  private applyReadOnly(row: Row): void {
    row.field.setEditable(!this.readOnly);
    row.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.extra input, .extra button').forEach((el) => {
      el.disabled = this.readOnly;
    });
  }

  /** On touch screens equations always use the on-screen keypad, never the system keyboard. */
  setTouch(touch: boolean): void {
    this.touch = touch;
    this.applyInputMode();
  }

  private inputMode(): string {
    return this.keypadOpen || this.touch ? 'none' : 'text';
  }

  private applyInputMode(): void {
    for (const row of this.rows.values()) row.field.inputMode = this.inputMode();
  }

  /** The line being edited; picks (or makes) one if nothing is focused yet. */
  private target(): MathField {
    let row = this.activeId ? this.rows.get(this.activeId) : undefined;
    if (!row) {
      const items = this.store.doc.items;
      const last = items[items.length - 1];
      const id = last && last.text.trim() === '' ? last.id : this.insertAfter(null, '');
      row = this.rows.get(id)!;
      this.activeId = id;
      row.field.focus({ preventScroll: true });
      const n = row.field.value.length;
      row.field.setSelectionRange(n, n);
    }
    if (!row.field.focused) row.field.focus({ preventScroll: true });
    reveal(row.root);
    return row.field;
  }

  /**
   * Insert text at the caret. A '|' in the template marks where the caret lands,
   * and any selected text is wrapped there: selecting "x" then √ gives sqrt(x).
   */
  insert(template: string): void {
    if (this.readOnly) return;
    const t = this.target();
    const start = t.selectionStart;
    const end = t.selectionEnd;
    const selected = t.value.slice(start, end);
    const bar = template.indexOf('|');
    const before = bar === -1 ? template : template.slice(0, bar);
    const after = bar === -1 ? '' : template.slice(bar + 1);
    t.setRangeText(before + selected + after, start, end);
    const caret = start + before.length + selected.length;
    t.setSelectionRange(caret, caret);
    t.commit();
  }

  backspace(): void {
    if (this.readOnly) return;
    const t = this.target();
    const start = t.selectionStart;
    const end = t.selectionEnd;
    if (start !== end) {
      t.setRangeText('', start, end);
    } else if (start > 0) {
      // Deleting into an empty pair like "()" removes both halves.
      const pair = t.value[start - 1] + (t.value[start] ?? '');
      const both = ['()', '[]', '{}'].includes(pair);
      t.setRangeText('', start - 1, both ? start + 1 : start);
    } else if (t.value === '' && this.store.doc.items.length > 1 && this.activeId) {
      this.removeAndFocusPrevious(this.activeId);
      return;
    } else {
      return;
    }
    t.commit();
  }

  moveCaret(delta: number): void {
    const t = this.target();
    const pos = delta < 0 ? Math.min(t.selectionStart, t.selectionEnd) : Math.max(t.selectionStart, t.selectionEnd);
    const collapsed = t.selectionStart === t.selectionEnd;
    const next = collapsed ? Math.max(0, Math.min(t.value.length, pos + delta)) : pos;
    t.setSelectionRange(next, next);
  }

  enter(): void {
    if (this.readOnly) return;
    // With nothing selected, target() already starts a fresh line; don't add a second.
    const hadLine = !!(this.activeId && this.rows.has(this.activeId));
    this.target();
    if (hadLine) this.focus(this.insertAfter(this.activeId, ''));
  }

  // ---------- row lifecycle ----------

  private item(id: string): Item | undefined {
    return this.store.doc.items.find((it) => it.id === id);
  }

  private indexOf(id: string): number {
    return this.store.doc.items.findIndex((it) => it.id === id);
  }

  insertAfter(id: string | null, text: string): string {
    const items = this.store.doc.items;
    const at = id === null ? items.length : this.indexOf(id) + 1;
    const used = new Set(items.filter((it) => looksLikeTrack(it.text)).map((it) => it.color));
    const item = makeItem(text, items.length);
    item.color = COLORS.find((c) => !used.has(c)) ?? item.color;
    this.store.update((d) => d.items.splice(at, 0, item));
    return item.id;
  }

  private remove(id: string): void {
    this.store.update((d) => {
      d.items = d.items.filter((it) => it.id !== id);
      if (d.items.length === 0) d.items.push(makeItem('', 0));
    });
  }

  private removeAndFocusPrevious(id: string): void {
    const items = this.store.doc.items;
    const i = this.indexOf(id);
    const prev = i > 0 ? items[i - 1].id : items[1].id;
    this.remove(id);
    this.focus(prev);
  }

  private createRow(id: string): Row {
    const root = el('div', 'row');
    const gutter = el('div', 'gutter');
    const index = el('span', 'index');
    const dot = el('button', 'dot') as HTMLButtonElement;
    dot.type = 'button';
    dot.setAttribute('aria-haspopup', 'dialog');
    // A tiny piece of trace in the track's colour: the console's only colour, linking line to graph.
    dot.innerHTML = '<svg viewBox="0 0 20 12" aria-hidden="true"><path d="M1 6c1.8-6 3.7-6 5.5 0s3.7 6 5.5 0 3.7-6 5.5 0"/></svg>';
    gutter.append(index, dot);

    const body = el('div', 'body');
    // Typeset like Desmos as you type; long equations wrap.
    const field = new MathField('y = …');
    field.inputMode = this.inputMode();
    const extra = el('div', 'extra');
    body.append(field.el, extra);

    const del = el('button', 'del') as HTMLButtonElement;
    del.type = 'button';
    del.title = 'Delete line';
    del.setAttribute('aria-label', 'Delete line');
    del.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    root.append(gutter, body, del);

    field.el.addEventListener('focus', () => {
      this.activeId = id;
      this.onLineTap();
    });
    // A tap on the line already being edited (keypad was closed) brings the keypad back.
    field.el.addEventListener('click', () => this.onLineTap());
    field.onChange = (value) =>
      this.store.update(() => {
        const it = this.item(id);
        if (it) it.text = value;
      });
    field.el.addEventListener('keydown', (e) => this.onKey(e, id, field));
    del.addEventListener('click', () => this.remove(id));
    this.bindGraphIcon(dot, id);

    return { root, index, dot, field, extra, signature: '', refs: {} };
  }

  /** Click: show or hide the graph. Hold (or right-click): edit its style. */
  private bindGraphIcon(dot: HTMLButtonElement, id: string): void {
    let timer = 0;
    let held = false;
    const cancel = () => {
      clearTimeout(timer);
      dot.classList.remove('holding');
    };
    dot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.readOnly) return;
      held = false;
      dot.classList.add('holding');
      timer = window.setTimeout(() => {
        held = true;
        dot.classList.remove('holding');
        navigator.vibrate?.(8);
        this.onStyleRequest(id, dot);
      }, LONG_PRESS_MS);
    });
    dot.addEventListener('pointerup', cancel);
    dot.addEventListener('pointerleave', cancel);
    dot.addEventListener('pointercancel', cancel);
    dot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.readOnly) return;
      cancel();
      held = true;
      this.onStyleRequest(id, dot);
    });
    dot.addEventListener('click', (e) => {
      if (held || this.readOnly) {
        held = false;
        e.preventDefault();
        return;
      }
      this.store.update(() => {
        const it = this.item(id);
        if (it) it.muted = !it.muted;
      });
    });
  }

  private onKey(e: KeyboardEvent, id: string, field: MathField): void {
    if (this.readOnly) {
      // Moving between lines is fine; anything that edits is not.
      if (e.key === 'Enter' || e.key === 'Backspace') e.preventDefault();
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    }
    const items = this.store.doc.items;
    const i = this.indexOf(id);
    if (e.key === 'Enter') {
      e.preventDefault();
      this.focus(this.insertAfter(id, ''));
    } else if (e.key === 'Backspace' && field.value === '' && items.length > 1) {
      e.preventDefault();
      this.removeAndFocusPrevious(id);
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault();
      this.focus(items[i - 1].id);
    } else if (e.key === 'ArrowDown' && i < items.length - 1) {
      e.preventDefault();
      this.focus(items[i + 1].id);
    }
  }

  // ---------- per-kind details under the input ----------

  private updateRow(row: Row, item: Item, line: LineInfo, instance: Instance | null): void {
    if (item.audio) return this.updateAudioRow(row, item);
    if (row.field.value !== item.text) row.field.value = item.text;

    const isTrack = line.kind === 'track' && !line.error;
    row.root.className = `row kind-${line.kind}${line.error ? ' has-error' : ''}${isTrack && item.muted ? ' muted' : ''}`;
    row.root.style.setProperty('--track', item.color);
    row.dot.hidden = !isTrack;
    row.dot.title = `${item.muted ? 'Show' : 'Hide'} graph · hold to style`;
    row.dot.setAttribute('aria-label', item.muted ? 'Show graph' : 'Hide graph');
    row.dot.setAttribute('aria-pressed', String(!item.muted));
    // The icon previews the trace's own style.
    const path = row.dot.querySelector('path')!;
    const width = item.width ?? STYLE_DEFAULTS.width;
    path.style.strokeOpacity = String(item.opacity ?? STYLE_DEFAULTS.opacity);
    path.style.strokeWidth = String(Math.min(3, 1 + width * 0.45));
    path.style.strokeDasharray = item.muted ? '' : dashPattern(item.dash, 0.6).join(' ');

    let sig = 'none';
    if (line.error) sig = `error|${line.error}|${line.missing?.join() ?? ''}`;
    else if (isTrack) sig = 'track';
    else if (line.kind === 'slider') sig = 'slider';
    else if (line.valueIndex !== undefined) sig = 'value';

    if (sig !== row.signature) {
      row.signature = sig;
      row.extra.replaceChildren();
      row.refs = {};
      if (sig.startsWith('error')) this.buildError(row, item.id, line);
      else if (sig === 'track') this.buildTrack(row, item.id);
      else if (sig === 'slider') this.buildSlider(row, item.id, line.name!);
      else if (sig === 'value') row.refs.value = row.extra.appendChild(el('span', 'value'));
    }

    if (sig === 'track') {
      (row.refs.solo as HTMLButtonElement).classList.toggle('on', item.solo);
      const volume = row.refs.volume as HTMLInputElement;
      volume.value = String(item.volume);
      setFill(volume);
    } else if (sig === 'slider') {
      this.syncSlider(row, item, line.sliderValue!);
    } else if (sig === 'value') {
      let text = '';
      try {
        text = '= ' + formatValue(instance!.values[line.valueIndex!]());
      } catch {
        text = '= ?';
      }
      row.refs.value.textContent = text;
    }
  }

  // ---------- audio lines ----------

  /** An imported clip: its function name, waveform, length and where it is stored. */
  private updateAudioRow(row: Row, item: Item): void {
    const audio = item.audio!;
    row.root.className = 'row kind-audio';
    row.dot.hidden = true;
    if (row.signature !== 'audio') {
      row.signature = 'audio';
      row.extra.replaceChildren();
      row.refs = {};
      const head = el('div', 'audio-head');
      const name = el('input', 'audio-name') as HTMLInputElement;
      name.spellcheck = false;
      name.setAttribute('autocapitalize', 'off');
      name.setAttribute('aria-label', 'Clip name, used in equations');
      name.title = 'The name you use in equations';
      const sig = el('span', 'audio-sig');
      sig.textContent = '(t)';
      const file = el('span', 'audio-file');
      head.append(name, sig, file);
      const wave = el('canvas', 'audio-wave') as HTMLCanvasElement;
      wave.setAttribute('aria-hidden', 'true');
      const meta = el('div', 'audio-meta');
      const length = el('span', 'audio-length');
      const status = el('span', 'audio-status');
      meta.append(length, status);
      row.extra.append(head, wave, meta);
      Object.assign(row.refs, { name, file, wave, length, status });
      // The name box hugs its text in every browser, so "(t)" sits right after it.
      const fit = () => {
        // Measure the real text in the box's own font, so any name fits exactly.
        const ctx = (measureCanvas ??= document.createElement('canvas')).getContext('2d')!;
        ctx.font = getComputedStyle(name).font;
        name.style.width = `${Math.ceil(ctx.measureText(name.value || 'mm').width) + 6}px`;
      };
      name.addEventListener('input', fit);
      row.fitName = fit;
      name.addEventListener('change', () => this.renameClip(item.id, name));
      name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    }
    const r = row.refs as Record<string, HTMLElement>;
    const name = r.name as HTMLInputElement;
    if (document.activeElement !== name) name.value = audio.name;
    row.fitName?.();
    r.file.textContent = audio.file;
    r.file.title = audio.file;
    r.length.textContent = formatDuration(audio.duration);
    const entry = this.clips?.status(audio.key);
    const states: Record<string, string> = {
      loading: 'Loading…',
      ready: audio.url ? 'Saved online' : 'On this device',
      missing: 'The file is not available on this device',
      error: 'The file could not be read',
    };
    r.status.textContent = states[entry?.status ?? 'loading'];
    r.status.classList.toggle('warn', entry?.status === 'missing' || entry?.status === 'error');
    const wave = r.wave as HTMLCanvasElement;
    requestAnimationFrame(() =>
      this.clips?.draw(wave, audio.key, getComputedStyle(document.documentElement).getPropertyValue('--ink-2').trim()),
    );
  }

  /** Names everything already uses: built-ins, defined names and other clips. */
  takenNames(exceptId?: string): Set<string> {
    const taken = new Set<string>([...Object.keys(BUILTIN_FUNCS), ...Object.keys(CONSTANTS), ...TIME_VARS, 'y']);
    for (const it of this.store.doc.items) {
      if (it.id === exceptId) continue;
      if (it.audio) taken.add(it.audio.name);
      const m = /^\s*([A-Za-z]+(?:_[A-Za-z0-9]+)?)\s*(?:\(|=)/.exec(it.text);
      if (m) taken.add(m[1]);
    }
    return taken;
  }

  /** Rename a clip, and update the lines that call it so nothing breaks. */
  private renameClip(id: string, input: HTMLInputElement): void {
    const item = this.item(id);
    if (!item?.audio) return;
    const old = item.audio.name;
    const next = input.value.trim();
    const row = this.rows.get(id)!;
    const fail = (msg: string) => {
      input.value = old;
      row.refs.status.textContent = msg;
      row.refs.status.classList.add('warn');
    };
    if (next === old) return;
    if (!/^[A-Za-z]+(_[A-Za-z0-9]+)?$/.test(next)) return fail('Use letters, optionally followed by _ and letters or digits');
    if (this.takenNames(id).has(next)) return fail(`${next} is already in use`);
    const call = new RegExp(`(?<![A-Za-z_])${old}(?=\\s*\\()`, 'g');
    this.store.update((d) => {
      item.audio!.name = next;
      for (const it of d.items) if (!it.audio) it.text = it.text.replace(call, next);
    });
  }

  private buildError(row: Row, id: string, line: LineInfo): void {
    const msg = el('span', 'error');
    msg.textContent = line.error!;
    row.extra.append(msg);
    for (const name of line.missing ?? []) {
      const b = el('button', 'chip') as HTMLButtonElement;
      b.type = 'button';
      b.textContent = `Add slider ${name}`;
      b.addEventListener('click', () => this.insertAfter(id, `${name} = 1`));
      row.extra.append(b);
    }
  }

  private buildTrack(row: Row, id: string): void {
    const solo = el('button', 'chip solo') as HTMLButtonElement;
    solo.type = 'button';
    solo.textContent = 'S';
    solo.title = 'Solo: hear only soloed tracks';
    solo.setAttribute('aria-label', 'Solo track');
    solo.addEventListener('click', () =>
      this.store.update(() => {
        const it = this.item(id);
        if (it) it.solo = !it.solo;
      }),
    );
    const volume = rangeInput(0, 1, 0.01);
    volume.className = 'volume-range';
    volume.setAttribute('aria-label', 'Track volume');
    volume.addEventListener('input', () =>
      this.store.update(() => {
        const it = this.item(id);
        if (it) it.volume = Number(volume.value);
      }),
    );
    row.extra.append(solo, volume);
    Object.assign(row.refs, { solo, volume });
  }

  private buildSlider(row: Row, id: string, name: string): void {
    const min = numberInput();
    const max = numberInput();
    const range = rangeInput(0, 1, 0.01);
    range.className = 'slider';
    range.setAttribute('aria-label', `Value of ${name}`);
    const step = numberInput();
    step.title = 'Step';
    range.addEventListener('input', () =>
      this.store.update(() => {
        const it = this.item(id);
        if (it) it.text = `${name} = ${trim(Number(range.value))}`;
      }),
    );
    const bound = (input: HTMLInputElement, key: 'min' | 'max' | 'step') =>
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || (key === 'step' && v <= 0)) return;
        this.store.update(() => {
          const it = this.item(id);
          if (it) it[key] = v;
        });
      });
    bound(min, 'min');
    bound(max, 'max');
    bound(step, 'step');
    const stepLabel = el('span', 'mini-label');
    stepLabel.textContent = 'step';
    row.extra.append(min, range, max, stepLabel, step);
    Object.assign(row.refs, { min, max, range, step });
  }

  private syncSlider(row: Row, item: Item, value: number): void {
    // Freeze a sensible range the first time, widen it if a typed value escapes it.
    if (item.min === undefined || item.max === undefined || item.step === undefined) {
      const mag = Math.pow(10, Math.ceil(Math.log10(Math.max(Math.abs(value), 1e-9) + 1e-12)));
      const span = value === 0 ? 10 : Math.max(mag, 1e-3);
      item.min = value < 0 ? -span : 0;
      item.max = span;
      item.step = span / 1000;
    }
    if (value < item.min) item.min = value;
    if (value > item.max) item.max = value;
    const { min, max, range, step } = row.refs as Record<string, HTMLInputElement>;
    if (document.activeElement !== min) min.value = trim(item.min);
    if (document.activeElement !== max) max.value = trim(item.max);
    if (document.activeElement !== step) step.value = trim(item.step);
    range.min = String(item.min);
    range.max = String(item.max);
    range.step = String(item.step);
    range.value = String(value);
    setFill(range);
  }
}

/**
 * Bring a line into view. On phones the screen is pinned above and the keypad below,
 * so the browser's own focus scrolling can leave a line hidden behind them; the
 * rows' scroll-margin (style.css) describes those pinned areas and this respects it.
 */
function reveal(el: HTMLElement): void {
  requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}

let measureCanvas: HTMLCanvasElement | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

/** Paint the filled part of a range track (WebKit has no ::range-progress). */
export function setFill(r: HTMLInputElement): void {
  const min = Number(r.min);
  const span = Number(r.max) - min || 1;
  r.style.setProperty('--fill', `${((Number(r.value) - min) / span) * 100}%`);
}

function rangeInput(min: number, max: number, step: number): HTMLInputElement {
  const r = document.createElement('input');
  r.type = 'range';
  r.min = String(min);
  r.max = String(max);
  r.step = String(step);
  return r;
}

function numberInput(): HTMLInputElement {
  const n = document.createElement('input');
  n.className = 'bound';
  n.inputMode = 'decimal';
  n.spellcheck = false;
  return n;
}

/** Round away float noise from slider steps: 0.30000000000000004 → 0.3 */
export function trim(n: number): string {
  return String(Number(n.toPrecision(10)));
}

export function formatValue(v: number | number[]): string {
  if (Array.isArray(v)) {
    // Long data lists get a short preview and a count, not every number.
    if (v.length > 12) return `[${v.slice(0, 6).map(formatValue).join(', ')}, …]   ${v.length.toLocaleString('en')} numbers`;
    return `[${v.map(formatValue).join(', ')}]`;
  }
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'undefined' : String(v);
  return String(Number(v.toPrecision(6)));
}
