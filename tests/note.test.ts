import { describe, expect, it } from 'vitest';
import { parseNote, setImportant } from '../src/shared/note';

describe('메모 중요 표시', () => {
  it('맨 앞 ! 로 중요 여부 판단', () => {
    expect(parseNote('!고음 직전 줌')).toEqual({ important: true, text: '고음 직전 줌' });
    expect(parseNote('  ! 공백 허용')).toEqual({ important: true, text: '공백 허용' });
    expect(parseNote('보통 메모!')).toEqual({ important: false, text: '보통 메모!' });
    expect(parseNote('')).toEqual({ important: false, text: '' });
  });
  it('켜고 끄기 (중복 표시 없음)', () => {
    expect(setImportant('줌 준비', true)).toBe('!줌 준비');
    expect(setImportant('!줌 준비', true)).toBe('!줌 준비');
    expect(setImportant('!줌 준비', false)).toBe('줌 준비');
  });
});
