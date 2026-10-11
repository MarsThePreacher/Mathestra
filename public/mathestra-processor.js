// Mathestra audio thread. Evaluates each track's y = f(t) once per sample,
// where t is time in seconds and y is the speaker position in [-1, 1].

class MathestraProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.source = '';
    this.vars = {};
    this.samples = {}; // audio clips: name -> { data: Float32Array, rate }
    this.trackIds = [];
    this.tracks = [];
    this.gainTargets = {}; // track id -> gain
    this.gainCurrent = {}; // smoothed, so mute/volume changes never click
    this.master = 0.5;
    this.masterCurrent = 0.5;
    this.playing = false;
    this.frame = 0; // integer sample counter keeps time exact over long sessions
    this.loopFrames = 0; // 0 = no loop
    this.peak = 0;
    this.clipped = false;
    this.sinceReport = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'program':
        this.source = m.source;
        this.trackIds = m.trackIds;
        this.vars = m.vars;
        this.build();
        break;
      case 'vars':
        this.vars = m.vars;
        this.build();
        break;
      case 'samples':
        this.samples = m.samples;
        this.build();
        break;
      case 'gains':
        this.gainTargets = m.gains;
        break;
      case 'master':
        this.master = m.value;
        break;
      case 'loop':
        this.loopFrames = Math.round(m.seconds * sampleRate);
        if (this.loopFrames > 0) this.frame %= this.loopFrames;
        break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek':
        this.frame = Math.max(0, Math.round(m.time * sampleRate));
        break;
    }
  }

  build() {
    try {
      this.tracks = this.source ? new Function('V', 'S', this.source)(this.vars, this.samples).tracks : [];
    } catch (err) {
      this.tracks = [];
      this.port.postMessage({ type: 'error', message: String(err) });
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1];
    const n = left.length;

    if (this.playing) {
      try {
        this.render(left, n);
      } catch (err) {
        left.fill(0);
        this.port.postMessage({ type: 'error', message: String(err) });
      }
    } else {
      left.fill(0);
    }
    if (right) right.set(left);

    this.sinceReport += n;
    if (this.sinceReport >= 1024) {
      this.port.postMessage({
        type: 'tick',
        time: this.frame / sampleRate,
        peak: this.peak,
        clipped: this.clipped,
      });
      this.sinceReport = 0;
      this.peak = 0;
      this.clipped = false;
    }
    return true;
  }

  render(left, n) {
    const fns = this.tracks;
    const count = fns.length;
    const targets = new Float64Array(count);
    const current = new Float64Array(count);
    for (let j = 0; j < count; j++) {
      const id = this.trackIds[j];
      targets[j] = this.gainTargets[id] ?? 0;
      current[j] = this.gainCurrent[id] ?? targets[j];
    }
    // ~5 ms smoothing for gain changes
    const k = 1 - Math.exp(-1 / (0.005 * sampleRate));
    let master = this.masterCurrent;
    let peak = this.peak;
    let clipped = this.clipped;
    let frame = this.frame;
    const loop = this.loopFrames;

    for (let i = 0; i < n; i++) {
      const t = frame / sampleRate;
      let s = 0;
      for (let j = 0; j < count; j++) {
        current[j] += (targets[j] - current[j]) * k;
        if (current[j] < 1e-6 && targets[j] === 0) continue;
        const v = fns[j](t);
        // Undefined points (NaN, ±Infinity) are silence, like gaps in a graph.
        if (v - v === 0) s += v * current[j];
      }
      master += (this.master - master) * k;
      s *= master;
      if (s > 1) {
        s = 1;
        clipped = true;
      } else if (s < -1) {
        s = -1;
        clipped = true;
      }
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      left[i] = s;
      frame++;
      if (loop > 0 && frame >= loop) frame = 0;
    }

    for (let j = 0; j < count; j++) this.gainCurrent[this.trackIds[j]] = current[j];
    this.masterCurrent = master;
    this.peak = peak;
    this.clipped = clipped;
    this.frame = frame;
  }
}

registerProcessor('mathestra', MathestraProcessor);
