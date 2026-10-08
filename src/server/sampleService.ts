// 샘플 행사: 공연 3곡 + 인사말 + 메인 강연
// 카메라 배치 (예시)
//   CAM1 정면 와이드        CAM2 연단 CU            CAM3 무대 좌측
//   CAM4 밴드/드럼          CAM5 객석 뒤 와이드      CAM6 건반 핸드헬드
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

export const SAMPLE_SERVICE_TITLE = '샘플 행사 (공연 + 강연)';

export const sampleServiceInput: ServiceInput = {
  title: SAMPLE_SERVICE_TITLE,
  date: '2026-10-11',
  acts: [
    {
      title: '오프닝 공연 1곡 (빠른 곡)',
      mode: 'SECTION',
      bpm: 128,
      beatsPerBar: 4,
      cues: [
        c(5, 'WS', '객석 뒤 와이드로 오픈, 조명 인', { section: 'INTRO', bars: 8, atemAction: 'auto' }),
        c(4, 'MS', '드럼 필인', { section: 'INTRO', bars: 4 }),
        c(3, 'MS', '메인 보컬 단독', { section: 'V1', bars: 8 }),
        c(1, 'WS', '무대 전체', { section: 'V1', bars: 8 }),
        c(6, 'CU', '건반 손', { section: 'PRE', bars: 4 }),
        c(3, 'CU', '메인 보컬 얼굴 — 고음 직전', { section: 'PRE', bars: 4 }),
        c(1, 'WS', '후렴 진입 와이드', { section: 'CH', bars: 8 }),
        c(5, 'WS', '객석 반응', { section: 'CH', bars: 8, atemAction: 'auto' }),
        c(3, 'MS', '엔딩 메인 보컬', { section: 'OUTRO', bars: 4 }),
        c(1, 'WS', '마무리 와이드 (페이드 대기)', { section: 'OUTRO', bars: 4, atemAction: 'auto' }),
      ],
    },
    {
      title: '공연 2곡 (느린 곡)',
      mode: 'SECTION',
      bpm: 72,
      beatsPerBar: 4,
      cues: [
        c(6, 'CU', '피아노 인트로', { section: 'INTRO', bars: 4, atemAction: 'auto' }),
        c(3, 'CU', '메인 보컬', { section: 'V1', bars: 8, atemAction: 'auto' }),
        c(2, 'MS', '서브 보컬 (무대 오른쪽)', { section: 'V1', bars: 8, atemAction: 'auto' }),
        c(1, 'WS', '후렴 와이드', { section: 'CH', bars: 8, atemAction: 'auto' }),
        c(3, 'ECU', '메인 보컬 익스트림 클로즈업', { section: 'CH', bars: 8, atemAction: 'auto' }),
        c(5, 'WS', '객석 — 브릿지 반복', { section: 'BR', bars: 8, atemAction: 'auto' }),
        c(1, 'WS', '마지막 후렴', { section: 'OUTRO', bars: 8, atemAction: 'auto' }),
      ],
    },
    {
      title: '공연 3곡 (수동 진행)',
      mode: 'MANUAL',
      bpm: null,
      beatsPerBar: 4,
      cues: [
        c(1, 'WS', '무대 전체 — 보컬 멘트 길이 유동적', { durationSec: 40 }),
        c(3, 'MS', '메인 보컬'),
        c(5, 'WS', '객석'),
        c(1, 'WS', '공연 종료 와이드', { atemAction: 'auto' }),
      ],
    },
    {
      title: '인사말',
      mode: 'MANUAL',
      bpm: null,
      beatsPerBar: 4,
      cues: [
        c(2, 'MS', '연사 등단 — 이름 자막 ON (DSK1)', { atemAction: 'dsk:1:on' }),
        c(2, 'MS', '인사 시작 — 자막 OFF', { atemAction: 'dsk:1:off', durationSec: 180 }),
        c(5, 'WS', '박수 — 객석 와이드', { atemAction: 'auto' }),
      ],
    },
    {
      title: '메인 강연',
      mode: 'TIMECODE',
      bpm: null,
      beatsPerBar: 4,
      cues: [
        c(1, 'WS', '강연자 등단 와이드', { durationSec: 15, atemAction: 'auto' }),
        c(2, 'MS', '강연 주제 — 타이틀 자막 매크로', { durationSec: 45, atemAction: 'macro:1' }),
        c(2, 'MS', '강연자 MS 유지', { durationSec: 300 }),
        c(5, 'WS', '객석 리액션', { durationSec: 20 }),
        c(2, 'CU', '핵심 메시지 CU', { durationSec: 240 }),
        c(1, 'WS', '결론 — 와이드', { tcInSec: 900, atemAction: 'auto' }),
      ],
    },
  ],
};
