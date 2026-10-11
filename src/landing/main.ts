import './landing.css';
import { AudioEngine } from '../audio/engine';
import { compile } from '../math/compiler';
import { PRESETS } from '../presets';
import { COLORS, encodeDoc, makeDoc } from '../state';
import { AccountControl } from '../ui/account';
import { AuthDialog } from '../ui/authDialog';
import { typesetLine } from '../ui/mathField';
import { trackViewport } from '../ui/viewport';
import { drawMini, tracesOf } from '../ui/miniWave';
import { currentUser, onAuthChange, type User } from '../lib/supabase';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Static equations everywhere are set with the same typesetter as the calculator.
function typesetAll(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-tex]').forEach((el) => {
    el.classList.add('expr-static');
    el.replaceChildren(...typesetLine(el.dataset.tex!));
  });
}
typesetAll();

// ---------- theme ----------

function effectiveTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const redrawers: (() => void)[] = [];
function applyTheme(): void {
  // A manual theme overrides the system one, so every theme-color tag follows it.
  const color = effectiveTheme() === 'dark' ? '#111111' : '#efefef';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color));
  redrawers.forEach((r) => r());
}
$('theme-btn').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('mathestra:theme', next);
  } catch {
    // ignore
  }
  applyTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- one shared audio engine; one thing plays at a time ----------

const engine = new AudioEngine();
let playing: { stop: () => void } | null = null;

function stopAll(): void {
  if (playing) {
    const p = playing;
    playing = null;
    p.stop();
  }
}

async function playLines(lines: string[], vars: Record<string, number> = {}, loop = 0): Promise<void> {
  const program = compile(lines);
  const ids = program.lines.flatMap((l, i) => (l.trackIndex !== undefined ? [{ id: `t${i}`, at: l.trackIndex }] : []));
  ids.sort((a, b) => a.at - b.at);
  engine.setProgram(program.source, ids.map((t) => t.id), { ...program.vars, ...vars });
  engine.setGains(Object.fromEntries(ids.map((t) => [t.id, 1])));
  engine.setMaster(0.55);
  engine.setLoop(loop);
  engine.seek(0);
  await engine.play();
}

