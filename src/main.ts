import './style.css';
import { AudioEngine } from './audio/engine';
import { Clips } from './audio/clips';
import { compile, instantiate, type Instance, type Program } from './math/compiler';
import { PRESETS } from './presets';
import { decodeDoc, encodeDoc, loadLocal, makeItem, saveLocal, Store, STYLE_DEFAULTS, type AudioRef, type Author, type Doc } from './state';
import { formatTime, Graph } from './ui/graph';
import { Keypad } from './ui/keypad';
import { Panel, setFill, trim } from './ui/panel';
import { StylePopover } from './ui/stylePopover';
import { trackViewport } from './ui/viewport';
import { AccountControl } from './ui/account';
import { AuthDialog } from './ui/authDialog';
import { Library } from './ui/library';
import {
  createGraph,
  currentUser,
  getGraph,
  onAuthChange,
  updateGraph,
  type GraphRow,
  type User,
} from './lib/supabase';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const blankDoc = () => PRESETS.find((p) => p.name === 'Blank')!.make();
const isBlank = (doc: Doc) => doc.items.every((it) => !it.audio && it.text.trim() === '');

/** The piece from the last visit, kept aside so a fresh blank graph can offer it back. */
let previousSession: Doc | null = null;

/**
 * What to open. A link that carries a piece (share links, and the address after any
 * edit, so refreshing keeps your work) opens that piece. Otherwise, like Desmos,
 * the calculator starts with a blank graph.
 */
/**
 * A published piece, opened by a short link such as /app/?p=90210. Its data lives in
 * /p/<name>.txt (too large to travel inside a link), encoded exactly like a share link.
 */
const publishedId = (() => {
  const id = new URLSearchParams(location.search).get('p');
  return id && /^[a-z0-9-]{1,64}$/i.test(id) ? id : null;
})();

let publishedFailed = false;

async function initialDoc(): Promise<Doc> {
  if (publishedId && !location.hash) {
    try {
      const res = await fetch(`/p/${publishedId}.txt`);
      if (res.ok) {
        const doc = await decodeDoc((await res.text()).trim());
        publishedLoaded = true;
        return doc;
      }
      if (res.status === 404) {
        // The piece was removed or never existed: say so, rather than open a blank graph.
        location.replace('/404.html');
        return new Promise<Doc>(() => {}); // the page is leaving
      }
    } catch {
      // network trouble or damaged data: fall through to a blank graph, with a notice
    }
    publishedFailed = true;
  }
  const fromHash = location.hash.slice(1);
  if (fromHash) {
    try {
      return await decodeDoc(fromHash);
    } catch {
      // a damaged link; fall through to a blank graph
    }
  }
  const local = loadLocal();
  if (local) {
    try {
      const doc = await decodeDoc(local);
      // An untouched example is not the person's work (older visits saved those too).
      const linesOf = (d: Doc) => JSON.stringify([d.title, ...d.items.map((it) => it.text)]);
      const isExample = PRESETS.some((p) => linesOf(p.make()) === linesOf(doc));
      if (!isBlank(doc) && !isExample) previousSession = doc;
    } catch {
      // unreadable leftovers are simply ignored
    }
  }
  return { ...blankDoc(), author: me() };
}

// ---------- who is this? (decides who may edit a graph opened from a link) ----------

/** A random key for this browser, kept on the device. */
const deviceKey = (() => {
  try {
    let key = localStorage.getItem('mathestra:device');
    if (!key) {
      key = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      localStorage.setItem('mathestra:device', key);
    }
    return key;
  } catch {
    return 'ephemeral-' + Math.random().toString(36).slice(2, 10);
  }
})();

