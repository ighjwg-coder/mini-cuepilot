import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { formatZodError, parseImport } from '../src/shared/schema';

const wrap = (section: string) => ({
  format: 'camcue/service@1',
  service: {
    title: '콘서트',
    acts: [{ title: '곡', mode: 'SECTION', bpm: 89, cues: [{ camera: 1, shotSize: 'WS', section, bars: 1 }] }],
  },
});

describe('JSON 가져오기', () => {
  it('하이픈·밑줄이 들어간 섹션 이름 허용 (INTRO-A, V2-DB, LIGHT-IN)', () => {
    for (const s of ['INTRO-A', 'v2-db', 'LIGHT-IN', 'CH_2', 'OUTRO']) {
      expect(parseImport(wrap(s)).acts[0].cues[0].section).toBe(s.toUpperCase());
    }
  });

  it('잘못된 섹션은 실제 위치가 오류에 나옴 (엉뚱한 "title 없음" 대신)', () => {
    let err: unknown;
    try {
      parseImport(wrap('1인트로'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ZodError);
    const msg = formatZodError(err as ZodError);
    expect(msg).toContain('service.acts.0.cues.0.section');
    expect(msg).not.toMatch(/^title/);
  });

  it('행사 객체 단독도 계속 허용', () => {
    expect(parseImport({ title: '단독', acts: [] }).title).toBe('단독');
  });
});
