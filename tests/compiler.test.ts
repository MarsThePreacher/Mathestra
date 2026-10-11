import { describe, expect, it } from 'vitest';
import { compile, instantiate } from '../src/math/compiler';

function run(lines: string[], vars: Record<string, number> = {}) {
  const prog = compile(lines);
  const inst = instantiate(prog.source, { ...prog.vars, ...vars });
  return { prog, inst };
}

const evalAt = (expr: string, x: number, extra: string[] = []) => {
  const { prog, inst } = run([...extra, `y = ${expr}`]);
  const line = prog.lines[extra.length];
  expect(line.error).toBeUndefined();
  return inst.tracks[line.trackIndex!](x);
};

describe('compiler', () => {
  it('evaluates a pure tone', () => {
    expect(evalAt('sin(2π·440x)', 1 / 1760)).toBeCloseTo(1);
  });

  it('handles implicit multiplication and word splitting', () => {
    expect(evalAt('2pix', 1)).toBeCloseTo(2 * Math.PI);
    expect(evalAt('sinx', 1)).toBeCloseTo(Math.sin(1));
    expect(evalAt('sin 2x + 1', 1)).toBeCloseTo(Math.sin(2) + 1);
    expect(evalAt('3(x+1)', 1)).toBe(6);
    expect(evalAt('sin(x)cos(x)', 1)).toBeCloseTo(Math.sin(1) * Math.cos(1));
  });

  it('accepts keypad symbols', () => {
    expect(evalAt('√(x)', 9)).toBe(3);
    expect(evalAt('√x + 1', 4)).toBe(3);
    expect(evalAt('∛(x)', 8)).toBeCloseTo(2);
    expect(evalAt('x²', 3)).toBe(9);
    expect(evalAt('2x³', 2)).toBe(16);
  });

  it('follows precedence', () => {
    expect(evalAt('-x^2', 3)).toBe(-9);
    expect(evalAt('2^3^2', 0)).toBe(512);
    expect(evalAt('e^{-3x}', 1)).toBeCloseTo(Math.exp(-3));
    expect(evalAt('e^(-3x)', 1)).toBeCloseTo(Math.exp(-3));
    expect(evalAt('1/2x', 4)).toBe(2);
  });

  it('supports piecewise and mod', () => {
    expect(evalAt('{x<1: 5, x<2: 6, 7}', 1.5)).toBe(6);
    expect(evalAt('{x<1: 5, x<2: 6, 7}', 3)).toBe(7);
    expect(evalAt('{0<x<1}', 0.5)).toBe(1);
    expect(evalAt('{0<x<1}', 2)).toBeNaN();
    expect(evalAt('mod(x, 3)', -1)).toBe(2);
  });

  it('supports sliders, constants and functions in any order', () => {
    const lines = ['y = A·f(x)', 'f(s) = s + b', 'b = 2a', 'a = 3', 'A = 0.5'];
    const { prog, inst } = run(lines, { a: 10 });
    expect(prog.lines.map((l) => l.kind)).toEqual(['track', 'func', 'const', 'slider', 'slider']);
    expect(prog.lines[3].sliderValue).toBe(3);
    expect(inst.tracks[0](1)).toBe(0.5 * (1 + 20));
  });

  it('supports lists for melodies', () => {
    const lines = ['N = [0, 4, 7]', 'y = N[x + 1]', 'length(N)'];
    const { prog, inst } = run(lines);
    expect(inst.tracks[0](1.5)).toBe(4);
    expect(inst.tracks[0](5)).toBeNaN();
    expect(inst.values[prog.lines[2].valueIndex!]()).toBe(3);
  });

  it('reports errors per line without breaking others', () => {
    const { prog, inst } = run(['y = sin(', 'y = q·x', 'y = x', 'a = b', 'b = a', 'z = x']);
    expect(prog.lines[0].error).toBeTruthy();
    expect(prog.lines[1].missing).toEqual(['q']);
    expect(prog.lines[2].error).toBeUndefined();
    expect(prog.lines[3].error).toBeTruthy();
    expect(prog.lines[4].error).toBeTruthy();
    expect(prog.lines[5].error).toMatch(/function/);
    expect(inst.tracks).toHaveLength(1);
  });

  it('rejects lists where a sound is expected', () => {
    const { prog } = run(['L = [1,2]', 'y = L']);
    expect(prog.lines[1].error).toMatch(/single number/);
  });

  it('treats notes and empty lines as inert', () => {
    const { prog } = run(['// my beat', '', '"hello"']);
    expect(prog.lines.map((l) => l.kind)).toEqual(['note', 'empty', 'note']);
  });

  it('allows multi-letter names once defined', () => {
    expect(evalAt('freq·x', 2, ['freq = 3'])).toBe(6);
  });
});