/** A one-way hash of the signed-in account, so links never contain the account itself. */
let accountKey: string | null = null;
async function hashAccount(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mathestra:${id}`));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
{
  const u = await currentUser();
  accountKey = u ? await hashAccount(u.id) : null;
}

/** The owner stamp for graphs made here. */
function me(): Author {
  return accountKey ? { d: deviceKey, u: accountKey } : { d: deviceKey };
}

/** Graphs without an owner (from before ownership existed) stay editable by anyone. */
function isMine(doc: Doc): boolean {
  const a = doc.author;
  return !a || a.d === deviceKey || (!!accountKey && a.u === accountKey);
}

/** Opened from a published short link (/app/?p=…): read-only until copied. */
let publishedLoaded = false;

const startedBlank = !location.hash.slice(1) && !publishedId;
const store = new Store(await initialDoc());

/**
 * Has the person changed this piece themselves? Opening an example, a link or a saved
 * graph does not count, so only their own work is kept on the device for "Restore".
 */
let userEdited = false;
let applyingDoc = false;
store.subscribe(() => {
  if (applyingDoc) return;
  userEdited = true;
  // An unowned graph (from an older link) becomes the editor's own on first change.
  if (!store.doc.author) store.doc.author = me();
});

/** Put a whole document on screen (an example, a link, a saved graph, a restore). */
function loadDoc(doc: Doc, edited = false): void {
  applyingDoc = true;
  publishedLoaded = false;
  try {
    store.replace(doc);
  } finally {
    applyingDoc = false;
  }
  userEdited = edited;
  applyViewOnly();
}

// ---------- view only: other people's graphs can be played, not changed ----------

let viewOnly = false;

function applyViewOnly(): void {
  viewOnly = publishedLoaded || !isMine(store.doc);
  document.documentElement.classList.toggle('view-only', viewOnly);
  panel.setReadOnly(viewOnly);
  const title = document.getElementById('title') as HTMLInputElement | null;
  if (title) title.readOnly = viewOnly;
  const banner = document.getElementById('view-banner');
  if (banner) banner.hidden = !viewOnly;
  if (viewOnly) {
    if (document.getElementById('keypad-wrap')?.classList.contains('open')) setKeypad(false);
    stylePopover.close();
  }
  if (typeof syncSaveUi === 'function') syncSaveUi();
}

/** Someone else's graph, duplicated as the viewer's own: editable, and never linked to the original. */
function makeCopy(): void {
  history.pushState(null, '', location.href);
  const copy = JSON.parse(JSON.stringify(store.doc)) as Doc;
  copy.author = me();
  copy.title = `${copy.title || 'Untitled'} (copy)`;
  detachCloud();
  const url = new URL(location.href);
  url.searchParams.delete('p');
  history.replaceState(null, '', url);
  loadDoc(copy, true);
  viewChanged();
  toast('This copy is yours to edit');
}

/** Tell a viewer why an editing action did nothing. */
function viewOnlyNotice(): void {
  toast('This graph is view only. Make a copy to change it.', { label: 'Make a copy', run: makeCopy }, 5000);
}
const engine = new AudioEngine();
const panel = new Panel($('list'), store);
const clips = new Clips();
panel.clips = clips;
clips.onChange = () => rebuild();
const stylePopover = new StylePopover(store);
panel.onStyleRequest = (id, anchor) => stylePopover.open(id, anchor);
const scaleEl = $('scale');
const graph = new Graph($<HTMLCanvasElement>('graph'), {
  getView: () => store.doc.view,
  setView: (v) => {
    // View changes skip the store's listeners: no need to recompile while panning.
    store.doc.view = v;
    viewChanged();
  },
  onSeek: (t) => {
    engine.seek(t);
    graph.setPlayhead(t);
    updateTime(t);
  },
  onScale: (s) => {
    const text = `${formatTime(s, s)} / div`;
    if (scaleEl.textContent !== text) scaleEl.textContent = text;
  },
});

let program: Program;
let instance: Instance | null = null;

let samplesSignature = '';

function rebuild(): void {
  const doc = store.doc;
  const refs = doc.items.flatMap((it) => (it.audio ? [it.audio] : []));
  refs.forEach((r) => void clips.ensure(r)); // loads anything new; rebuilds again when ready
  const samples = clips.samplesFor(refs);
  const signature = Object.entries(samples).map(([n, s]) => `${n}:${s.data.length}`).join();
  if (signature !== samplesSignature) {
    samplesSignature = signature;
    engine.setSamples(samples);
  }
  program = compile(
    doc.items.map((it) => (it.audio ? '' : it.text)),
    refs.map((r) => r.name),
  );
  try {
    instance = instantiate(program.source, program.vars, samples);
  } catch (e) {
    instance = null;
    toast(`This piece could not be built: ${(e as Error).message}`);
  }

  // Tracks in the order the program returns them.
  const tracks = doc.items
    .map((item, i) => ({ item, line: program.lines[i] }))
    .filter(({ line }) => line.trackIndex !== undefined)
    .sort((a, b) => a.line.trackIndex! - b.line.trackIndex!);

  const soloing = tracks.some(({ item }) => item.solo);
  const gains: Record<string, number> = {};
  for (const { item } of tracks) gains[item.id] = item.muted || (soloing && !item.solo) ? 0 : item.volume;

  engine.setProgram(
    program.source,
    tracks.map(({ item }) => item.id),
    program.vars,
  );
  engine.setGains(gains);
  engine.setMaster(doc.master);
  engine.setLoop(doc.loop);

  graph.setCurves(
    instance
      ? tracks
          // Hidden graphs are gone entirely; soloed-out ones stay as faint ghosts.
          .filter(({ item }) => !item.muted)
          .map(({ item, line }) => ({
            fn: instance!.tracks[line.trackIndex!],
            color: item.color,
            opacity: item.opacity ?? STYLE_DEFAULTS.opacity,
            width: item.width ?? STYLE_DEFAULTS.width,
            dash: item.dash ?? STYLE_DEFAULTS.dash,
            dim: gains[item.id] === 0,
          }))
      : [],
  );
  $('hint').hidden = tracks.length > 0;
  panel.render(program, instance);
  syncDeck();
  schedulePersist();
}

store.subscribe(rebuild);

// ---------- title, loop, volume ----------

const titleInput = $<HTMLInputElement>('title');
const loopOn = $<HTMLInputElement>('loop-on');
const loopLen = $<HTMLInputElement>('loop-len');
const master = $<HTMLInputElement>('master');
let lastLoop = 4;

function syncDeck(): void {
  const doc = store.doc;
  if (document.activeElement !== titleInput) titleInput.value = doc.title;
  document.title = `${doc.title || 'Untitled'} · Mathestra`;
  loopOn.checked = doc.loop > 0;
  if (doc.loop > 0) lastLoop = doc.loop;
  if (document.activeElement !== loopLen) loopLen.value = trim(lastLoop);
  loopLen.parentElement!.classList.toggle('off', doc.loop === 0);
  master.value = String(doc.master);
  setFill(master);
}

titleInput.addEventListener('input', () => store.update((d) => (d.title = titleInput.value)));
titleInput.addEventListener('keydown', (e) => e.key === 'Enter' && titleInput.blur());
loopOn.addEventListener('change', () => store.update((d) => (d.loop = loopOn.checked ? lastLoop : 0)));
loopLen.addEventListener('change', () => {
  const v = Number(loopLen.value);
  if (!(v > 0)) return void syncDeck();
  lastLoop = v;
  store.update((d) => (d.loop = v));
});
master.addEventListener('input', () => store.update((d) => (d.master = Number(master.value))));

// ---------- examples menu ----------

const examplesBtn = $<HTMLButtonElement>('examples-btn');
const examplesPop = $('examples-pop');

PRESETS.forEach((p) => {
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.setAttribute('role', 'menuitem');
  item.innerHTML = '<b></b><span></span>';
  item.querySelector('b')!.textContent = p.name;
  item.querySelector('span:last-child')!.textContent = p.description;
  item.addEventListener('click', () => {
    setMenu(false);
    openPreset(p);
  });
  examplesPop.append(item);
});

function openPreset(p: (typeof PRESETS)[number]): void {
  // Keep the current piece in browser history so Back brings it back.
  history.pushState(null, '', location.href);
  engine.seek(0);
  graph.setPlayhead(0);
  updateTime(0);
  detachCloud();
  loadDoc({ ...p.make(), author: me() });
  viewChanged();
  toast(`${p.name} loaded`);
}

function setMenu(open: boolean): void {
  examplesPop.classList.toggle('open', open);
  examplesBtn.setAttribute('aria-expanded', String(open));
  if (open) (examplesPop.firstElementChild as HTMLElement)?.focus();
}

examplesBtn.addEventListener('click', () => setMenu(!examplesPop.classList.contains('open')));
document.addEventListener('pointerdown', (e) => {
  if (!$('examples').contains(e.target as Node)) setMenu(false);
});
examplesPop.addEventListener('keydown', (e) => {
  const items = [...examplesPop.children] as HTMLElement[];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
  else if (e.key === 'Escape') {
    setMenu(false);
    examplesBtn.focus();
  } else return;
  e.preventDefault();
});

// ---------- theme ----------

function effectiveTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeChrome(): void {
  // A manual theme overrides the system one, so every theme-color tag follows it.
  const color = effectiveTheme() === 'dark' ? '#111111' : '#efefef';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color));
  graph.readPalette();
}

$('theme-btn').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('mathestra:theme', next);
  } catch {
    // ignore
  }
  applyThemeChrome();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyThemeChrome);
applyThemeChrome();

// ---------- guide ----------

const help = $<HTMLDialogElement>('help');
$('help-btn').addEventListener('click', () => help.showModal());
$('help-close').addEventListener('click', () => help.close());
help.addEventListener('click', (e) => {
  if (e.target === help) help.close(); // click on the backdrop
});

// ---------- transport ----------

const playBtn = $<HTMLButtonElement>('play');

async function togglePlay(): Promise<void> {
  if (engine.playing) engine.pause();
  else await engine.play();
  playBtn.classList.toggle('playing', engine.playing);
  playBtn.setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
  playBtn.title = engine.playing ? 'Pause (Space)' : 'Play (Space)';
}

playBtn.addEventListener('click', () => void togglePlay());
$('stop').addEventListener('click', () => {
  engine.seek(0);
  graph.setPlayhead(0);
  updateTime(0);
  if (follow.checked) setViewStart(0);
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const typing =
    target.isContentEditable ||
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !(target as HTMLInputElement).type?.match(/checkbox|range/));
  if (e.code === 'Space' && !typing && !help.open) {
    e.preventDefault();
    void togglePlay();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (viewOnly) return viewOnlyNotice();
    void saveToCloud();
  }
});

$('share').addEventListener('click', async () => {
  await persist();
  // The share link carries the piece itself; the private ?g= id stays out of it.
  // An unedited published piece is shared by its short address.
  const link =
    publishedId && !userEdited
      ? `${location.origin}${location.pathname}?p=${publishedId}`
      : `${location.origin}${location.pathname}${location.hash}`;
  const localOnly = store.doc.items.some((it) => it.audio && !it.audio.url);
  try {
    await navigator.clipboard.writeText(link);
    toast(localOnly ? 'Link copied. Audio clips play only on this device until you sign in and save.' : 'Link copied', undefined, localOnly ? 5000 : 2600);
  } catch {
    toast('Copying failed. Copy the address bar instead');
  }
});

$('add').addEventListener('click', () => (viewOnly ? viewOnlyNotice() : panel.focus(panel.insertAfter(null, ''))));

// ---------- audio clips ----------

const audioInput = $<HTMLInputElement>('audio-input');
$('audio-btn').addEventListener('click', () => audioInput.click());
audioInput.addEventListener('change', () => {
  const files = [...(audioInput.files ?? [])];
  audioInput.value = '';
  void importAudio(files);
});

/** A function name from a file name: "Drum Loop 120.wav" becomes drumloop. */
function clipName(file: string): string {
  const base = file.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12) || 'clip';
  const taken = panel.takenNames();
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

async function importAudio(files: File[]): Promise<void> {
  if (viewOnly) return viewOnlyNotice();
  for (const file of files) {
    toast(`Reading ${file.name}…`, undefined, 10000);
    try {
      const { ref } = await clips.importFile(file);
      const audio: AudioRef = { ...ref, name: clipName(file.name) };
      const clipItem = makeItem('', store.doc.items.length);
      clipItem.audio = audio;
      // Play it straight away: a track that reads the clip from the start.
      const track = panel.insertAfter(null, `y = ${audio.name}(x)`);
      store.update((d) => {
        const at = d.items.findIndex((it) => it.id === track);
        // An empty last line is replaced rather than left dangling above the clip.
        const before = d.items[at - 1];
        if (before && !before.audio && before.text.trim() === '') d.items.splice(at - 1, 1);
        d.items.splice(d.items.findIndex((it) => it.id === track), 0, clipItem);
      });
      toast(`${file.name} added as ${audio.name}(t)`);
      if (user) void uploadClip(audio);
    } catch (e) {
      toast((e as Error).message, undefined, 6000);
    }
  }
}

/** Upload one clip to the signed-in user's storage, so links and saved graphs can play it. */
async function uploadClip(audio: AudioRef): Promise<boolean> {
  if (!user || audio.url) return !!audio.url;
  try {
    const url = await clips.upload(audio, user.id);
    store.update(() => {
      for (const it of store.doc.items) if (it.audio?.key === audio.key) it.audio.url = url;
    });
    return true;
  } catch (e) {
    toast((e as Error).message, undefined, 6000);
    return false;
  }
}

async function uploadPendingClips(): Promise<void> {
  for (const it of store.doc.items) if (it.audio && !it.audio.url) await uploadClip(it.audio);
}

// Drop audio files anywhere on the calculator.
const dropZone = $('drop-zone');
let dragDepth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  dropZone.classList.add('show');
});
addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropZone.classList.remove('show');
  }
});
addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('show');
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|webm|aiff?)$/i.test(f.name));
  if (files.length) void importAudio(files);
  else toast('Only audio files can be added');
});

// ---------- math keypad ----------

const keypadWrap = $('keypad-wrap');
const keypadBtn = $<HTMLButtonElement>('keypad-btn');
new Keypad($('keypad'), panel);

function setKeypad(open: boolean): void {
  keypadWrap.classList.toggle('open', open);
  // Lets the layout make room for the keys (smaller screen on phones, side-by-side in landscape).
  document.documentElement.classList.toggle('keypad-open', open);
  graph.invalidate();
  keypadWrap.inert = !open;
  keypadBtn.setAttribute('aria-expanded', String(open));
  keypadBtn.classList.toggle('on', open);
  panel.setKeypadOpen(open);
  try {
    localStorage.setItem('mathestra:keypad', open ? '1' : '0');
  } catch {
    // ignore
  }
}

keypadBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret where it is
keypadBtn.addEventListener('click', () => setKeypad(!keypadWrap.classList.contains('open')));
$('keypad-close').addEventListener('pointerdown', (e) => e.preventDefault());
$('keypad-close').addEventListener('click', () => setKeypad(false));
/**
 * Touch screens never raise the system keyboard for equations: tapping a line opens
 * Mathestra's keypad instead (it has letters too). Text boxes such as the title keep
 * the normal keyboard.
 */
const coarse = matchMedia('(pointer: coarse)');
const applyTouch = () => panel.setTouch(coarse.matches);
coarse.addEventListener('change', applyTouch);
applyTouch();
panel.onLineTap = () => {
  if (viewOnly) return;
  if (coarse.matches && !keypadWrap.classList.contains('open')) setKeypad(true);
};

try {
  // On touch screens the keypad opens when a line is tapped, so it starts closed.
  setKeypad(!coarse.matches && localStorage.getItem('mathestra:keypad') === '1');
} catch {
  setKeypad(false);
}

// ---------- screen tools ----------

const follow = $<HTMLInputElement>('follow');
try {
  follow.checked = localStorage.getItem('mathestra:follow') !== '0';
} catch {
  // ignore
}
follow.addEventListener('change', () => {
  try {
    localStorage.setItem('mathestra:follow', follow.checked ? '1' : '0');
  } catch {
    // ignore
  }
});

const WAVE = 0.02;
const SONG = 4;

function viewChanged(): void {
  const v = store.doc.view;
  const span = v.x1 - v.x0;
  $('zoom-wave').classList.toggle('active', Math.abs(span / WAVE - 1) < 0.01);
  $('zoom-song').classList.toggle('active', Math.abs(span / SONG - 1) < 0.01);
  graph.invalidate();
  schedulePersist();
}

function setSpan(span: number): void {
  const v = store.doc.view;
  const start = Math.max(0, engine.playing ? engine.currentTime() - span * 0.1 : v.x0);
  store.doc.view = { ...v, x0: start, x1: start + span };
  viewChanged();
}

function setViewStart(x0: number): void {
  const v = store.doc.view;
  store.doc.view = { ...v, x0, x1: x0 + (v.x1 - v.x0) };
  graph.invalidate();
}

$('zoom-in').addEventListener('click', () => graph.zoom(0.5, 1, 0));
$('zoom-out').addEventListener('click', () => graph.zoom(2, 1, 0));
$('zoom-wave').addEventListener('click', () => setSpan(WAVE));
$('zoom-song').addEventListener('click', () => setSpan(SONG));

// ---------- clock and meter ----------

const timeEl = $('time');
const meter = $('meter');
const SEGMENTS = 16;
const segs: HTMLElement[] = [];
for (let i = 0; i < SEGMENTS; i++) {
  const s = document.createElement('i');
  if (i >= SEGMENTS - 4) s.classList.add('hot');
  if (i === SEGMENTS - 1) s.classList.add('clip');
  segs.push(meter.appendChild(s));
}
let meterLevel = 0;
let clipUntil = 0;

function updateTime(t: number): void {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  timeEl.textContent = `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

engine.onTick = ({ peak, clipped }) => {
  // Fast attack, slow release, on a dB scale from −48 to 0.
  const db = peak > 0 ? 20 * Math.log10(peak) : -96;
  const level = Math.max(0, Math.min(1, (db + 48) / 48));
  meterLevel = Math.max(level, meterLevel * 0.82);
  if (clipped) clipUntil = performance.now() + 900;
};
engine.onError = (msg) => toast(`Audio stopped: ${msg}`);

function drawMeter(): void {
  const lit = engine.playing ? Math.round(meterLevel * (SEGMENTS - 1)) : 0;
  const clipping = performance.now() < clipUntil;
  segs.forEach((s, i) => s.classList.toggle('on', i === SEGMENTS - 1 ? clipping : i < lit));
}

function loop(): void {
  if (engine.playing) {
    const t = engine.currentTime();
    updateTime(t);
    graph.setPlayhead(t);
    if (follow.checked) {
      // Page-turn like a DAW: when the playhead leaves the view, flip to the next page.
      const v = store.doc.view;
      const span = v.x1 - v.x0;
      if (t > v.x1 - span * 0.02 || t < v.x0) setViewStart(Math.max(0, t - span * 0.02));
    }
  }
  drawMeter();
  graph.frame();
  requestAnimationFrame(loop);
}

// ---------- persistence: URL hash + localStorage ----------

let persistTimer = 0;
function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => void persist(), 400);
}