// ---------- hero: a live instrument ----------

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function noteName(f: number): string {
  const n = Math.round(12 * Math.log2(f / 440) + 69);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

const heroF = $<HTMLInputElement>('hero-f');
const heroOut = $('hero-f-out');
const heroPlay = $<HTMLButtonElement>('hero-play');
const heroCanvas = $<HTMLCanvasElement>('hero-wave');
const HERO_LINES = ['f = 220', 'y = 0.5sin(2πfx)'];
const HERO_SPAN = 0.012; // seconds across the screen
let heroOn = false;
let heroReveal = reduceMotion ? 1 : 0;

function heroFreq(): number {
  return Number(heroF.value);
}

function setFill(r: HTMLInputElement): void {
  const min = Number(r.min);
  r.style.setProperty('--fill', `${((Number(r.value) - min) / (Number(r.max) - min)) * 100}%`);
}

function syncHeroSlider(): void {
  heroOut.textContent = `${heroFreq()} Hz · ${noteName(heroFreq())}`;
  setFill(heroF);
}

heroF.addEventListener('input', () => {
  syncHeroSlider();
  if (heroOn) engine.setProgram(compile(HERO_LINES).source, ['t1'], { f: heroFreq() });
});

heroPlay.addEventListener('click', async () => {
  if (heroOn) return stopAll();
  stopAll();
  heroOn = true;
  heroPlay.classList.add('playing');
  heroPlay.setAttribute('aria-label', 'Pause');
  $('hero-hint').classList.add('dim');
  playing = {
    stop: () => {
      heroOn = false;
      engine.pause();
      heroPlay.classList.remove('playing');
      heroPlay.setAttribute('aria-label', 'Play');
    },
  };
  await playLines(HERO_LINES, { f: heroFreq() });
});

function drawHero(): void {
  const c = heroCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Oscilloscope grid: 12 divisions of 1 ms across, 8 down.
  const hair = 1 / dpr;
  const snap = (v: number) => (Math.round(v * dpr) + 0.5) / dpr;
  ctx.lineWidth = hair;
  ctx.strokeStyle = css('--screen-grid-major');
  ctx.beginPath();
  for (let i = 1; i < 12; i++) {
    const x = snap((i / 12) * w);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let j = 1; j < 8; j++) {
    const y = snap((j / 8) * h);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.fillStyle = css('--screen-axis');
  ctx.fillRect(0, Math.round((h / 2) * dpr) / dpr - 1, w, 2);

  // The wave itself. While playing, the window slides with real time.
  const f = heroFreq();
  const t0 = heroOn ? engine.currentTime() : 0;
  const Y = (v: number) => h / 2 - v * h * 0.85;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w * heroReveal, h);
  ctx.clip();
  ctx.beginPath();
  const n = Math.ceil(w * dpr);
  for (let i = 0; i <= n; i++) {
    const x = i / dpr;
    const t = t0 + (x / w) * HERO_SPAN;
    const y = Y(0.5 * Math.sin(2 * Math.PI * f * t));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COLORS[0];
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}
redrawers.push(drawHero);

let revealStart = 0;
let shown = false; // the wave draws itself in only once the page is visible
function frame(now: number): void {
  if (shown && heroReveal < 1) {
    revealStart ||= now;
    const k = Math.min(1, (now - revealStart) / 1100);
    heroReveal = 1 - Math.pow(1 - k, 3); // ease out: the one entrance on the page
  }
  if (heroOn || heroReveal < 1 || frameDirty) {
    drawHero();
    frameDirty = false;
  }
  requestAnimationFrame(frame);
}
let frameDirty = true;
heroF.addEventListener('input', () => (frameDirty = true));
new ResizeObserver(() => (frameDirty = true)).observe(heroCanvas);
syncHeroSlider();
requestAnimationFrame(frame);

// ---------- "Every line is a sound" ----------

interface LineDemo {
  /** These lines are both displayed and played, unchanged. */
  lines: string[];
  view: { x0: number; x1: number };
  loop?: number;
  text: string;
}

const DEMOS: LineDemo[] = [
  {
    lines: ['y = 0.5sin(2π·440x)'],
    view: { x0: 0, x1: 0.012 },
    text: 'A sine wave at 440 Hz, concert A. The speaker cone traces this curve 440 times a second.',
  },
  {
    lines: ['y = 0.3(sin(2π·440x) + sin(2π·443x))'],
    view: { x0: 0, x1: 1.5 },
    text: 'Two tones 3 Hz apart. Their sum swells and fades three times a second, the beating that piano tuners listen for.',
  },
  {
    lines: ['k(s) = sin(2π(45s + 6(1 - e^{-25s})))·e^{-7s}', 'y = 0.8k(mod(x, 0.5))'],
    view: { x0: 0, x1: 1.5 },
    loop: 2,
    text: 'A falling pitch under a fast decay is a kick drum. mod restarts it every half second: 120 bpm.',
  },
  {
    lines: ['N = [0, 4, 7, 12]', 's(x) = mod(x, 0.25)', 'p(x) = N[4x - 4floor(x) + 1]', 'y = 0.4sin(2π·220·2^{p(x)/12}s(x))·e^{-6s(x)}'],
    view: { x0: 0, x1: 1 },
    loop: 2,
    text: 'A list holds the notes and time chooses one every quarter second: root, third, fifth and octave of A major.',
  },
];

const score = $('score');
DEMOS.forEach((demo, i) => {
  const li = document.createElement('li');
  li.className = 'score-line';
  li.innerHTML = `
    <span class="score-num">${i + 1}</span>
    <div class="score-body">
      <div class="score-eqs"></div>
      <p></p>
    </div>
    <div class="score-side">
      <canvas aria-hidden="true"></canvas>
      <button class="score-play" type="button" aria-label="Play line ${i + 1}">
        <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5a.8.8 0 0 0-1.2.7Z" /></svg>
        <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" /></svg>
      </button>
    </div>`;
  const eqs = li.querySelector('.score-eqs')!;
  for (const line of demo.lines) {
    const s = document.createElement('div');
    s.className = 'expr-static';
    s.append(...typesetLine(line));
    eqs.append(s);
  }
  li.querySelector('p')!.textContent = demo.text;
  const canvas = li.querySelector('canvas')!;
  const draw = () =>
    drawMini(canvas, tracesOf(makeDoc('', demo.lines)).map((t) => ({ ...t, color: COLORS[i % COLORS.length] })), {
      ...demo.view,
      y0: -1.1,
      y1: 1.1,
    }, { axis: css('--screen-grid-major'), lineWidth: 1.2 });
  redrawers.push(draw);
  requestAnimationFrame(draw);

  const btn = li.querySelector<HTMLButtonElement>('.score-play')!;
  btn.addEventListener('click', () => toggleClip(btn, demo.lines, demo.loop ?? 0, 4));
  score.append(li);
});

/** Play a short clip from a button; pressing it again (or anything else) stops it. */
async function toggleClip(btn: HTMLButtonElement, lines: string[], loop: number, seconds: number): Promise<void> {
  const mine = playing && (playing as { btn?: HTMLButtonElement }).btn === btn;
  stopAll();
  if (mine) return;
  btn.classList.add('playing');
  const label = btn.getAttribute('aria-label')!;
  btn.setAttribute('aria-label', label.replace('Play', 'Stop'));
  let timer = 0;
  const handle = {
    btn,
    stop: () => {
      clearTimeout(timer);
      engine.pause();
      btn.classList.remove('playing');
      btn.setAttribute('aria-label', label);
    },
  };
  playing = handle;
  await playLines(lines, {}, loop);
  timer = window.setTimeout(() => playing === handle && stopAll(), seconds * 1000);
}

// ---------- examples gallery ----------

const gallery = $('gallery');
const featured = ['Drum beat', 'Arpeggio', 'FM bell', 'A major chord', 'Beating', 'Hello, A440'];
for (const name of featured) {
  const preset = PRESETS.find((p) => p.name === name);
  if (!preset) continue;
  const doc = preset.make();
  const li = document.createElement('li');
  li.className = 'tile';
  li.innerHTML = `
    <div class="tile-screen"><canvas aria-hidden="true"></canvas>
      <button class="score-play tile-play" type="button" aria-label="Play ${preset.name}">
        <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5a.8.8 0 0 0-1.2.7Z" /></svg>
        <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" /></svg>
      </button>
    </div>
    <div class="tile-text"><h3></h3><p></p></div>
    <a class="tile-open" href="/app/">Open in calculator</a>`;
  li.querySelector('h3')!.textContent = preset.name;
  li.querySelector('p')!.textContent = preset.description;
  const canvas = li.querySelector('canvas')!;
  const span = doc.loop > 0 ? Math.min(doc.loop, 3) : Math.min(doc.view.x1 - doc.view.x0, 3) || 1;
  const draw = () => drawMini(canvas, tracesOf(doc), { x0: 0, x1: span, y0: -1.15, y1: 1.15 }, { axis: css('--screen-grid-major'), lineWidth: 1 });
  redrawers.push(draw);
  requestAnimationFrame(draw);
  void encodeDoc(doc).then((enc) => li.querySelector<HTMLAnchorElement>('.tile-open')!.setAttribute('href', `/app/#${enc}`));
  const lines = doc.items.map((it) => it.text);
  li.querySelector<HTMLButtonElement>('.tile-play')!.addEventListener('click', (e) =>
    toggleClip(e.currentTarget as HTMLButtonElement, lines, doc.loop, 6),
  );
  gallery.append(li);
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => redrawers.forEach((r) => r()), 120);
});

