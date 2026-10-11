import { describe, expect, it } from 'vitest';
import { decodeDoc, encodeDoc, makeDoc } from '../src/state';

describe('share links', () => {
  it('round-trip track styles, sliders and visibility', async () => {
    const doc = makeDoc('Test', ['a = 3', 'y = sin(ax)', 'y = x']);
    Object.assign(doc.items[0], { min: 0, max: 10, step: 0.1 });
    Object.assign(doc.items[1], { opacity: 0.5, width: 3, dash: 'dotted', muted: true });
    const back = await decodeDoc(await encodeDoc(doc));
    expect(back.items[0]).toMatchObject({ min: 0, max: 10, step: 0.1 });
    expect(back.items[0].opacity).toBeUndefined();
    expect(back.items[1]).toMatchObject({ opacity: 0.5, width: 3, dash: 'dotted', muted: true });
    expect(back.items[1].min).toBeUndefined();
    expect(back.items[2]).toMatchObject({ text: 'y = x', muted: false });
    expect(back.items[2].dash).toBeUndefined();
  });

  it('still reads links made before styles existed', async () => {
    const legacy = { v: 1, t: 'Old', m: 0.5, l: 0, w: [0, 1, -1, 1], i: [['b = 2', '#fff', 0, 1, 0, 10, 0.01], ['y = x', '#000', 1, 1]] };
    const bytes = new TextEncoder().encode(JSON.stringify(legacy));
    const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const encoded = btoa(String.fromCharCode(...packed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const doc = await decodeDoc(encoded);
    expect(doc.items[0]).toMatchObject({ text: 'b = 2', min: 0, max: 10, step: 0.01 });
    expect(doc.items[1]).toMatchObject({ text: 'y = x', muted: true });
  });
});
