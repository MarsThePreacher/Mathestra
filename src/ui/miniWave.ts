// Small static waveform pictures: thumbnails in "My graphs" and on the landing page.
// Each trace is drawn as a ribbon between its min and max per physical pixel, so a
// smooth curve reads as a crisp line and dense audio as a clean filled shape.

import { compile, instantiate } from '../math/compiler';
import { STYLE_DEFAULTS, type Doc } from '../state';

export interface MiniTrace {
  fn: (t: number) => number;
  color: string;
  opacity?: number;
}

export function drawMini(
  canvas: HTMLCanvasElement,
  traces: MiniTrace[],
  view: { x0: number; x1: number; y0: number; y1: number },
  opts: { axis?: string; lineWidth?: number } = {},
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const Y = (y: number) => ((view.y1 - y) / (view.y1 - view.y0)) * h;

  if (opts.axis) {
    ctx.fillStyle = opts.axis;
    ctx.fillRect(0, Math.round(Y(0) * dpr) / dpr - 0.5, w, 1);
  }

  const cols = Math.ceil(w * dpr);
  const dt = (view.x1 - view.x0) / cols;
  const sub = Math.min(16, Math.max(3, Math.ceil(dt * 48000)));
  const half = (opts.lineWidth ?? 1.4) / 2;
  for (const tr of traces) {
    const top: number[] = [];
    const bottom: number[] = [];
    const flush = () => {
      if (top.length < 4) {
        top.length = bottom.length = 0;
        return;
      }
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      for (let i = 2; i < top.length; i += 2) ctx.lineTo(top[i], top[i + 1]);
      for (let i = bottom.length - 2; i >= 0; i -= 2) ctx.lineTo(bottom[i], bottom[i + 1]);
      ctx.closePath();
      ctx.fill();
      top.length = bottom.length = 0;
    };
    ctx.fillStyle = tr.color;
    ctx.globalAlpha = tr.opacity ?? 1;
    for (let c = 0; c <= cols; c++) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let k = 0; k < sub; k++) {
        const v = tr.fn(view.x0 + (c + k / sub) * dt);
        if (v - v !== 0) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mn === Infinity) {
        flush();
        continue;
      }
      const x = c / dpr;
      top.push(x, Math.max(-50, Y(mx) - half));
      bottom.push(x, Math.min(h + 50, Y(mn) + half));
    }
    flush();
  }
  ctx.globalAlpha = 1;
}

/** Compile a whole piece and return its visible tracks, ready for drawMini. */
export function tracesOf(doc: Doc): MiniTrace[] {
  try {
    const program = compile(
      doc.items.map((it) => (it.audio ? '' : it.text)),
      doc.items.flatMap((it) => (it.audio ? [it.audio.name] : [])),
    );
    const inst = instantiate(program.source, program.vars);
    return doc.items.flatMap((item, i) => {
      const line = program.lines[i];
      if (line.trackIndex === undefined || item.muted) return [];
      return [{ fn: inst.tracks[line.trackIndex], color: item.color, opacity: item.opacity ?? STYLE_DEFAULTS.opacity }];
    });
  } catch {
    return [];
  }
}
