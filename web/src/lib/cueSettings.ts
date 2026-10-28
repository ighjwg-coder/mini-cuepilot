// 카메라맨 화면(CueScreen) 설정 — 폰마다 따로 저장 (localStorage)
export type VibrateMode = 'off' | 'warn' | 'all';
export type Orientation = 'auto' | 'portrait' | 'landscape';
/** cue: 샷·메모·카운트다운이 있는 큐 화면 / tally: 탈리 색만 크게 보여 주는 단순 탈리 */
export type CueView = 'cue' | 'tally';

export interface CueSettings {
  /** off: 진동 없음 / warn: 3초 전 예고만 / all: 예고 + ON AIR 순간 */
  vibrate: VibrateMode;
  /** 화면 밝기 % (CSS 밝기 필터) */
  brightness: number;
  /** ON AIR 띠 깜빡임 */
  blink: boolean;
  /** 화면 방향 (앱에서만 적용) */
  orientation: Orientation;
  /** 화면 모드 */
  view: CueView;
}

const KEY = 'camcue.cueScreen.v1';

export const DEFAULT_CUE_SETTINGS: CueSettings = { vibrate: 'warn', brightness: 100, blink: true, orientation: 'auto', view: 'cue' };

export function loadCueSettings(): CueSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CueSettings> | null;
    if (!raw || typeof raw !== 'object') return DEFAULT_CUE_SETTINGS;
    return {
      vibrate: raw.vibrate === 'off' || raw.vibrate === 'all' ? raw.vibrate : 'warn',
      brightness: typeof raw.brightness === 'number' && raw.brightness >= 10 && raw.brightness <= 100 ? raw.brightness : 100,
      blink: raw.blink !== false,
      orientation: raw.orientation === 'portrait' || raw.orientation === 'landscape' ? raw.orientation : 'auto',
      view: raw.view === 'tally' ? 'tally' : 'cue',
    };
  } catch {
    return DEFAULT_CUE_SETTINGS;
  }
}

export function saveCueSettings(s: CueSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 사생활 보호 모드 등 — 저장 못 해도 화면은 동작
  }
}
