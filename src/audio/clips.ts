// Imported audio: from a file to samples an equation can read.
//
// A clip's bytes are kept in the browser (IndexedDB), keyed by a hash of the file,
// so it survives refreshes. Signed-in users also upload it to Supabase Storage,
// which lets saved graphs and shared links play it on any device.

import type { Sample } from '../math/compiler';
import { supabase } from '../lib/supabase';
import type { AudioRef } from '../state';

export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_SECONDS = 180;
/** Every clip is resampled to this rate, so timing is identical on every device. */
const RATE = 48000;

export type ClipStatus = 'loading' | 'ready' | 'missing' | 'error';

interface Entry {
  status: ClipStatus;
  sample?: Sample;
  /** Downsampled min/max pairs for drawing the clip's waveform quickly. */
  peaks?: Float32Array;
  error?: string;
}

// ---------- IndexedDB: the original file bytes, by content hash ----------

interface Stored {
  bytes: ArrayBuffer;
  type: string;
  name: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('mathestra', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('audio');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const store = (await db()).transaction('audio', mode).objectStore('audio');
  return new Promise((resolve, reject) => {
    const req = run(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

const putLocal = (key: string, value: Stored) => idb<IDBValidKey>('readwrite', (s) => s.put(value, key)).catch(() => {});
const getLocal = (key: string) => idb<Stored | undefined>('readonly', (s) => s.get(key)).catch(() => undefined);

// ---------- decoding ----------

async function hashOf(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode any browser-supported format to mono samples at RATE. */
async function decode(bytes: ArrayBuffer): Promise<Sample> {
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const buffer = await ctx.decodeAudioData(bytes.slice(0));
  if (buffer.duration > MAX_SECONDS + 0.5) {
    throw new Error(`Clips can be up to ${MAX_SECONDS / 60} minutes long; this one is ${formatDuration(buffer.duration)}.`);
  }
  const data = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] += ch[i] / buffer.numberOfChannels;
  }
  return { data, rate: buffer.sampleRate };
}

function peaksOf(sample: Sample, buckets = 600): Float32Array {
  const out = new Float32Array(buckets * 2);
  const per = Math.max(1, Math.floor(sample.data.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let mn = 0;
    let mx = 0;
    const end = Math.min(sample.data.length, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      const v = sample.data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out[b * 2] = mn;
    out[b * 2 + 1] = mx;
  }
  return out;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)} s`;
}

function extensionOf(file: string, type: string): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(file)?.[1];
  if (fromName) return fromName.toLowerCase();
  return type.split('/')[1]?.replace('mpeg', 'mp3').replace('x-', '') || 'audio';
}

// ---------- the clip library ----------

export class Clips {
  private entries = new Map<string, Entry>();
  /** Called whenever a clip finishes loading or fails, so the page can rebuild. */
  onChange: () => void = () => {};

  status(key: string): Entry {
    return this.entries.get(key) ?? { status: 'loading' };
  }

  /** Samples for every ready clip, by function name. */
  samplesFor(refs: AudioRef[]): Record<string, Sample> {
    const out: Record<string, Sample> = {};
    for (const r of refs) {
      const s = this.entries.get(r.key)?.sample;
      if (s) out[r.name] = s;
    }
    return out;
  }

  /** Validate, store and decode a file the user picked. */
  async importFile(file: File): Promise<{ ref: Omit<AudioRef, 'name'>; bytes: ArrayBuffer; type: string }> {
    if (file.size > MAX_BYTES) throw new Error(`Audio files can be up to 25 MB; ${file.name} is ${(file.size / 1048576).toFixed(1)} MB.`);
    if (file.type && !file.type.startsWith('audio/') && !file.type.startsWith('video/'))
      throw new Error(`${file.name} is not an audio file.`);
    const bytes = await file.arrayBuffer();
    const key = await hashOf(bytes);
    let sample: Sample;
    try {
      sample = await decode(bytes);
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(msg.startsWith('Clips can be') ? msg : `${file.name} could not be read as audio.`);
    }
    const type = file.type || 'audio/mpeg';
    await putLocal(key, { bytes, type, name: file.name });
    this.entries.set(key, { status: 'ready', sample, peaks: peaksOf(sample) });
    return { ref: { key, file: file.name, duration: sample.data.length / sample.rate }, bytes, type };
  }

  /** Make sure a clip referenced by a document is loaded: from this device, or from its upload. */
  async ensure(ref: AudioRef): Promise<void> {
    const known = this.entries.get(ref.key);
    if (known && known.status !== 'missing') return;
    this.entries.set(ref.key, { status: 'loading' });
    try {
      let stored = await getLocal(ref.key);
      if (!stored && ref.url) {
        const res = await fetch(ref.url);
        if (!res.ok) throw new Error('missing');
        stored = { bytes: await res.arrayBuffer(), type: res.headers.get('content-type') ?? 'audio/mpeg', name: ref.file };
        await putLocal(ref.key, stored);
      }
      if (!stored) {
        this.entries.set(ref.key, { status: 'missing' });
      } else {
        const sample = await decode(stored.bytes);
        this.entries.set(ref.key, { status: 'ready', sample, peaks: peaksOf(sample) });
      }
    } catch (e) {
      this.entries.set(ref.key, { status: (e as Error).message === 'missing' ? 'missing' : 'error' });
    }
    this.onChange();
  }

  /** Upload a clip to the signed-in user's folder; returns its public address. */
  async upload(ref: AudioRef, userId: string): Promise<string> {
    if (!supabase) throw new Error('Accounts are not set up on this site.');
    const stored = await getLocal(ref.key);
    if (!stored) throw new Error(`${ref.file} is not on this device, so it cannot be uploaded.`);
    const path = `${userId}/${ref.key}.${extensionOf(ref.file, stored.type)}`;
    const { error } = await supabase.storage
      .from('audio')
      .upload(path, new Blob([stored.bytes], { type: stored.type }), { upsert: true, contentType: stored.type, cacheControl: '31536000' });
    if (error) {
      if (/bucket not found/i.test(error.message)) {
        console.warn('Mathestra: the "audio" storage bucket is missing. Run supabase/storage.sql in Supabase.');
        throw new Error('Online storage for audio is not available yet. The clip stays on this device.');
      }
      throw new Error(error.message);
    }
    return supabase.storage.from('audio').getPublicUrl(path).data.publicUrl;
  }

  /** Draw the clip's waveform into a canvas, in the current ink colour. */
  draw(canvas: HTMLCanvasElement, key: string, color: string): void {
    const peaks = this.entries.get(key)?.peaks;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!peaks) return;
    const n = peaks.length / 2;
    const mid = h / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const b = Math.min(n - 1, Math.floor((x / w) * n));
      const mn = peaks[b * 2];
      const mx = peaks[b * 2 + 1];
      const top = mid - mx * mid * 0.95;
      const bottom = mid - mn * mid * 0.95;
      ctx.rect(x, top, 1, Math.max(1 / dpr, bottom - top));
    }
    ctx.fill();
  }
}
