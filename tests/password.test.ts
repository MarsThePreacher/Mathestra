import { describe, expect, it } from 'vitest';
import { meetsAll, passwordChecks, strength } from '../src/lib/password';

const state = (pw: string) => Object.fromEntries(passwordChecks(pw).map((c) => [c.id, c.ok]));

describe('password rules', () => {
  it('reports each requirement separately', () => {
    expect(state('')).toEqual({ length: false, upper: false, lower: false, number: false, symbol: false });
    expect(state('abc')).toMatchObject({ lower: true, upper: false, length: false });
    expect(state('Abcdefg1!')).toEqual({ length: true, upper: true, lower: true, number: true, symbol: true });
  });

  it('accepts letters beyond ASCII', () => {
    expect(state('Ünïcødé9#')).toMatchObject({ upper: true, lower: true, number: true, symbol: true });
  });

  it('requires every rule before an account can be made', () => {
    expect(meetsAll('Abcdefg1')).toBe(false); // no symbol
    expect(meetsAll('Tide-Pool7')).toBe(true);
  });
});

describe('password strength', () => {
  it('is empty for an empty password', () => {
    expect(strength('').score).toBe(0);
  });

  it('rises with variety and length', () => {
    expect(strength('abcdefgh').label).toBe('Weak');
    expect(strength('Abcdefgh').score).toBeLessThan(strength('Tide-Pool7').score);
    expect(strength('Tide-Pool7').label).toBe('Good');
    expect(strength('Quiet-Harbor-Lights7').label).toBe('Strong');
  });

  it('marks well-known and patterned passwords as weak', () => {
    expect(strength('Password1!').label).toBe('Weak');
    expect(strength('Abc12345!').label).toBe('Weak');
    expect(strength('aaaaaaaaaaaa').label).toBe('Weak');
  });
});
