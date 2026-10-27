// 도메인 모델 (서버·클라이언트 공용)

/**
 * 샷 크기 (넓은 것 → 좁은 것, 마지막 2S 는 인원 기준).
 * WS 는 v0.0.6 까지의 의미(와이드) 그대로 — 국내 방송의 "웨이스트샷"과 헷갈리지 않도록 화면에는 한글을 같이 쓴다.
 */
export const SHOT_SIZES = ['LS', 'WS', 'FS', 'KS', 'MS', 'BS', 'CU', 'ECU', '2S'] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];

export const ADVANCE_MODES = ['MANUAL', 'SECTION', 'TIMECODE'] as const;
export type AdvanceMode = (typeof ADVANCE_MODES)[number];

/** 에디터에서 제안하는 섹션 프리셋. 값 자체는 영문 대문자로 시작하는 대문자·숫자·-·_ 1~12자면 허용 (예: INTRO-A, V2-DB) */
export const SECTION_PRESETS = ['INTRO', 'V1', 'V2', 'V3', 'PRE', 'CH', 'BR', 'INST', 'TAG', 'OUTRO'] as const;
export const SECTION_PATTERN = /^[A-Z][A-Z0-9_-]{0,11}$/;

export const MIN_CAMERA = 1;
export const MAX_CAMERA = 8;

export interface Cue {
  id: string;
  camera: number;
  shotSize: ShotSize;
  note: string;
  /** 큐 길이(초). MANUAL에서는 참고용, TIMECODE에서는 tcInSec 누적 계산에 사용 */
  durationSec: number | null;
  section: string | null;
  /** SECTION 모드에서 이 큐가 유지되는 마디 수 */
  bars: number | null;
  /** TIMECODE 모드: Act 시작 기준 진입 시각(초). null이면 앞 큐들의 durationSec 누적값 */
  tcInSec: number | null;
  /** cut | auto | macro:n | dsk:n:on | dsk:n:off */
  atemAction: string;
}

export interface Act {
  id: string;
  title: string;
  mode: AdvanceMode;
  bpm: number | null;
  beatsPerBar: number;
  cues: Cue[];
}

export interface Service {
  id: string;
  title: string;
  date: string | null;
  acts: Act[];
  /** 마지막 저장 시각(ISO). 에디터가 저장할 때 "그 사이 다른 곳에서 저장했는지" 확인용 */
  updatedAt?: string;
}

export interface ServiceSummary {
  id: string;
  title: string;
  date: string | null;
  actCount: number;
  cueCount: number;
  updatedAt: string;
}
