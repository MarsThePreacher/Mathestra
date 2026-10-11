import { describe, expect, it } from 'vitest';
import { compile, instantiate } from '../src/math/compiler';
import { PRESETS } from '../src/presets';

describe('presets', () => {
  for (const preset of PRESETS) {
    it(`${preset.name} compiles and stays in range`, () => {
      const doc = preset.make();
      const prog = compile(doc.items.map((i) => i.text));
      for (const line of prog.lines) expect(line.error).toBeUndefined();
      const inst = instantiate(prog.source, prog.vars);
      // Sum the mix over 3 seconds at 48 kHz: must be finite and not wildly clipping.
      let peak = 0;
      for (let i = 0; i < 48000 * 3; i++) {
        let s = 0;
        for (const fn of inst.tracks) s += fn(i / 48000);
        expect(Number.isFinite(s)).toBe(true);
        peak = Math.max(peak, Math.abs(s));
      }
      expect(peak).toBeLessThanOrEqual(1.5);
    });
  }
});