async function persist(): Promise<void> {
  // Signed in now: this browser's graphs also become editable on the owner's other devices.
  const a = store.doc.author;
  if (a && accountKey && !a.u && a.d === deviceKey) a.u = accountKey;
  clearTimeout(persistTimer);
  const encoded = await encodeDoc(store.doc);
  // A published piece keeps its short address until someone edits it.
  if (!(publishedId && !userEdited)) history.replaceState(null, '', `#${encoded}`);
  // An untouched blank graph never overwrites the work kept from last time.
  if (userEdited && !viewOnly && !isBlank(store.doc)) saveLocal(encoded);
  scheduleCloudSave(encoded);
}

window.addEventListener('popstate', async () => {
  try {
    cloudId = new URLSearchParams(location.search).get('g');
    lastCloudData = null;
    loadDoc(await decodeDoc(location.hash.slice(1)));
    viewChanged();
    syncSaveUi();
  } catch {
    // ignore bad history entries
  }
});

let toastTimer = 0;
function toast(msg: string, action?: { label: string; run: () => void }, ms = 2600): void {
  const el = $('toast');
  const text = document.createElement('span');
  text.textContent = msg;
  el.replaceChildren(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      el.classList.remove('show');
      action.run();
    });
    el.append(b);
  }
  el.classList.toggle('has-action', !!action);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- "More" menu: the top bar's actions on narrow screens ----------