// ---------- accounts ----------

const auth = new AuthDialog();
const account = new AccountControl($('account'), auth, () => [
  { label: 'Open calculator', run: () => (location.href = '/app/') },
  { label: 'My graphs', run: () => (location.href = '/app/?library') },
]);
$('hero-signup').addEventListener('click', () => auth.open('signup', 'Keep your graphs and open them on any device.'));

let known: string | null | undefined; // undefined until the first session check
function setUser(u: User | null): void {
  account.setUser(u);
  $('hero-signup').hidden = !!u;
}
onAuthChange((u, event) => {
  if (event === 'recovery') {
    location.href = '/app/' + location.hash; // the calculator handles new passwords
    return;
  }
  // Signing in from this page takes you to your work.
  if (event === 'signed-in' && u && known !== undefined && u.id !== known) location.href = '/app/?library';
  setUser(u);
});
const sessionKnown = currentUser().then((u) => {
  known = u?.id ?? null;
  setUser(u);
});

const nav = document.querySelector('.nav')!;
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

applyTheme();
trackViewport();

// ---------- reveal ----------
// Show the page in one piece: after the web fonts (so text doesn't re-flow), the
// typeset equations (built above) and the sign-in state (so the nav doesn't swap).
async function reveal(): Promise<void> {
  const cap = new Promise((r) => setTimeout(r, 1200));
  await Promise.race([Promise.all([document.fonts.ready, sessionKnown.catch(() => {})]), cap]);
  redrawers.forEach((r) => r()); // canvases at their final size, with final fonts
  requestAnimationFrame(() => {
    document.documentElement.classList.remove('booting');
    shown = true;
  });
}
void reveal();
