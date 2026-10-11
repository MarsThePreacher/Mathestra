// Main-thread side of the audio engine. Messages are remembered so the
// worklet gets the full picture as soon as it is created (browsers only allow
// audio after a user gesture, so that happens on the first Play).

import type { Sample } from '../math/compiler';

type Message =
  | { type: 'program'; source: string; trackIds: string[]; vars: Record<string, number> }
  | { type: 'vars'; vars: Record<string, number> }
  | { type: 'samples'; samples: Record<string, Sample> }
  | { type: 'gains'; gains: Record<string, number> }
  | { type: 'master'; value: number }
  | { type: 'loop'; seconds: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number };


export interface Tick {
  time: number;
  peak: number;
  clipped: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private program: Message | null = null;
  private latest = new Map<string, Message>();
  private lastTick: Tick = { time: 0, peak: 0, clipped: false };
  private lastTickAt = 0;
  private loopSeconds = 0;

  playing = false;
  onTick: (tick: Tick) => void = () => {};
  onError: (message: string) => void = () => {};

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  private async start(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}mathestra-processor.js`);
    const node = new AudioWorkletNode(ctx, 'mathestra', { outputChannelCount: [2] });
    node.connect(ctx.destination);
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'tick') {
        this.lastTick = m;
        this.lastTickAt = performance.now();
        this.onTick(m);
      } else if (m.type === 'error') {
        this.onError(m.message);
      }
    };
    this.ctx = ctx;
    this.node = node;
    // Replay state: program first, then everything else.
    if (this.program) node.port.postMessage(this.program);
    for (const m of this.latest.values()) node.port.postMessage(m);
  }

  private send(m: Message): void {
    if (m.type === 'program') {
      this.program = m;
      this.latest.delete('vars');
    } else {
      this.latest.set(m.type === 'pause' ? 'play' : m.type, m);
    }
    this.node?.port.postMessage(m);
  }

  setProgram(source: string, trackIds: string[], vars: Record<string, number>): void {
    if (this.program?.type === 'program' && this.program.source === source &&
        this.program.trackIds.join() === trackIds.join()) {
      this.send({ type: 'vars', vars });
    } else {
      this.send({ type: 'program', source, trackIds, vars });
    }
  }

  /** Audio clips the program reads from. Sent once per change; the worklet keeps its own copy. */
  setSamples(samples: Record<string, Sample>): void {
    this.send({ type: 'samples', samples });
  }

  setGains(gains: Record<string, number>): void {
    this.send({ type: 'gains', gains });
  }

  setMaster(value: number): void {
    this.send({ type: 'master', value });
  }

  setLoop(seconds: number): void {
    this.loopSeconds = seconds;
    this.send({ type: 'loop', seconds });
  }

  async play(): Promise<void> {
    if (!this.ctx) {
      this.starting ??= this.start();
      await this.starting;
    }
    if (this.ctx!.state !== 'running') await this.ctx!.resume();
    this.playing = true;
    this.lastTickAt = performance.now();
    this.send({ type: 'play' });
  }

  pause(): void {
    this.playing = false;
    this.lastTick = { ...this.lastTick, time: this.currentTime() };
    this.send({ type: 'pause' });
  }

  seek(time: number): void {
    this.lastTick = { ...this.lastTick, time };
    this.lastTickAt = performance.now();
    this.send({ type: 'seek', time });
  }

  /** Smooth playhead position, interpolated between worklet reports. */
  currentTime(): number {
    if (!this.playing) return this.lastTick.time;
    let t = this.lastTick.time + (performance.now() - this.lastTickAt) / 1000;
    if (this.loopSeconds > 0) t %= this.loopSeconds;
    return t;
  }
}
