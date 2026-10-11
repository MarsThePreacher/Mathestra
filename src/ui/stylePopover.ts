// Style editor for one graph: colour, opacity, thickness and line style,
// opened by holding (or right-clicking) the graph icon beside an expression.

import { COLORS, DASHES, STYLE_DEFAULTS, type Dash, type Item, type Store } from '../state';
import { dashPattern } from './panel';

const DASH_LABEL: Record<Dash, string> = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' };

export class StylePopover {
  private root: HTMLElement;
  private id: string | null = null;
  private anchor: HTMLElement | null = null;
  private els: Record<string, HTMLElement> = {};

  constructor(private store: Store) {
    this.root = document.createElement('div');
    this.root.className = 'style-pop';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Graph style');
    this.root.innerHTML = `
      <svg class="sp-preview" viewBox="0 0 240 48" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="24" x2="240" y2="24" class="sp-axis"/>
        <path d="M0 24 C 15 2, 25 2, 40 24 S 65 46, 80 24 S 105 2, 120 24 S 145 46, 160 24 S 185 2, 200 24 S 225 46, 240 24"/>
      </svg>
      <div class="sp-section">
        <span class="sp-label">Colour</span>
        <div class="sp-swatches" role="radiogroup" aria-label="Colour"></div>
      </div>
      <label class="sp-section">
        <span class="sp-label">Opacity <output data-out="opacity"></output></span>
        <input type="range" data-in="opacity" min="0.1" max="1" step="0.05" />
      </label>
      <label class="sp-section">
        <span class="sp-label">Thickness <output data-out="width"></output></span>
        <input type="range" data-in="width" min="0.5" max="5" step="0.25" />
      </label>
      <div class="sp-section">
        <span class="sp-label">Line</span>
        <div class="sp-dashes" role="radiogroup" aria-label="Line style"></div>
      </div>
      <div class="sp-foot">
        <button type="button" class="sp-btn" data-act="reset">Reset</button>
        <button type="button" class="sp-btn strong" data-act="visible"></button>
      </div>`;
    document.body.append(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.els = {
      path: q('.sp-preview path'),
      swatches: q('.sp-swatches'),
      dashes: q('.sp-dashes'),
      opacity: q('[data-in="opacity"]'),
      width: q('[data-in="width"]'),
      opacityOut: q('[data-out="opacity"]'),
      widthOut: q('[data-out="width"]'),
      visible: q('[data-act="visible"]'),
    };

    for (const c of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-swatch';
      b.style.setProperty('--c', c);
      b.dataset.color = c;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', c);
      b.addEventListener('click', () => this.set({ color: c }));
      this.els.swatches.append(b);
    }
    // Any colour at all, through the system picker.
    const custom = document.createElement('label');
    custom.className = 'sp-swatch custom';
    custom.title = 'Custom colour';
    custom.innerHTML = '<input type="color" aria-label="Custom colour" />';
    const picker = custom.querySelector('input')!;
    picker.addEventListener('input', () => this.set({ color: picker.value.toUpperCase() }));
    this.els.swatches.append(custom);
    this.els.custom = custom;
    this.els.picker = picker;

    for (const d of DASHES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-dash';
      b.dataset.dash = d;
      b.setAttribute('role', 'radio');
      b.title = DASH_LABEL[d];
      b.setAttribute('aria-label', DASH_LABEL[d]);
      b.innerHTML = `<svg viewBox="0 0 40 10" aria-hidden="true"><line x1="3" y1="5" x2="37" y2="5" stroke-dasharray="${dashPattern(d, 1.6).join(' ')}"/></svg>`;
      b.addEventListener('click', () => this.set({ dash: d }));
      this.els.dashes.append(b);
    }

    const opacity = this.els.opacity as HTMLInputElement;
    const width = this.els.width as HTMLInputElement;
    opacity.addEventListener('input', () => this.set({ opacity: Number(opacity.value) }));
    width.addEventListener('input', () => this.set({ width: Number(width.value) }));
    q('[data-act="reset"]').addEventListener('click', () =>
      this.set({ opacity: undefined, width: undefined, dash: undefined }),
    );
    this.els.visible.addEventListener('click', () => {
      const it = this.item();
      if (it) this.set({ muted: !it.muted });
    });

    document.addEventListener('pointerdown', (e) => {
      if (this.id && !this.root.contains(e.target as Node) && e.target !== this.anchor && !this.anchor?.contains(e.target as Node)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.id) {
        this.close();
        this.anchor?.focus();
      }
    });
    window.addEventListener('resize', () => this.id && this.position());
    store.subscribe(() => this.id && this.sync());
  }

  open(id: string, anchor: HTMLElement): void {
    if (this.id === id && this.root.classList.contains('open')) return;
    this.id = id;
    this.anchor = anchor;
    this.sync();
    this.position();
    this.root.classList.add('open');
    (this.root.querySelector('.sp-swatch.on') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  close(): void {
    this.id = null;
    this.root.classList.remove('open');
  }

  private item(): Item | undefined {
    return this.store.doc.items.find((it) => it.id === this.id);
  }

  private set(patch: Partial<Item>): void {
    this.store.update(() => {
      const it = this.item();
      if (it) Object.assign(it, patch);
    });
  }

  private sync(): void {
    const it = this.item();
    if (!it) return this.close();
    const opacity = it.opacity ?? STYLE_DEFAULTS.opacity;
    const width = it.width ?? STYLE_DEFAULTS.width;
    const dash = it.dash ?? STYLE_DEFAULTS.dash;

    const path = this.els.path as unknown as SVGPathElement;
    path.style.stroke = it.color;
    path.style.strokeOpacity = String(opacity);
    path.style.strokeWidth = String(width);
    path.style.strokeDasharray = dashPattern(dash, width).join(' ');
    this.root.classList.toggle('hidden-graph', it.muted);

    let matched = false;
    for (const b of this.els.swatches.querySelectorAll<HTMLElement>('.sp-swatch[data-color]')) {
      const on = b.dataset.color!.toLowerCase() === it.color.toLowerCase();
      matched ||= on;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.els.custom.classList.toggle('on', !matched);
    this.els.custom.style.setProperty('--c', matched ? 'transparent' : it.color);
    (this.els.picker as HTMLInputElement).value = it.color.length === 7 ? it.color : '#000000';

    for (const b of this.els.dashes.querySelectorAll<HTMLElement>('.sp-dash')) {
      const on = b.dataset.dash === dash;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }

    const o = this.els.opacity as HTMLInputElement;
    const w = this.els.width as HTMLInputElement;
    o.value = String(opacity);
    w.value = String(width);
    for (const r of [o, w]) {
      const min = Number(r.min);
      r.style.setProperty('--fill', `${((Number(r.value) - min) / (Number(r.max) - min)) * 100}%`);
    }
    this.els.opacityOut.textContent = `${Math.round(opacity * 100)}%`;
    this.els.widthOut.textContent = `${width} px`;
    this.els.visible.textContent = it.muted ? 'Show graph' : 'Hide graph';
  }

  /** Beside the icon, flipping or sliding to stay inside the viewport. */
  private position(): void {
    if (!this.anchor) return;
    const a = this.anchor.getBoundingClientRect();
    const w = this.root.offsetWidth || 272;
    const h = this.root.offsetHeight || 330;
    const margin = 12;
    let left = a.right + 10;
    let top = a.top - 10;
    if (left + w > innerWidth - margin) left = Math.max(margin, a.left - w - 10);
    if (left < margin) {
      // Narrow screens: sit below the icon instead.
      left = Math.max(margin, Math.min(innerWidth - w - margin, a.left));
      top = a.bottom + 10;
    }
    top = Math.max(margin, Math.min(innerHeight - h - margin, top));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }
}