const moreBtn = $<HTMLButtonElement>('more-btn');
const morePop = $('more-pop');

function buildMore(): void {
  const item = (label: string, detail: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitem');
    b.innerHTML = '<b></b><span></span>';
    b.querySelector('b')!.textContent = label;
    b.querySelector('span')!.textContent = detail;
    b.addEventListener('click', () => {
      setMore(false);
      run();
    });
    return b;
  };
  const heading = (text: string) => {
    const h = document.createElement('div');
    h.className = 'menu-heading';
    h.textContent = text;
    return h;
  };
  const dark = effectiveTheme() === 'dark';
  morePop.replaceChildren(
    item('My graphs', 'Saved graphs', () => $('graphs-btn').click()),
    item('Copy link', 'Share this piece', () => $('share').click()),
    item('Syntax guide', 'Syntax and shortcuts', () => help.showModal()),
    item(dark ? 'Light mode' : 'Dark mode', 'Change appearance', () => $('theme-btn').click()),
    heading('Examples'),
    ...PRESETS.map((p) => item(p.name, p.description, () => openPreset(p))),
  );
}

function setMore(open: boolean): void {
  if (open) buildMore();
  morePop.classList.toggle('open', open);
  moreBtn.setAttribute('aria-expanded', String(open));
  if (open) (morePop.querySelector('.menu-item') as HTMLElement | null)?.focus();
}

