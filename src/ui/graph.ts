// The screen: time (seconds) across, speaker position up and down.
// Everything is drawn at physical-pixel resolution so lines stay sharp on any display.

import type { Dash, View } from '../state';
import { dashPattern } from './panel';

export interface Curve {
  fn: (t: number) => number;
  color: string;
  opacity: number;
  width: number;
  dash: Dash;
  /** Drawn faintly: present but not heard (another track is soloed). */
  dim: boolean;
}

export interface GraphOptions {
  getView: () => View;
  setView: (v: View) => void;
  /** Called when the user clicks (without dragging) to move the playhead. */
  onSeek: (t: number) => void;
  /** Reports the size of one major grid division, in seconds. */
  onScale?: (secondsPerDiv: number) => void;
}

export class Graph {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private curves: Curve[] = [];
  private playhead: number | null = null;
  private hoverX: number | null = null;
  private hoverY = 0;
  private dirty = true;
  private palette: Record<string, string> = {};
  private dpr = 1;
  /** Measured cost of one evaluation, per curve function, in milliseconds. */
  private msPerEval = new WeakMap<(t: number) => number, number>();

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: GraphOptions,
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    // Browser zoom or moving to another monitor changes the pixel density.
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.readPalette();
    this.bindPointer();
  }

  setCurves(curves: Curve[]): void {
    this.curves = curves;
    this.dirty = true;
  }

  setPlayhead(t: number | null): void {
    if (t !== this.playhead) this.dirty = true;
    this.playhead = t;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Re-read colours from CSS (after a theme change). */
  readPalette(): void {
    const css = getComputedStyle(this.canvas);
    for (const name of ['screen', 'screen-grid', 'screen-grid-major', 'screen-axis', 'screen-label', 'screen-limit', 'screen-ink', 'screen-tip']) {
      this.palette[name] = css.getPropertyValue(`--${name}`).trim();
    }
    this.dirty = true;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  // ---------- interaction ----------

  private bindPointer(): void {
    const c = this.canvas;
    let drag: { x: number; y: number; view: View; moved: boolean } | null = null;

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, view: { ...this.opts.getView() }, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      this.hoverX = e.pointerType === 'mouse' ? e.clientX - rect.left : null;
      this.hoverY = e.clientY - rect.top;
      this.dirty = true;
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        c.classList.add('panning');
      }
      if (!drag.moved) return;
      const v = drag.view;
      const sx = (v.x1 - v.x0) / this.width;
      const sy = (v.y1 - v.y0) / this.height;
      this.opts.setView({ x0: v.x0 - dx * sx, x1: v.x1 - dx * sx, y0: v.y0 + dy * sy, y1: v.y1 + dy * sy });
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const rect = c.getBoundingClientRect();
        const v = this.opts.getView();
        this.opts.onSeek(Math.max(0, v.x0 + ((e.clientX - rect.left) / this.width) * (v.x1 - v.x0)));
      }
      drag = null;
      c.classList.remove('panning');
    });
    c.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.dirty = true;
    });

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const fx = (e.clientX - rect.left) / this.width;
        const fy = (e.clientY - rect.top) / this.height;
        const factor = Math.exp(e.deltaY * 0.0015);
        // Wheel zooms time; Shift zooms height; Ctrl (trackpad pinch) zooms both.
        this.zoom(e.shiftKey ? 1 : factor, e.shiftKey || e.ctrlKey ? factor : 1, fx, fy);
      },
      { passive: false },
    );
  }

  zoom(fxFactor: number, fyFactor: number, fx = 0.5, fy = 0.5): void {
    const v = this.opts.getView();
    const ax = v.x0 + fx * (v.x1 - v.x0);
    const ay = v.y1 - fy * (v.y1 - v.y0);
    let x0 = ax - (ax - v.x0) * fxFactor;
    let x1 = ax + (v.x1 - ax) * fxFactor;
    // Keep spans sane: from about 10 samples to an hour.
    if (x1 - x0 < 0.0002 || x1 - x0 > 3600) {
      x0 = v.x0;
      x1 = v.x1;
    }
    this.opts.setView({ x0, x1, y0: ay - (ay - v.y0) * fyFactor, y1: ay + (v.y1 - ay) * fyFactor });
  }

  // ---------- drawing ----------

  /** Draw if anything changed. Call every animation frame. */
  frame(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  private draw(): void {
    const { ctx, width: W, height: H, palette: p } = this;
    const v = this.opts.getView();

    ctx.fillStyle = p.screen;
    ctx.fillRect(0, 0, W, H);

    const X = (t: number) => ((t - v.x0) / (v.x1 - v.x0)) * W;
    const Y = (y: number) => ((v.y1 - y) / (v.y1 - v.y0)) * H;

    const xs = niceStep((v.x1 - v.x0) / Math.max(1, W / 120));
    const ys = niceStep((v.y1 - v.y0) / Math.max(1, H / 80));
    this.opts.onScale?.(xs);
    this.drawGrid(X, Y, v, xs, ys);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const c of this.curves) {
      const { line, band } = this.trace(c, Y, v);
      const alpha = c.opacity * (c.dim ? 0.2 : 1);
      if (band) {
        ctx.fillStyle = c.color;
        ctx.globalAlpha = alpha * 0.92;
        ctx.fill(band);
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = c.color;
      ctx.lineWidth = c.width;
      ctx.lineCap = 'round';
      ctx.setLineDash(dashPattern(c.dash, c.width));
      ctx.stroke(line);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    this.drawAxes(X, Y, v, xs, ys);
    if (this.playhead !== null) this.drawPlayhead(X(this.playhead), H);
    if (this.hoverX !== null) this.drawHover(this.hoverX, v, X, Y, xs);
  }

  /** Snap a line position so a stroke `devicePx` wide lands exactly on physical pixels. */
  private crisp(pos: number, devicePx: number): number {
    const d = this.dpr;
    return (Math.round(pos * d - devicePx / 2) + devicePx / 2) / d;
  }

  private drawGrid(X: (t: number) => number, Y: (y: number) => number, v: View, xs: number, ys: number): void {
    const { ctx, width: W, height: H, palette: p } = this;
    const hairline = 1 / this.dpr; // one physical pixel, on any display
    const lines = (xStep: number, yStep: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = hairline;
      ctx.beginPath();
      for (let t = Math.ceil(v.x0 / xStep) * xStep; t <= v.x1; t += xStep) {
        const x = this.crisp(X(t), 1);
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (let y = Math.ceil(v.y0 / yStep) * yStep; y <= v.y1; y += yStep) {
        const yy = this.crisp(Y(y), 1);
        ctx.moveTo(0, yy);
        ctx.lineTo(W, yy);
      }
      ctx.stroke();
    };
    lines(xs / 5, ys / 5, p['screen-grid']);
    lines(xs, ys, p['screen-grid-major']);

    // ±1 is as far as the speaker can go; anything beyond is clipped.
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = p['screen-limit'];
    ctx.lineWidth = hairline;
    ctx.beginPath();
    for (const lim of [1, -1]) {
      const yy = this.crisp(Y(lim), 1);
      ctx.moveTo(0, yy);
      ctx.lineTo(W, yy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** The main axes sit above the traces, bold, with their labels. */
  private drawAxes(X: (t: number) => number, Y: (y: number) => number, v: View, xs: number, ys: number): void {
    const { ctx, width: W, height: H, palette: p } = this;
    const bold = Math.max(2, Math.round(1.75 * this.dpr));
    ctx.strokeStyle = p['screen-axis'];
    ctx.lineWidth = bold / this.dpr;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    const x0 = this.crisp(X(0), bold);
    const y0 = this.crisp(Y(0), bold);
    if (x0 >= 0 && x0 <= W) {
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, H);
    }
    if (y0 >= 0 && y0 <= H) {
      ctx.moveTo(0, y0);
      ctx.lineTo(W, y0);
    }
    ctx.stroke();

    // Labels get a halo in the screen colour so they stay readable over traces.
    ctx.font = '500 10.5px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = p.screen;
    ctx.fillStyle = p['screen-label'];
    const label = (text: string, x: number, y: number) => {
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    };
    const axisY = Math.min(H - 30, Math.max(12, Y(0) + 13));
    ctx.textAlign = 'center';
    for (let t = Math.ceil(v.x0 / xs) * xs; t <= v.x1; t += xs) {
      if (Math.abs(t) < xs / 2) continue;
      label(formatTime(t, xs), X(t), axisY);
    }
    const nearLeft = X(0) < 40;
    const axisX = nearLeft ? 8 : Math.min(W - 8, X(0) - 8);
    ctx.textAlign = nearLeft ? 'left' : 'right';
    for (let y = Math.ceil(v.y0 / ys) * ys; y <= v.y1; y += ys) {
      // Skip zero and labels that would sit under the screen's edge furniture.
      if (Math.abs(y) < ys / 2 || Y(y) < 14 || Y(y) > H - 30) continue;
      label(formatNum(y, ys), axisX, Y(y));
    }
  }

  /**
   * Sample a curve once per physical pixel column (several sub-samples each).
   * Where the signal is smooth at this zoom, it becomes an anti-aliased polyline.
   * Where many oscillations fall inside one pixel (audio seen from afar), drawing
   * the zig-zag would alias into noise, so those runs become a filled min/max
   * envelope instead, the way audio editors draw waveforms.
   */
  private trace(c: Curve, Y: (y: number) => number, v: View): { line: Path2D; band: Path2D | null } {
    const d = this.dpr;
    const fullCols = Math.ceil(this.width * d);
    let sub = Math.min(24, Math.max(4, Math.ceil(((v.x1 - v.x0) / fullCols) * 48000 * 1.5)));
    // Heavy formulas (a whole song as equations) would make each redraw slow. Keep a
    // redraw within a time budget by sampling less: fewer sub-samples, then wider columns.
    let stride = 1;
    const cost = this.msPerEval.get(c.fn) ?? 0.0003;
    const budgetMs = 12;
    if (cost * fullCols * sub > budgetMs) {
      sub = Math.max(2, Math.floor(budgetMs / (cost * fullCols)));
      if (cost * fullCols * sub > budgetMs) stride = Math.ceil((cost * fullCols * sub) / budgetMs);
    }
    const cols = Math.ceil(fullCols / stride);
    const px = stride / d; // width of one sampled column, in CSS pixels
    const dt = (v.x1 - v.x0) / cols;
    const started = performance.now();
    const clampY = (y: number) => Math.max(-1e4, Math.min(1e4, Y(y)));

    const line = new Path2D();
    let band: Path2D | null = null;
    let lineOpen = false;
    let top: number[] = [];
    let bottom: number[] = [];

    const flushBand = () => {
      if (top.length === 0) return;
      band ??= new Path2D();
      // Give one-column runs some width so they don't vanish.
      if (top.length === 2) {
        top.push(top[0] + px, top[1]);
        bottom.push(bottom[0] + px, bottom[1]);
      }
      band.moveTo(top[0], top[1]);
      for (let i = 2; i < top.length; i += 2) band.lineTo(top[i], top[i + 1]);
      for (let i = bottom.length - 2; i >= 0; i -= 2) band.lineTo(bottom[i], bottom[i + 1]);
      band.closePath();
      top = [];
      bottom = [];
    };

    let prev = NaN;
    for (let col = 0; col <= cols; col++) {
      const x = col * px;
      let mn = Infinity;
      let mx = -Infinity;
      let first = NaN;
      let last = NaN;
      let turns = 0;
      let dir = 0;
      let turnK = 0;
      let turnVal = 0;
      let before = prev;
      for (let k = 0; k < sub; k++) {
        const val = c.fn(v.x0 + (col + k / sub) * dt);
        if (!(val - val === 0)) {
          before = NaN;
          continue;
        }
        if (first !== first) first = val;
        if (before === before && val !== before) {
          const nd = val > before ? 1 : -1;
          if (dir !== 0 && nd !== dir) {
            turns++;
            turnK = k - 1;
            turnVal = before;
          }
          dir = nd;
        }
        before = val;
        last = val;
        if (val < mn) mn = val;
        if (val > mx) mx = val;
      }
      prev = last;

      if (first !== first) {
        flushBand();
        lineOpen = false;
        continue;
      }

      const dense = turns >= 2 && clampY(mn) - clampY(mx) > 1.25;
      if (dense) {
        if (lineOpen) line.lineTo(x, clampY(first));
        lineOpen = false;
        top.push(x, clampY(mx));
        bottom.push(x, clampY(mn));
        continue;
      }

      if (top.length) {
        flushBand();
        line.moveTo(x, clampY(first));
      } else if (!lineOpen) {
        line.moveTo(x, clampY(first));
      } else {
        line.lineTo(x, clampY(first));
      }
      lineOpen = true;
      // Keep a peak that falls between columns, so sharp tips stay sharp.
      if (turns === 1) line.lineTo(x + (turnK / sub) * px, clampY(turnVal));
    }
    flushBand();
    // Learn how expensive this curve is, for the next redraw's budget.
    const evals = (cols + 1) * sub;
    const per = (performance.now() - started) / evals;
    const prevCost = this.msPerEval.get(c.fn);
    this.msPerEval.set(c.fn, prevCost === undefined ? per : prevCost * 0.6 + per * 0.4);
    return { line, band };
  }

  private drawPlayhead(px: number, H: number): void {
    if (px < -2 || px > this.width + 2) return;
    const { ctx, palette: p } = this;
    const x = this.crisp(px, Math.max(1, Math.round(this.dpr)));
    ctx.strokeStyle = p['screen-ink'];
    ctx.fillStyle = p['screen-ink'];
    ctx.lineWidth = Math.max(1, Math.round(this.dpr)) / this.dpr;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 6);
    ctx.closePath();
    ctx.fill();
  }

  /** Crosshair readout: time at the cursor and each trace's value there. */
  private drawHover(hx: number, v: View, X: (t: number) => number, Y: (y: number) => number, xs: number): void {
    const { ctx, height: H, palette: p } = this;
    const t = v.x0 + (hx / this.width) * (v.x1 - v.x0);
    const x = this.crisp(hx, 1);
    ctx.strokeStyle = p['screen-label'];
    ctx.lineWidth = 1 / this.dpr;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.setLineDash([]);

    const rows: { text: string; color: string }[] = [{ text: `t ${formatTime(t, xs / 50)}`, color: '' }];
    for (const c of this.curves) {
      if (c.dim) continue;
      const y = c.fn(t);
      if (!(y - y === 0)) continue;
      ctx.beginPath();
      ctx.arc(X(t), Y(y), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = p.screen;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = c.color;
      ctx.stroke();
      const shown = Math.abs(y) < 0.0005 ? 0 : y; // no "-0.000"
      rows.push({ text: `y ${shown >= 0 ? ' ' : ''}${shown.toFixed(3)}`, color: c.color });
    }

    ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
    const w = Math.max(...rows.map((r) => ctx.measureText(r.text).width)) + 28;
    const h = rows.length * 17 + 10;
    const left = hx + 12 + w > this.width ? hx - 12 - w : hx + 12;
    // Follow the pointer, staying clear of the toolbar and the bottom edge.
    const top = Math.max(60, Math.min(H - h - 36, this.hoverY + 16));
    ctx.beginPath();
    ctx.roundRect(left, top, w, h, 8);
    ctx.fillStyle = p['screen-tip'];
    ctx.fill();
    ctx.strokeStyle = p['screen-grid-major'];
    ctx.lineWidth = 1 / this.dpr;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    rows.forEach((r, i) => {
      const y = top + 13 + i * 17;
      if (i > 0) {
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(left + 8, y);
        ctx.lineTo(left + 15, y);
        ctx.stroke();
      }
      ctx.fillStyle = i === 0 ? p['screen-label'] : p['screen-ink'];
      ctx.fillText(r.text, left + (i === 0 ? 9 : 20), y);
    });
  }
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function decimals(step: number): number {
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

export function formatNum(n: number, step: number): string {
  return n.toFixed(decimals(step));
}

export function formatTime(t: number, step: number): string {
  if (step < 0.1) return `${(t * 1000).toFixed(decimals(step * 1000))} ms`;
  return `${t.toFixed(decimals(step))} s`;
}
