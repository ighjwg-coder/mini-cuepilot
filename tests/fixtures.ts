import type { Act, Cue, Service } from '../src/shared/types';

let seq = 0;

export function cue(partial: Partial<Cue> & { camera: number }): Cue {
  seq += 1;
  return {
    id: partial.id ?? `cue-${seq}`,
    shotSize: 'MS',
    note: '',
    durationSec: null,
    section: null,
    bars: null,
    tcInSec: null,
    atemAction: 'cut',
    ...partial,
  };
}

export function act(partial: Partial<Act> & { id: string; cues: Cue[] }): Act {
  return { title: partial.id, mode: 'MANUAL', bpm: null, beatsPerBar: 4, ...partial };
}

/**
 * 테스트용 행사
 *  0. 공연 (SECTION, 120BPM 4/4 → 1마디 = 2000ms)
 *     V1: c1(2마디) → c2(2마디) | CH: c3(4마디) → c1(4마디, auto 트랜지션)
 *  1. 인사말 (MANUAL): c2(30s) → c3
 *  2. 광고 (빈 Act)
 *  3. 강연 (TIMECODE): c1 @0s(10s) → c2 @10s(20s) → c3 @45s(tcInSec)
 */
export function sampleService(): Service {
  return {
    id: 'svc',
    title: '테스트 행사',
    date: '2026-10-11',
    acts: [
      act({
        id: 'worship',
        mode: 'SECTION',
        bpm: 120,
        cues: [
          cue({ id: 'w-v1-a', camera: 1, section: 'V1', bars: 2 }),
          cue({ id: 'w-v1-b', camera: 2, section: 'V1', bars: 2 }),
          cue({ id: 'w-ch-a', camera: 3, section: 'CH', bars: 4 }),
          cue({ id: 'w-ch-b', camera: 1, section: 'CH', bars: 4, atemAction: 'auto' }),
        ],
      }),
      act({
        id: 'prayer',
        cues: [cue({ id: 'p-1', camera: 2, durationSec: 30 }), cue({ id: 'p-2', camera: 3 })],
      }),
      act({ id: 'notice', cues: [] }),
      act({
        id: 'sermon',
        mode: 'TIMECODE',
        cues: [
          cue({ id: 's-1', camera: 1, durationSec: 10 }),
          cue({ id: 's-2', camera: 2, durationSec: 20 }),
          cue({ id: 's-3', camera: 3, tcInSec: 45, atemAction: 'dsk:1:on' }),
        ],
      }),
    ],
  };
}