moreBtn.addEventListener('click', () => setMore(!morePop.classList.contains('open')));
document.addEventListener('pointerdown', (e) => {
  if (!$('more').contains(e.target as Node)) setMore(false);
});
morePop.addEventListener('keydown', (e) => {
  const items = [...morePop.querySelectorAll<HTMLElement>('.menu-item')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
  else if (e.key === 'Escape') {
    setMore(false);
    moreBtn.focus();
  } else return;
  e.preventDefault();
});

// ---------- accounts and saved graphs ----------

const auth = new AuthDialog();
let user: User | null = null;
/** The saved graph this piece belongs to, if any. Lives in the URL as ?g=… */
let cloudId: string | null = new URLSearchParams(location.search).get('g');
let lastCloudData: string | null = null;
let saving = false;
let saveAgain = false;
let saveFailed = false;
let cloudTimer = 0;
let saveAfterSignIn = false;

const saveBtn = $<HTMLButtonElement>('save');
const saveStatus = $('save-status');

const library = new Library({
  onOpen: (row) => void openSaved(row),
  onNew: () => {
    history.pushState(null, '', location.href);
    detachCloud();
    engine.seek(0);
    graph.setPlayhead(0);
    updateTime(0);
    loadDoc({ ...PRESETS.find((p) => p.name === 'Blank')!.make(), author: me() });
    viewChanged();
    panel.focus(store.doc.items[0].id);
  },
  onSignIn: () => auth.open('signin', 'Sign in to keep your graphs in your account.'),
  currentId: () => cloudId,
});

const account = new AccountControl(
  $('account'),
  auth,
  () => [{ label: 'My graphs', run: () => library.open() }],
  () => toast('Signed out'),
);

function setQuery(id: string | null): void {
  const url = new URL(location.href);
  if (id) url.searchParams.set('g', id);
  else url.searchParams.delete('g');
  history.replaceState(null, '', url);
}

/** The piece on screen no longer belongs to a saved graph (an example, a new graph, signing out). */
function detachCloud(): void {
  cloudId = null;
  lastCloudData = null;
  saveFailed = false;
  setQuery(null);
  syncSaveUi();
}

function syncSaveUi(): void {
  if (viewOnly) {
    saveBtn.hidden = true;
    saveStatus.hidden = true;
    return;
  }
  const linked = !!(cloudId && user);
  saveBtn.hidden = linked;
  saveStatus.hidden = !linked;
  if (!linked) return;
  saveStatus.classList.toggle('failed', saveFailed);
  saveStatus.textContent = saveFailed ? 'Couldn’t save · Retry' : saving || cloudTimer ? 'Saving…' : 'Saved';
}

saveStatus.addEventListener('click', () => saveFailed && void saveToCloud());
saveBtn.addEventListener('click', () => void saveToCloud());

async function saveToCloud(): Promise<void> {
  if (viewOnly) return viewOnlyNotice();
  if (!user) {
    saveAfterSignIn = true;
    auth.open('signin', 'Sign in to save your graphs to your account.');
    return;
  }
  clearTimeout(cloudTimer);
  cloudTimer = 0;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  syncSaveUi();
  try {
    await uploadPendingClips(); // so the saved graph can play its audio anywhere
    const data = await encodeDoc(store.doc);
    const title = store.doc.title.trim() || 'Untitled';
    if (cloudId) {
      await updateGraph(cloudId, title, data);
    } else {
      const row = await createGraph(title, data);
      cloudId = row.id;
      setQuery(cloudId);
      toast('Saved to My graphs');
    }
    lastCloudData = data;
    saveFailed = false;
    if (library.isOpen()) void library.refresh();
  } catch (e) {
    saveFailed = true;
    toast((e as Error).message);
  } finally {
    saving = false;
    syncSaveUi();
    if (saveAgain) {
      saveAgain = false;
      void saveToCloud();
    }
  }
}

/** Autosave: once a piece is saved, every change follows it to the account. */
function scheduleCloudSave(encoded: string): void {
  if (!cloudId || !user || encoded === lastCloudData) return;
  clearTimeout(cloudTimer);
  cloudTimer = window.setTimeout(() => {
    cloudTimer = 0;
    void saveToCloud();
  }, 1200);
  syncSaveUi();
}

async function openSaved(row: GraphRow): Promise<void> {
  try {
    const doc = await decodeDoc(row.data);
    history.pushState(null, '', location.href);
    engine.seek(0);
    graph.setPlayhead(0);
    updateTime(0);
    cloudId = row.id;
    lastCloudData = row.data;
    saveFailed = false;
    setQuery(row.id);
    // A saved graph can only be read by its owner, so whoever opened it owns it.
    loadDoc({ ...doc, author: me() });
    viewChanged();
    syncSaveUi();
  } catch {
    toast('This graph could not be opened');
  }
}

/** A ?g=… link: load it once we know who is signed in. */
let loadingLinked = false;
async function loadLinkedGraph(): Promise<void> {
  if (!cloudId || lastCloudData || loadingLinked) return;
  if (!user) {
    auth.open('signin', 'Sign in to open this saved graph.');
    return;
  }
  loadingLinked = true;
  try {
    await openSaved(await getGraph(cloudId));
  } catch (e) {
    toast((e as Error).message);
    detachCloud();
  } finally {
    loadingLinked = false;
  }
}

onAuthChange((u, event) => {
  const was = user?.id;
  user = u;
  void (u ? hashAccount(u.id) : Promise.resolve(null)).then((key) => {
    accountKey = key;
    applyViewOnly();
  });
  account.setUser(u);
  library.setUser(u);
  if (event === 'recovery') auth.open('update');
  if (event === 'signed-out' && was) detachCloud();
  if (event === 'signed-in' && u && u.id !== was) {
    if (cloudId && !lastCloudData) void loadLinkedGraph();
    else if (saveAfterSignIn) void saveToCloud();
    saveAfterSignIn = false;
  }
  syncSaveUi();
});

void currentUser().then((u) => {
  user = u;
  account.setUser(u);
  library.setUser(u);
  syncSaveUi();
  void loadLinkedGraph();
  // Arriving from the landing page's "My graphs".
  const url = new URL(location.href);
  if (url.searchParams.has('library')) {
    url.searchParams.delete('library');
    history.replaceState(null, '', url);
    library.open();
  }
});

trackViewport();
// Short confirmations from the sign-in dialog ("Your email is confirmed…").
function showNotice(message: string): void {
  toast(message, undefined, 3500);
  try {
    sessionStorage.removeItem('mathestra:notice');
  } catch {
    // ignore
  }
}
document.addEventListener('mathestra:notice', (e) => showNotice((e as CustomEvent<string>).detail));
try {
  const pending = sessionStorage.getItem('mathestra:notice');
  if (pending) setTimeout(() => showNotice(pending), 600);
} catch {
  // ignore
}

$('make-copy').addEventListener('click', makeCopy);

rebuild();
viewChanged();
graph.setPlayhead(0);
applyViewOnly();
syncSaveUi();
loop();

if (publishedFailed) toast('This piece could not be loaded. Check your connection and open the link again.', undefined, 6000);

// A fresh blank graph: ready to type on computers (phones wait for a tap, so the
// keyboard doesn't jump up), and last visit's unsaved piece is one tap away.
if (startedBlank && !cloudId) {
  if (matchMedia('(pointer: fine)').matches) panel.focus(store.doc.items[0].id);
  const previous = previousSession as Doc | null; // set inside initialDoc(), which TypeScript cannot see
  if (previous) {
    toast(
      `Your previous graph${previous.title && previous.title !== 'Untitled' ? `, ${previous.title},` : ''} is still available`,
      {
        label: 'Restore',
        run: () => {
          history.pushState(null, '', location.href);
          loadDoc(previous, true); // it is their own work, so it stays kept
          viewChanged();
        },
      },
      9000,
    );
  }
}
