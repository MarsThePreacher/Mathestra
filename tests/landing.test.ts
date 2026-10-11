import { describe, expect, it } from 'vitest';
import { compile, instantiate } from '../src/math/compiler';

// The landing page's demo lines must compile cleanly and make sound.
const DEMO_LINES = [
  ['y = 0.5sin(2π·440x)'],
  ['y = 0.3(sin(2π·440x) + sin(2π·443x))'],
  ['k(s) = sin(2π(45s + 6(1 - e^{-25s})))·e^{-7s}', 'y = 0.8k(mod(x, 0.5))'],
  ['N = [0, 4, 7, 12]', 's(x) = mod(x, 0.25)', 'p(x) = N[4x - 4floor(x) + 1]', 'y = 0.4sin(2π·220·2^{p(x)/12}s(x))·e^{-6s(x)}'],
  ['f = 220', 'y = 0.5sin(2πfx)'],
];

describe('landing demos', () => {
  for (const lines of DEMO_LINES) {
    it(lines[lines.length - 1], () => {
      const prog = compile(lines);
      prog.lines.forEach((l) => expect(l.error).toBeUndefined());
      const inst = instantiate(prog.source, prog.vars);
      let peak = 0;
      for (let i = 0; i < 48000; i += 7) peak = Math.max(peak, Math.abs(inst.tracks[0](i / 48000)));
      expect(peak).toBeGreaterThan(0.1);
      expect(peak).toBeLessThanOrEqual(1);
    });
  }
});
