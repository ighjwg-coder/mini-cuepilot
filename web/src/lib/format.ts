import type { ShotSize } from '@shared/types';

export const CAMERA_COLORS: Record<number, string> = {
  1: '#3b82f6',
  2: '#22c55e',
  3: '#eab308',
  4: '#a855f7',
  5: '#06b6d4',
  6: '#f97316',
  7: '#ec4899',
  8: '#94a3b8',
};

export const cameraColor = (n: number) => CAMERA_COLORS[n] ?? '#94a3b8';

export const SHOT_LABEL: Record<ShotSize, string> = {
  WS: '와이드',
  MS: '미디엄',
  CU: '클로즈업',
  ECU: '익스트림 CU',
};

export const MODE_LABEL = { MANUAL: '수동', SECTION: '섹션', TIMECODE: '타임코드' } as const;

/** ms → "m:ss" (음수는 0) */
export function formatClock(ms: number | null | undefined): string {
  if (ms == null) return '--:--';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 초 → "mm:ss.s" 타임코드 표시 */
export function formatTimecode(sec: number | null | undefined): string {
  if (sec == null) return '--:--.-';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
