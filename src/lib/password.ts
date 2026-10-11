// Password rules and strength, shared by account creation and password resets.

export interface Check {
  id: 'length' | 'upper' | 'lower' | 'number' | 'symbol';
  label: string;
  ok: boolean;
}

export const MIN_LENGTH = 8;

/** The requirements a new password must meet, each with its current state. */
export function passwordChecks(pw: string): Check[] {
  return [
    { id: 'length', label: `${MIN_LENGTH} or more characters`, ok: [...pw].length >= MIN_LENGTH },
    { id: 'upper', label: 'An uppercase letter', ok: /\p{Lu}/u.test(pw) },
    { id: 'lower', label: 'A lowercase letter', ok: /\p{Ll}/u.test(pw) },
    { id: 'number', label: 'A number', ok: /\p{Nd}/u.test(pw) },
    { id: 'symbol', label: 'A symbol', ok: /[^\p{L}\p{Nd}\s]/u.test(pw) },
  ];
}

export function meetsAll(pw: string): boolean {
  return passwordChecks(pw).every((c) => c.ok);
}

// Passwords that satisfy the rules on paper but are among the first anyone tries.
const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin', 'mathestra', 'abc123', '123456'];

export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: '' | 'Weak' | 'Fair' | 'Good' | 'Strong' };

/**
 * A 0 to 4 rating for the meter. Variety of character types matters, length matters
 * more, and repeats or well-known passwords pull it down.
 */
export function strength(pw: string): Strength {
  if (!pw) return { score: 0, label: '' };
  const met = passwordChecks(pw).filter((c) => c.ok).length;
  const lower = pw.toLowerCase();
  const length = [...pw].length;
  let score: number = met <= 2 ? 1 : met === 3 ? 2 : met === 4 ? 3 : 3;
  if (met === 5 && length >= 12) score = 4;
  if (met >= 4 && length >= 16) score = 4;
  if (length < MIN_LENGTH) score = Math.min(score, 1);
  if (COMMON.some((c) => lower.includes(c)) || /^(.)\1+$/.test(pw) || /(0123|1234|2345|3456|4567|5678|6789|abcd)/.test(lower)) {
    score = Math.min(score, 1);
  }
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'] as const;
  return { score: score as Strength['score'], label: labels[score] };
}
