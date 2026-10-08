import { describe, expect, it } from 'vitest';
import { formatAtemAction, parseAtemAction } from '../src/shared/atemAction';

describe('parseAtemAction', () => {
  it.each([
    ['cut', { kind: 'cut' }],
    ['AUTO', { kind: 'auto' }],
    ['macro:3', { kind: 'macro', index: 3 }],
    ['dsk:1:on', { kind: 'dsk', keyer: 1, onAir: true }],
    ['dsk:2:off', { kind: 'dsk', keyer: 2, onAir: false }],
  ])('%s', (raw, expected) => {
    expect(parseAtemAction(raw)).toEqual(expected);
  });

  it.each(['', 'cutt', 'macro:0', 'macro:x', 'dsk:1', 'dsk:0:on', 'dsk:1:maybe'])('잘못된 값 거부: %s', (raw) => {
    expect(parseAtemAction(raw)).toBeNull();
  });

  it('format 왕복', () => {
    for (const s of ['cut', 'auto', 'macro:12', 'dsk:2:on', 'dsk:1:off']) {
      expect(formatAtemAction(parseAtemAction(s)!)).toBe(s);
    }
  });
});
