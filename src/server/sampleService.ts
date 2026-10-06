// 샘플 예배: 찬양 3곡 + 대표기도 + 설교
// 카메라 배치 (예시)
//   CAM1 정면 와이드(FS7)   CAM2 강대상 CU(a7IV)   CAM3 찬양팀 좌측(S5IIX)
//   CAM4 밴드/드럼(S1II)   CAM5 회중 뒤 와이드(Z6)  CAM6 피아노 핸드헬드(Pocket)
import type { ServiceInput } from '../shared/schema';

type CueSeed = ServiceInput['acts'][number]['cues'][number];
const c = (camera: number, shotSize: CueSeed['shotSize'], note: string, extra: Partial<CueSeed> = {}): CueSeed => ({
  camera,
  shotSize,
  note,
  durationSec: null,
  section: null,
  bars: null,
  tcInSec: null,
  atemAction: 'cut',
  ...extra,
});

export const SAMPLE_SERVICE_TITLE = '샘플 주일 2부 예배';

export const sampleServiceInput: ServiceInput = {
  title: SAMPLE_SERVICE_TITLE,
  date: '2026-10-11',
  acts: [
    {
      title: '찬양 1 · 오프닝 (빠른 곡)',
      mode: 'SECTION',
      bpm: 128,
      beatsPerBar: 4,
      cues: [
        c(5, 'WS', '회중 뒤 와이드로 오픈, 조명 인', { section: 'INTRO', bars: 8, atemAction: 'auto' }),
        c(4, 'MS', '드럼 필인', { section: 'INTRO', bars: 4 }),
        c(3, 'MS', '인도자 단독', { section: 'V1', bars: 8 }),
        c(1, 'WS', '찬양팀 전체', { section: 'V1', bars: 8 }),
        c(6, 'CU', '건반 손', { section: 'PRE', bars: 4 }),
        c(3, 'CU', '인도자 얼굴 — 고음 직전', { section: 'PRE', bars: 4 }),
        c(1, 'WS', '후렴 진입 와이드', { section: 'CH', bars: 8 }),
        c(5, 'WS', '회중 손 든 모습', { section: 'CH', bars: 8, atemAction: 'auto' }),
        c(3, 'MS', '엔딩 인도자', { section: 'OUTRO', bars: 4 }),
        c(1, 'WS', '마무리 와이드 (페이드 대기)', { section: 'OUTRO', bars: 4, atemAction: 'auto' }),
      ],
    },
    {
      title: '찬양 2 · 경배 (느린 곡)',
      mode: 'SECTION',
      bpm: 72,
      beatsPerBar: 4,
      cues: [
        c(6, 'CU', '피아노 인트로', { section: 'INTRO', bars: 4, atemAction: 'auto' }),
        c(3, 'CU', '인도자', { section: 'V1', bars: 8, atemAction: 'auto' }),
        c(2, 'MS', '싱어 2 (강대상 쪽)', { section: 'V1', bars: 8, atemAction: 'auto' }),
        c(1, 'WS', '후렴 와이드', { section: 'CH', bars: 8, atemAction: 'auto' }),
        c(3, 'ECU', '인도자 눈 감은 클로즈업', { section: 'CH', bars: 8, atemAction: 'auto' }),
        c(5, 'WS', '회중 — 브릿지 반복', { section: 'BR', bars: 8, atemAction: 'auto' }),
        c(1, 'WS', '마지막 후렴', { section: 'OUTRO', bars: 8, atemAction: 'auto' }),
      ],
    },
    {
      title: '찬양 3 · 결단 (수동 진행)',
      mode: 'MANUAL',
      bpm: null,
      beatsPerBar: 4,
      cues: [
        c(1, 'WS', '찬양팀 전체 — 인도자 멘트 길이 유동적', { durationSec: 40 }),
        c(3, 'MS', '인도자'),
        c(5, 'WS', '회중'),
        c(1, 'WS', '찬양 종료 와이드', { atemAction: 'auto' }),
      ],
    },
    {
      title: '대표기도',
      mode: 'MANUAL',
      bpm: null,
      beatsPerBar: 4,
      cues: [
        c(2, 'MS', '기도자 등단 — 자막 ON (DSK1)', { atemAction: 'dsk:1:on' }),
        c(2, 'MS', '기도 시작 — 자막 OFF', { atemAction: 'dsk:1:off', durationSec: 180 }),
        c(5, 'WS', '아멘 후 회중 와이드', { atemAction: 'auto' }),
      ],
    },
    {
      title: '설교',
      mode: 'TIMECODE',
      bpm: null,
      beatsPerBar: 4,
      cues: [
        c(1, 'WS', '설교자 등단 와이드', { durationSec: 15, atemAction: 'auto' }),
        c(2, 'MS', '설교 본문 — 성경 자막 매크로', { durationSec: 45, atemAction: 'macro:1' }),
        c(2, 'MS', '설교자 MS 유지', { durationSec: 300 }),
        c(5, 'WS', '회중 리액션', { durationSec: 20 }),
        c(2, 'CU', '핵심 메시지 CU', { durationSec: 240 }),
        c(1, 'WS', '결론 — 와이드', { tcInSec: 900, atemAction: 'auto' }),
      ],
    },
  ],
};
