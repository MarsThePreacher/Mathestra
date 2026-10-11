// "My graphs": a drawer listing the pieces saved to your account.

import { deleteGraph, listGraphs, type GraphRow, type User } from '../lib/supabase';
import { decodeDoc } from '../state';
import { drawMini, tracesOf } from './miniWave';

export interface LibraryOptions {
  onOpen: (row: GraphRow) => void;
  onNew: () => void;
  onSignIn: () => void;
  currentId: () => string | null;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Infinity],
  ];
  let v = s;
  for (const [unit, size] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return '';
}

export class Library {
  private drawer: HTMLElement;
  private scrim: HTMLElement;
  private body: HTMLElement;
  private toggle: HTMLButtonElement;
  private user: User | null = null;
  private rows: GraphRow[] = [];
  private loaded = false;

  constructor(private opts: LibraryOptions) {
    const $ = (id: string) => document.getElementById(id)!;
    this.drawer = $('drawer');
    this.scrim = $('drawer-scrim');
    this.body = $('drawer-body');
    this.toggle = $('graphs-btn') as HTMLButtonElement;
    this.toggle.addEventListener('click', () => (this.isOpen() ? this.close() : this.open()));
    $('drawer-close').addEventListener('click', () => this.close());
    this.scrim.addEventListener('click', () => this.close());
    $('drawer-new').addEventListener('click', () => {
      this.opts.onNew();
      this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });
  }

  isOpen(): boolean {
    return this.drawer.classList.contains('open');
  }

  open(): void {
    this.drawer.classList.add('open');
    this.scrim.classList.add('open');
    this.drawer.inert = false;
    this.toggle.setAttribute('aria-expanded', 'true');
    void this.refresh();
    (this.drawer.querySelector('#drawer-new') as HTMLElement).focus();
  }

  close(): void {
    this.drawer.classList.remove('open');
    this.scrim.classList.remove('open');
    this.drawer.inert = true;
    this.toggle.setAttribute('aria-expanded', 'false');
  }

  setUser(user: User | null): void {
    const changed = user?.id !== this.user?.id;
    this.user = user;
    if (changed) {
      this.rows = [];
      this.loaded = false;
      if (this.isOpen()) void this.refresh();
    }
  }

  /** Re-fetch the list (after a save, or when the drawer opens). */
  async refresh(): Promise<void> {
    if (!this.user) return this.renderSignedOut();
    if (!this.loaded) this.renderMessage('Loading…');
    try {
      this.rows = await listGraphs();
      this.loaded = true;
      this.renderList();
    } catch (e) {
      this.renderMessage((e as Error).message);
    }
  }

  private renderSignedOut(): void {
    this.body.replaceChildren();
    const p = document.createElement('div');
    p.className = 'drawer-empty';
    p.innerHTML = '<p>Sign in to keep graphs in your account and open them on any device.</p>';
    const b = document.createElement('button');
    b.className = 'btn solid';
    b.type = 'button';
    b.textContent = 'Sign in';
    b.addEventListener('click', () => this.opts.onSignIn());
    p.append(b);
    this.body.append(p);
  }

  private renderMessage(text: string): void {
    const p = document.createElement('div');
    p.className = 'drawer-empty';
    const t = document.createElement('p');
    t.textContent = text;
    p.append(t);
    this.body.replaceChildren(p);
  }

  private renderList(): void {
    if (this.rows.length === 0) {
      return this.renderMessage('No saved graphs yet. Use Save to keep the one you are working on.');
    }
    const list = document.createElement('ul');
    list.className = 'lib-list';
    const current = this.opts.currentId();
    for (const row of this.rows) list.append(this.renderItem(row, row.id === current));
    this.body.replaceChildren(list);
    // Thumbnails after layout, so canvases have a size.
    requestAnimationFrame(() => {
      list.querySelectorAll<HTMLCanvasElement>('canvas[data-id]').forEach((c) => {
        const row = this.rows.find((r) => r.id === c.dataset.id);
        if (row) void this.thumb(c, row);
      });
    });
  }

  private renderItem(row: GraphRow, current: boolean): HTMLElement {
    const li = document.createElement('li');
    li.className = `lib-item${current ? ' current' : ''}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'lib-open';
    open.innerHTML = '<canvas aria-hidden="true"></canvas><span class="lib-text"><b></b><span></span></span>';
    open.querySelector('canvas')!.dataset.id = row.id;
    open.querySelector('b')!.textContent = row.title || 'Untitled';
    open.querySelector('.lib-text span')!.textContent = current ? 'Open now' : `Edited ${ago(row.updated_at)}`;
    open.addEventListener('click', () => {
      this.opts.onOpen(row);
      this.close();
    });

    // Delete asks once more, in place, instead of a blocking dialog.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'lib-delete';
    del.setAttribute('aria-label', `Delete ${row.title || 'Untitled'}`);
    const trash =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6" /></svg>';
    del.innerHTML = trash;
    let armed = 0;
    del.addEventListener('click', async () => {
      if (!armed) {
        del.classList.add('armed');
        del.textContent = 'Delete';
        armed = window.setTimeout(() => {
          armed = 0;
          del.classList.remove('armed');
          del.innerHTML = trash;
        }, 3000);
        return;
      }
      clearTimeout(armed);
      del.disabled = true;
      try {
        await deleteGraph(row.id);
        li.classList.add('removing');
        setTimeout(() => {
          this.rows = this.rows.filter((r) => r.id !== row.id);
          this.renderList();
        }, 180);
      } catch (e) {
        del.disabled = false;
        this.renderMessage((e as Error).message);
      }
    });
    li.append(open, del);
    return li;
  }

  private async thumb(canvas: HTMLCanvasElement, row: GraphRow): Promise<void> {
    try {
      const doc = await decodeDoc(row.data);
      const span = doc.loop > 0 ? Math.min(doc.loop, 4) : 2;
      drawMini(canvas, tracesOf(doc), { x0: 0, x1: span, y0: -1.15, y1: 1.15 }, { lineWidth: 1 });
    } catch {
      // an unreadable entry just has no picture
    }
  }
}
