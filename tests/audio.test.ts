import { describe, expect, it } from 'vitest';
import { compile, instantiate, type Sample } from '../src/math/compiler';

// A tiny "recording": 4 samples at 4 Hz, so it lasts one second.
const clip: Sample = { data: new Float32Array([0, 1, 0, -1]), rate: 4 };

function trackOf(lines: string[], samples: Record<string, Sample> = { drums: clip }) {
  const prog = compile(lines, Object.keys(samples));
  prog.lines.forEach((l) => expect(l.error).toBeUndefined());
  return instantiate(prog.source, prog.vars, samples).tracks[0];
}

describe('audio clips as functions of time', () => {
  it('reads samples and interpolates between them', () => {
    const y = trackOf(['y = drums(x)']);
    expect(y(0)).toBe(0);
    expect(y(0.25)).toBe(1);
    expect(y(0.125)).toBeCloseTo(0.5);
    expect(y(0.75)).toBe(-1);
  });

  it('is silent before the clip starts and after it ends', () => {
    const y = trackOf(['y = drums(x)']);
    expect(y(-0.1)).toBe(0);
    expect(y(5)).toBe(0);
  });

  it('works with ordinary maths: speed, reverse, loop, gain', () => {
    expect(trackOf(['y = drums(2x)'])(0.125)).toBe(1); // twice as fast
    expect(trackOf(['y = drums(1 - x)'])(0.25)).toBe(-1); // reversed
    expect(trackOf(['y = drums(mod(x, 0.5))'])(0.75)).toBe(1); // looped
    expect(trackOf(['g = 0.5', 'y = g·drums(x)'])(0.25)).toBe(0.5);
    expect(trackOf(['f(s) = drums(s)·2', 'y = f(x)'])(0.25)).toBe(2);
  });

  it('is silent while a clip has not loaded yet', () => {
    const prog = compile(['y = drums(x)'], ['drums']);
    expect(instantiate(prog.source, prog.vars, {}).tracks[0](0.25)).toBe(0);
  });

  it('keeps clip names from being redefined', () => {
    const prog = compile(['drums = 3', 'y = drums(x)'], ['drums']);
    expect(prog.lines[0].error).toMatch(/audio clip/);
    expect(prog.lines[1].error).toBeUndefined();
  });

  it('works with multi-letter and underscored names', () => {
    expect(trackOf(['y = kick_2(x)'], { kick_2: clip })(0.25)).toBe(1);
  });
});
