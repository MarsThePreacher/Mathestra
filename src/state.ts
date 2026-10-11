// The document: everything needed to reproduce a piece, small enough to live in a URL.

export interface Item {
  id: string;
  text: string;
  color: string;
  /** Hidden from the graph and silent. (Named `muted` for link compatibility.) */
  muted: boolean;
  solo: boolean;
  volume: number;
  /** How the trace is drawn. Absent means the defaults below. */
  opacity?: number;
  width?: number;
  dash?: Dash;
  /** Set on audio lines: an imported recording, usable in equations as name(t). */
  audio?: AudioRef;
  /** Slider range, frozen when the slider first appears so it doesn't jump while dragging. */
  min?: number;
  max?: number;
  step?: number;
}

/** An imported audio file. The bytes live in the browser (IndexedDB) and, once uploaded, in storage. */
export interface AudioRef {
  /** The function name in equations, e.g. drums for drums(t). */
  name: string;
  /** Content hash of the file; identifies it in local storage and in the bucket. */
  key: string;
  /** Original file name, for display. */
  file: string;
  /** Length in seconds. */
  duration: number;
  /** Public address once uploaded, so shared links and saved graphs can load it anywhere. */
  url?: string;
}

export type Dash = 'solid' | 'dashed' | 'dotted';
export const DASHES: Dash[] = ['solid', 'dashed', 'dotted'];
export const STYLE_DEFAULTS = { opacity: 1, width: 1.25, dash: 'solid' as Dash };

export interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Doc {
  title: string;
  items: Item[];
  master: number;
  /** Loop length in seconds; 0 = play forever. */
  loop: number;
  view: View;
  /** Who may edit this graph when it is opened from a link (see Author). */
  author?: Author;
}

/**
 * The owner of a graph, carried inside its links. `d` is a random key for the browser
 * that made it; `u` is a one-way hash of the owner's account, so links never reveal the
 * account itself. Anyone else opening the link sees it read-only.
 */
export interface Author {
  d?: string;
  u?: string;
}

// Trace colours, tuned to stay vivid and legible on both the white and the black screen.
export const COLORS = ['#2F6BFF', '#0FA37F', '#E5484D', '#F08C00', '#7C4DFF', '#0096C7', '#D6409F', '#5E9E0F'];

let idCounter = 0;
export const newId = () => `${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function makeItem(text: string, index: number): Item {
  return { id: newId(), text, color: COLORS[index % COLORS.length], muted: false, solo: false, volume: 1 };
}

export const DEFAULT_VIEW: View = { x0: 0, x1: 0.02, y0: -1.25, y1: 1.25 };

/** Lines that will become tracks get the palette in order; definitions and notes don't use it up. */
export const looksLikeTrack = (text: string) => /^\s*y\s*=/.test(text);

export function makeDoc(title: string, lines: string[], extra: Partial<Doc> = {}): Doc {
  let track = 0;
  return {
    title,
    items: lines.map((text) => makeItem(text, looksLikeTrack(text) ? track++ : 0)),
    master: 0.5,
    loop: 0,
    view: { ...DEFAULT_VIEW },
    ...extra,
  };
}

export class Store {
  private listeners = new Set<(doc: Doc) => void>();

  constructor(public doc: Doc) {}

  subscribe(fn: (doc: Doc) => void): void {
    this.listeners.add(fn);
  }

  /** Mutate the doc in place, then notify. */
  update(fn: (doc: Doc) => void): void {
    fn(this.doc);
    for (const l of this.listeners) l(this.doc);
  }

  /** Swap in a whole new document; nothing from the old one (such as its owner) carries over. */
  replace(doc: Doc): void {
    this.update((d) => {
      for (const key of Object.keys(d) as (keyof Doc)[]) delete d[key];
      Object.assign(d, doc);
    });
  }
}

// ---------- sharing: JSON → deflate → base64url in the URL hash ----------

/** name, key, file, duration, url */
type PackedAudio = [string, string, string, number, string | null];

interface Packed {
  v: 1;
  t: string;
  m: number;
  l: number;
  w: [number, number, number, number];
  /** [text, color, flags, volume, min?, max?, step?, opacity?, width?, dash?, audio?]; null fills gaps */
  i: (string | (string | number | null | PackedAudio)[])[];
  a?: Author;
}

function pack(doc: Doc): Packed {
  return {
    ...(doc.author ? { a: doc.author } : {}),
    v: 1,
    t: doc.title,
    m: doc.master,
    l: doc.loop,
    w: [doc.view.x0, doc.view.x1, doc.view.y0, doc.view.y1],
    i: doc.items.map((it) => {
      const flags = (it.muted ? 1 : 0) | (it.solo ? 2 : 0);
      const row: (string | number | null | PackedAudio)[] = [it.text, it.color, flags, it.volume];
      if (it.min !== undefined) row.push(it.min, it.max!, it.step!);
      if (it.opacity !== undefined || it.width !== undefined || it.dash !== undefined) {
        while (row.length < 7) row.push(null);
        row.push(
          it.opacity ?? STYLE_DEFAULTS.opacity,
          it.width ?? STYLE_DEFAULTS.width,
          DASHES.indexOf(it.dash ?? STYLE_DEFAULTS.dash),
        );
      }
      if (it.audio) {
        while (row.length < 10) row.push(null);
        const a = it.audio;
        row.push([a.name, a.key, a.file, a.duration, a.url ?? null]);
      }
      return row;
    }),
  };
}

function unpack(p: Packed): Doc {
  return {
    ...(p.a ? { author: { ...(p.a.d ? { d: p.a.d } : {}), ...(p.a.u ? { u: p.a.u } : {}) } } : {}),
    title: p.t ?? 'Untitled',
    master: p.m ?? 0.5,
    loop: p.l ?? 0,
    view: p.w ? { x0: p.w[0], x1: p.w[1], y0: p.w[2], y1: p.w[3] } : { ...DEFAULT_VIEW },
    items: p.i.map((raw, index) => {
      if (typeof raw === 'string') return makeItem(raw, index);
      const [text, color, flags, volume, min, max, step, opacity, width, dash, audio] = raw as [
        string, string, number, number, number | null, number | null, number | null, number?, number?, number?, PackedAudio?,
      ];
      const item: Item = { id: newId(), text, color, muted: !!(flags & 1), solo: !!(flags & 2), volume };
      if (min != null) Object.assign(item, { min, max, step });
      if (opacity != null) Object.assign(item, { opacity, width, dash: DASHES[dash ?? 0] ?? 'solid' });
      if (audio) {
        const [name, key, file, duration, url] = audio;
        item.audio = { name, key, file, duration, ...(url ? { url } : {}) };
      }
      return item;
    }),
  };
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function encodeDoc(doc: Doc): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(pack(doc)));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeDoc(encoded: string): Promise<Doc> {
  const json = await pipe(fromBase64Url(encoded), new DecompressionStream('deflate-raw'));
  return unpack(JSON.parse(new TextDecoder().decode(json)));
}

const STORAGE_KEY = 'mathestra:doc';

export function saveLocal(encoded: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, encoded);
  } catch {
    // storage may be unavailable (private mode); the URL still holds the doc
  }
}

export function loadLocal(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
