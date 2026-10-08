// 도메인 모델 (서버·클라이언트 공용)

export const SHOT_SIZES = ['WS', 'MS', 'CU', 'ECU'] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];

export const ADVANCE_MODES = ['MANUAL', 'SECTION', 'TIMECODE'] as const;
export type AdvanceMode = (typeof ADVANCE_MODES)[number];

/** 에디터에서 제안하는 섹션 프리셋. 값 자체는 대문자/숫자 1~8자면 허용한다. */
export const SECTION_PRESETS = ['INTRO', 'V1', 'V2', 'V3', 'PRE', 'CH', 'BR', 'INST', 'TAG', 'OUTRO'] as const;
export const SECTION_PATTERN = /^[A-Z][A-Z0-9]{0,7}$/;

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
}

export interface ServiceSummary {
  id: string;
  title: string;
  date: string | null;
  actCount: number;
  cueCount: number;
  updatedAt: string;
}
