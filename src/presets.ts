import { makeDoc, type Doc } from './state';

export interface Preset {
  name: string;
  description: string;
  make: () => Doc;
}

export const PRESETS: Preset[] = [
  {
    name: 'Hello, A440',
    description: 'A single sine wave at 440 Hz',
    make: () =>
      makeDoc('Hello, A440', [
        '// x is time in seconds; y is the speaker position, from −1 to 1',
        '// 440 Hz is concert A',
        'f = 440',
        'y = 0.5sin(2πfx)',
      ]),
  },
  {
    name: 'A major chord',
    description: 'Three sines in just intonation',
    make: () =>
      makeDoc('A major chord', [
        '// a chord is a sum of sines',
        '// frequency ratios 1 : 5/4 : 3/2 form a just major triad',
        'f = 220',
        'y = 0.3sin(2πfx)',
        'y = 0.3sin(2π·(5/4)fx)',
        'y = 0.3sin(2π·(3/2)fx)',
      ]),
  },
  {
    name: 'Beating',
    description: 'Two tones 3 Hz apart',
    make: () =>
      makeDoc(
        'Beating',
        [
          '// two tones, slightly detuned',
          '// their sum pulses d times a second',
          'd = 3',
          'y = 0.3(sin(2π·440x) + sin(2π(440 + d)x))',
        ],
        { view: { x0: 0, x1: 2, y0: -1.25, y1: 1.25 } },
      ),
  },
  {
    name: 'Drum beat',
    description: 'Kick, snare and hi-hat at 120 bpm',
    make: () =>
      makeDoc(
        'Drum beat',
        [
          '// tempo in bpm, and the length of one beat in seconds',
          'B = 120',
          'b = 60/B',
          '// each drum is a function of s, the time since its hit',
          'k(s) = sin(2π(45s + 6(1 - e^{-25s})))·e^{-7s}',
          'n(s) = 2mod(sin(78233s)·43758.5453, 1) - 1',
          'S(s) = (0.6n(s) + 0.5sin(2π·185s))·e^{-18s}',
          'h(s) = n(s)·e^{-80s}',
          '// kick on every beat, snare on 2 and 4, hi-hat on the off-beats',
          'y = 0.8k(mod(x, b))',
          'y = 0.45S(mod(x - b, 2b))',
          'y = 0.2h(mod(x - b/2, b))',
        ],
        { loop: 4, view: { x0: 0, x1: 2, y0: -1.25, y1: 1.25 } },
      ),
  },
  {
    name: 'Arpeggio',
    description: 'A melody read from a list',
    make: () =>
      makeDoc(
        'Arpeggio',
        [
          '// the notes, in semitones above A',
          'N = [0, 4, 7, 12, 16, 12, 7, 4]',
          'r = 0.15',
          '// the note sounding at time x',
          'p(x) = N[mod(floor(x/r), length(N)) + 1]',
          '// equal temperament: one semitone is a factor of 2^(1/12)',
          'f(x) = 220·2^{p(x)/12}',
          'y = 0.4sin(2πf(x)·mod(x, r))·e^{-9mod(x, r)}',
        ],
        { loop: 2.4, view: { x0: 0, x1: 1.2, y0: -1.25, y1: 1.25 } },
      ),
  },
  {
    name: 'FM bell',
    description: 'Frequency modulation with a fading index',
    make: () =>
      makeDoc(
        'FM bell',
        [
          '// frequency modulation; I sets the brightness',
          'I = 4',
          'g(s) = sin(2π·300s + I·e^{-s}sin(2π·420s))·e^{-2.5s}',
          'y = 0.4g(mod(x, 2))',
        ],
        { loop: 4, view: { x0: 0, x1: 0.05, y0: -1.25, y1: 1.25 } },
      ),
  },
  {
    name: 'Blank',
    description: 'An empty graph',
    make: () => makeDoc('Untitled', ['']),
  },
];
